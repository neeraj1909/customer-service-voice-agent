const SPOKEN_DIGITS = {zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9'};

function normalizeOrderId(value) {
  const words = value.trim().toLowerCase().replace(/\bdash\b/g, '-');
  const compact = /^ord[\s-]*([ab])[\s-]*(\d{1,3})$/.exec(words);
  if (compact) return `ord-${compact[1]}-${compact[2]}`;
  const tokens = words.match(/[a-z]+|\d+|-/g);
  if (!tokens || words.replace(/[a-z\d\s-]/g, '')) return words;
  const parts = tokens.filter(token => token !== '-');
  if (parts[0] === 'o' && parts[1] === 'r' && parts[2] === 'd') parts.splice(0, 3, 'ord');
  if (parts[0] !== 'ord' || !/^[ab]$/.test(parts[1] ?? '') || parts.length < 3) return words;
  const digits = parts.slice(2).map(part => SPOKEN_DIGITS[part] ?? (/^\d+$/.test(part) ? part : '?')).join('');
  return /^\d{1,3}$/.test(digits) ? `ord-${parts[1]}-${digits}` : words;
}

// Browser-side WebRTC voice transport. The server supplies the SDP answer;
// provider credentials remain on the server. Only read-only tools are exposed.
export class RealtimeVoice {
  constructor({session, request, audio, language = 'auto', status = () => {}, event = () => {}, ended = () => {}, paused = () => {},
    media = globalThis.navigator?.mediaDevices, Peer = globalThis.RTCPeerConnection,
    fetchImpl = globalThis.fetch?.bind(globalThis)} = {}) {
    Object.assign(this, {session, request, audio, language, status, event, ended, paused, media, Peer, fetchImpl});
    this.generation = 0;
    this.callId = null;
    this.pendingStart = null;
    this.peer = null;
    this.stream = null;
    this.channel = null;
    this.seenCalls = new Set();
    this.stopPromise = null;
    this.turn = 0;
    this.approvedTurn = null;
    this.itemTurns = new Map();
    this.interruptedItems = new Set();
    this.uncheckedItems = new Set();
    this.lastApproved = '';
    this.deletions = new Map();
    this.history = [];
    this.outputTranscripts = new Map();
    this.idleTimer = null;
    this.idleDeadline = null;
    this.isPaused = false;
    this.microphoneMuted = false;
    this.idleMs = 30000;
    this.userActive = false;
    this.assistantActive = false;
    this.endRequested = false;
  }

  start() {
    if (this.pendingStart) return Promise.reject(new Error('Voice is already starting or active.'));
    const pending = this.startCall();
    this.pendingStart = pending;
    return pending.finally(() => { if (this.pendingStart === pending) this.pendingStart = null; });
  }

  async startCall() {
    if (this.peer || this.stream || this.starting) throw new Error('Voice is already starting or active.');
    if (!this.session) throw new Error('Start a fictional customer session first.');
    if (!this.media?.getUserMedia || !this.Peer || !this.fetchImpl) throw new Error('Microphone or WebRTC is unavailable in this browser.');
    const generation = ++this.generation;
    this.starting = true;
    this.status('Connecting; allow microphone access when prompted.');
    try {
      const stream = await this.media.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true}, video: false});
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return false; }
      this.stream = stream;
      stream.getAudioTracks().forEach(track => { track.enabled = false; });
      const peer = new this.Peer();
      this.peer = peer;
      const channel = peer.createDataChannel('oai-events');
      this.channel = channel;
      channel.onopen = () => {
        if (generation !== this.generation) return;
        const names = {en:'English', hi:'Hindi', hinglish:'Hinglish'};
        if (Object.hasOwn(names, this.language)) channel.send(JSON.stringify({type:'conversation.item.create', item:{type:'message', role:'user', content:[{type:'input_text', text:`For this call, please reply in ${names[this.language]}.`}]}}));
        for (const entry of this.history) channel.send(JSON.stringify({type:'conversation.item.create', item:{type:'message', role:entry.role, content:[{type:entry.role === 'user' ? 'input_text' : 'output_text', text:entry.text}]}}));
        stream.getAudioTracks().forEach(track => { track.enabled = !this.microphoneMuted && !this.isPaused; });
      };
      channel.onmessage = ({data}) => {
        if (generation !== this.generation) return;
        try { void this.receive(JSON.parse(data), generation).catch(() => this.status('Voice tool response failed.')); } catch { /* discard malformed provider events */ }
      };
      channel.onerror = () => this.status('Voice event channel failed. End the call and try again.');
      peer.ontrack = ({streams}) => {
        if (generation !== this.generation || !streams?.[0]) return;
        this.audio.srcObject = streams[0];
        Promise.resolve(this.audio.play()).catch(() => this.status('Playback blocked; use the audio controls.'));
      };
      peer.onconnectionstatechange = () => {
        if (generation !== this.generation) return;
        if (peer.connectionState === 'connected') { this.status('Connected. Speak to the assistant.'); this.armIdle(); }
        if (peer.connectionState === 'failed') {
          this.status('Voice connection failed. Closing the call.');
          void this.stop(true).then(() => {
            if (this.endRequested) return;
            this.isPaused = true;
            this.status('Voice connection interrupted. Select Resume to continue this session.');
            this.paused(true);
          }).catch(() => {
            if (this.endRequested) return;
            this.isPaused = true;
            this.status('Could not confirm the previous connection ended. Select Resume to retry.');
            this.paused(true);
            this.ended(false);
          });
        }
        if (peer.connectionState === 'disconnected') this.status('Voice connection interrupted; waiting for it to recover.');
      };
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (peer.iceGatheringState && peer.iceGatheringState !== 'complete') {
        await new Promise(resolve => {
          const done = () => { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', check); resolve(); };
          const check = () => { if (peer.iceGatheringState === 'complete') done(); };
          const timer = setTimeout(done, 4000);
          peer.addEventListener('icegatheringstatechange', check);
          check();
        });
      }
      if (generation !== this.generation) return false;
      const response = await this.fetchImpl('/api/realtime/call', {
        method: 'POST', headers: {'Content-Type': 'application/sdp', 'X-Session': this.session},
        body: peer.localDescription?.sdp ?? offer.sdp,
      });
      const callId = response.headers.get('X-Call-ID');
      if (callId) this.callId = callId;
      if (generation !== this.generation) return false;
      if (!response.ok) throw new Error(response.status === 429 ?
        'The demo has reached its two-call limit. End another call or wait for cleanup, then try again.' :
        `Voice service unavailable (${response.status}).`);
      if (!callId) throw new Error('Voice service did not identify the call.');
      const answer = await response.text();
      if (generation !== this.generation) return false;
      if (!answer.trim()) throw new Error('Voice service returned an empty answer.');
      await peer.setRemoteDescription({type: 'answer', sdp: answer});
      if (generation !== this.generation) return false;
      return true;
    } catch (error) {
      if (generation === this.generation) { this.closeLocal(); await this.endServerCall(); }
      throw error;
    } finally {
      if (generation === this.generation) this.starting = false;
    }
  }

  async receive(data, generation = this.generation) {
    if (!data || typeof data.type !== 'string') return;
    if (data.type === 'input_audio_buffer.speech_started') {
      this.userActive = true;
      this.clearIdle();
      this.turn++;
      if (typeof data.item_id === 'string') {
        this.itemTurns.set(data.item_id, this.turn);
        if (this.assistantActive) this.interruptedItems.add(data.item_id);
        this.uncheckedItems.add(data.item_id);
      }
      this.status('Listening.');
    } else if (data.type === 'input_audio_buffer.speech_stopped') {
      this.status('Processing your request.');
      if (!this.uncheckedItems.size) { this.userActive = false; this.armIdle(); }
    } else if (data.type === 'error') this.status('The voice service reported an error. Try again or restart the call.');
    else if (data.type === 'response.done' && data.response?.status === 'incomplete' && data.response?.status_details?.reason === 'max_output_tokens') this.status('The answer reached its length limit. Ask Mira to continue.');
    else if (data.type === 'response.done' && data.response?.status === 'cancelled' && data.response?.status_details?.reason === 'turn_detected') this.status('Checking the interruption.');
    else if (data.type === 'output_audio_buffer.started' || data.type === 'response.output_audio_buffer.started') {
      this.status('Mira is responding.');
    }
    if (data.type === 'response.created' || data.type === 'output_audio_buffer.started' || data.type === 'response.output_audio_buffer.started') { this.assistantActive = true; this.clearIdle(); this.idleDeadline = null; }
    if (data.type === 'response.output_audio_transcript.done' && typeof data.response_id === 'string' && typeof data.transcript === 'string') this.outputTranscripts.set(data.response_id, data.transcript);
    if (data.type === 'output_audio_buffer.stopped') {
      this.assistantActive = false;
      const text = this.outputTranscripts.get(data.response_id);
      if (text) this.history.push({role:'assistant', text});
      this.outputTranscripts.delete(data.response_id);
      this.armIdle();
    }
    if (data.type === 'output_audio_buffer.cleared') { this.assistantActive = false; this.outputTranscripts.delete(data.response_id); }
    this.event(data);
    if (data.type === 'conversation.item.deleted') {
      this.deletions.get(data.item_id)?.(true);
      return;
    }
    if (data.type === 'conversation.item.input_audio_transcription.failed') {
      this.status('Could not understand that turn. Please try again.');
      await this.checkTurn({item_id:data.item_id, transcript:'', failed:true}, generation);
      return;
    }
    if (data.type === 'conversation.item.input_audio_transcription.completed') {
      await this.checkTurn(data, generation);
      return;
    }
    if (data.type !== 'response.function_call_arguments.done') return;
    if (this.approvedTurn !== this.turn) return;
    const {name, call_id: callId} = data;
    if (typeof callId !== 'string' || !callId || this.seenCalls.has(callId)) return;
    this.seenCalls.add(callId);
    this.status('Checking your request.');
    let output;
    try {
      const args = JSON.parse(data.arguments);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid_tool');
      if (name === 'list_orders' && Object.keys(args).length === 0) {
        output = await this.request('/api/orders', {});
      } else {
        const field = name === 'lookup_order' ? 'order_id' : name === 'list_appointment_slots' ? 'appointment_id' : null;
        if (!field || Object.keys(args).length !== 1 || typeof args[field] !== 'string') throw new Error('invalid_tool');
        let id = args[field].trim().toLowerCase();
        if (field === 'order_id') {
          id = normalizeOrderId(id);
        }
        if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new Error('invalid_tool');
        output = await this.request(field === 'order_id' ? '/api/order-details' : '/api/appointments/slots', {[field]: id});
      }
    } catch { output = {error: 'Tool request failed or was not permitted. No change was made.'}; }
    if (generation !== this.generation || this.approvedTurn !== this.turn || this.channel?.readyState !== 'open') return;
    this.channel.send(JSON.stringify({type: 'conversation.item.create', item: {type: 'function_call_output', call_id: callId, output: JSON.stringify(output)}}));
    this.channel.send(JSON.stringify({type: 'response.create'}));
    this.status('Preparing a response.');
  }

  async checkTurn({item_id: itemId, transcript, failed = false}, generation) {
    if (typeof itemId !== 'string' || !itemId || typeof transcript !== 'string') return;
    this.uncheckedItems.add(itemId);
    const turn = this.itemTurns.get(itemId) ?? this.turn;
    this.itemTurns.delete(itemId);
    const interrupted = this.interruptedItems.delete(itemId);
    let result;
    try {
      if (failed) throw new Error('transcription failed');
      this.status('Checking your request.');
      result = transcript.trim() ? await this.request('/api/realtime/scope', {transcript, context:this.lastApproved}) : {decision:'noise'};
    } catch { /* remove the original turn and fail closed */ }
    if (generation !== this.generation || this.channel?.readyState !== 'open') return;
    const deleted = new Promise(resolve => {
      const timer = setTimeout(() => { this.deletions.delete(itemId); resolve(false); }, 5000);
      this.deletions.set(itemId, value => { clearTimeout(timer); this.deletions.delete(itemId); resolve(value); });
    });
    this.channel.send(JSON.stringify({type:'conversation.item.delete', item_id:itemId}));
    const removed = await deleted;
    if (generation !== this.generation || this.channel?.readyState !== 'open') return;
    if (!removed) {
      this.status('Could not safely process the turn. Closing the call.');
      try { await this.stop(); this.ended(true); } catch { this.ended(false); }
      return;
    }
    this.uncheckedItems.delete(itemId);
    this.userActive = this.uncheckedItems.size > 0;
    if (turn !== this.turn) { this.armIdle(); return; }
    if (this.uncheckedItems.size) {
      this.status('Overlapping speech could not be checked safely. Please repeat your request.');
      return;
    }
    if (!result || !['allow', 'redirect', 'clarify', 'noise'].includes(result.decision) ||
        (result.decision === 'allow' && (typeof result.safe_text !== 'string' || !result.safe_text.trim()))) {
      this.status('The request could not be checked. Please try again.');
      this.armIdle();
      return;
    }
    if (result.decision === 'noise' && !interrupted) {
      this.status('Listening.');
      this.armIdle();
      return;
    }
    const messages = {
      redirect:'Please briefly explain that you can only help with this customer service demo, and ask how you can help with an order or appointment.',
      clarify:'Please ask me to clarify my customer service question.',
      noise:'A background sound interrupted your answer. Give one brief line of context about what you were discussing, then continue the answer using the conversation context. Keep the current language preference.',
    };
    const languages = {en:'English', hi:'Hindi', hinglish:'Hinglish'};
    const languageHint = result.decision !== 'noise' && Object.hasOwn(languages, result.language) ? ` The last utterance was in ${languages[result.language]}; respect any ongoing language preference, otherwise respond in that language.` : '';
    const text = result.decision === 'allow' ? result.safe_text : messages[result.decision] + languageHint;
    this.idleDeadline = null;
    if (result.decision === 'allow') { this.lastApproved = text; this.history.push({role:'user', text}); }
    this.approvedTurn = turn;
    this.channel.send(JSON.stringify({type:'conversation.item.create', item:{type:'message', role:'user', content:[{type:'input_text', text}]}}));
    this.channel.send(JSON.stringify({type:'response.create'}));
    this.status('Preparing a response.');
  }

  closeLocal() {
    this.clearIdle();
    this.idleDeadline = null;
    this.generation++;
    this.starting = false;
    if (this.channel) { this.channel.onmessage = null; this.channel.close(); this.channel = null; }
    if (this.peer) { this.peer.ontrack = null; this.peer.onconnectionstatechange = null; this.peer.close(); this.peer = null; }
    if (this.stream) { this.stream.getTracks().forEach(track => track.stop()); this.stream = null; }
    this.audio.pause();
    this.audio.srcObject = null;
    this.audio.muted = false;
    this.seenCalls.clear();
    for (const resolve of this.deletions.values()) resolve(false);
    this.approvedTurn = null;
    this.itemTurns.clear();
    this.interruptedItems.clear();
    this.uncheckedItems.clear();
    this.outputTranscripts.clear();
    this.userActive = false;
    this.assistantActive = false;
  }

  clearIdle() { clearTimeout(this.idleTimer); this.idleTimer = null; }

  pause() {
    if (!this.stream || this.isPaused) return false;
    this.clearIdle();
    this.idleDeadline = null;
    this.isPaused = true;
    this.stream.getAudioTracks().forEach(track => { track.enabled = false; });
    this.status('Microphone paused. Mira will finish any current response. Select Resume to continue.');
    this.paused(true);
    return true;
  }

  armIdle() {
    this.clearIdle();
    if (this.isPaused || !this.stream || this.userActive || this.assistantActive) return;
    this.idleDeadline ??= Date.now() + this.idleMs;
    this.idleTimer = setTimeout(() => {
      this.pause();
      this.status('Voice paused after 30 seconds of inactivity. Select Resume to continue.');
    }, Math.max(0, this.idleDeadline - Date.now()));
    this.idleTimer?.unref?.();
  }

  async restart() {
    if (!this.isPaused) return;
    if (this.peer && (['disconnected', 'failed', 'closed'].includes(this.peer.connectionState) || this.channel?.readyState !== 'open')) {
      throw new Error('The connection is still recovering. Please try Resume again.');
    }
    if (this.callId && !this.peer) await this.endServerCall();
    if (!this.peer) {
      this.isPaused = false;
      try { if (!await this.start() || this.endRequested) return; } catch (error) { if (!this.endRequested) this.isPaused = true; throw error; }
    } else {
      this.isPaused = false;
      this.stream?.getAudioTracks().forEach(track => { track.enabled = !this.microphoneMuted; });
      this.status('Voice resumed.');
      this.armIdle();
    }
    this.paused(false);
  }

  setMicrophoneMuted(muted) {
    if (!this.stream) return false;
    this.microphoneMuted = muted;
    this.stream.getAudioTracks().forEach(track => { track.enabled = !muted && !this.isPaused && this.channel?.readyState === 'open'; });
    return true;
  }

  async endServerCall() {
    if (!this.callId) return;
    const id = this.callId;
    const response = await this.fetchImpl(`/api/realtime/call/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: {'X-Session': this.session}, keepalive: true,
    });
    if (!response.ok) throw new Error('Could not confirm the server call ended. Try End again.');
    if (this.callId === id) this.callId = null;
  }

  stop(preserveHistory = false) {
    if (!preserveHistory) this.endRequested = true;
    if (this.stopPromise) return preserveHistory ? this.stopPromise : this.stopPromise.then(() => { this.history = []; this.lastApproved = ''; this.isPaused = false; });
    const stopping = (async () => {
      this.closeLocal();
      if (this.pendingStart) { try { await this.pendingStart; } catch { /* cleanup below */ } }
      await this.endServerCall();
      if (!preserveHistory) { this.history = []; this.lastApproved = ''; this.isPaused = false; }
    })();
    this.stopPromise = stopping;
    return stopping.finally(() => { if (this.stopPromise === stopping) this.stopPromise = null; });
  }
}
