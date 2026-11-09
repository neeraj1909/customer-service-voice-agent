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
  constructor({session, request, audio, language = 'auto', status = () => {}, event = () => {}, ended = () => {},
    media = globalThis.navigator?.mediaDevices, Peer = globalThis.RTCPeerConnection,
    fetchImpl = globalThis.fetch?.bind(globalThis)} = {}) {
    Object.assign(this, {session, request, audio, language, status, event, ended, media, Peer, fetchImpl});
    this.generation = 0;
    this.callId = null;
    this.pendingStart = null;
    this.peer = null;
    this.stream = null;
    this.channel = null;
    this.seenCalls = new Set();
    this.stopPromise = null;
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
      const peer = new this.Peer();
      this.peer = peer;
      const channel = peer.createDataChannel('oai-events');
      this.channel = channel;
      channel.onopen = () => {
        if (generation !== this.generation) return;
        const names = {en:'English', hi:'Hindi', hinglish:'Hinglish'};
        if (Object.hasOwn(names, this.language)) channel.send(JSON.stringify({type:'conversation.item.create', item:{type:'message', role:'user', content:[{type:'input_text', text:`For this call, please reply in ${names[this.language]}.`}]}}));
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
        if (peer.connectionState === 'connected') this.status('Connected. Speak to the assistant.');
        if (peer.connectionState === 'failed') {
          this.status('Voice connection failed. Closing the call.');
          void this.stop().then(() => {
            this.status('Voice connection failed. Start a new call to reconnect.');
            this.ended(true);
          }).catch(() => {
            this.status('Could not confirm the server call ended. Try End again.');
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
      this.status('Listening.');
    } else if (data.type === 'input_audio_buffer.speech_stopped') {
      this.status('Processing your request.');
    } else if (data.type === 'error') this.status('The voice service reported an error. Try again or restart the call.');
    else if (data.type === 'response.done' && data.response?.status === 'incomplete' && data.response?.status_details?.reason === 'max_output_tokens') this.status('The answer reached its length limit. Ask Mira to continue.');
    else if (data.type === 'response.done' && data.response?.status === 'cancelled' && data.response?.status_details?.reason === 'turn_detected') this.status('Mira heard a sound and stopped. Ask her to continue, or mute your microphone while she speaks.');
    else if (data.type === 'output_audio_buffer.started' || data.type === 'response.output_audio_buffer.started') {
      this.status('Mira is responding.');
    }
    this.event(data);
    if (data.type !== 'response.function_call_arguments.done') return;
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
    if (generation !== this.generation || this.channel?.readyState !== 'open') return;
    this.channel.send(JSON.stringify({type: 'conversation.item.create', item: {type: 'function_call_output', call_id: callId, output: JSON.stringify(output)}}));
    this.channel.send(JSON.stringify({type: 'response.create'}));
    this.status('Preparing a response.');
  }

  closeLocal() {
    this.generation++;
    this.starting = false;
    if (this.channel) { this.channel.onmessage = null; this.channel.close(); this.channel = null; }
    if (this.peer) { this.peer.ontrack = null; this.peer.onconnectionstatechange = null; this.peer.close(); this.peer = null; }
    if (this.stream) { this.stream.getTracks().forEach(track => track.stop()); this.stream = null; }
    this.audio.pause();
    this.audio.srcObject = null;
    this.audio.muted = false;
    this.seenCalls.clear();
  }

  setMicrophoneMuted(muted) {
    if (!this.stream) return false;
    this.stream.getAudioTracks().forEach(track => { track.enabled = !muted; });
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

  stop() {
    if (this.stopPromise) return this.stopPromise;
    const stopping = (async () => {
      this.closeLocal();
      if (this.pendingStart) { try { await this.pendingStart; } catch { /* cleanup below */ } }
      await this.endServerCall();
    })();
    this.stopPromise = stopping;
    return stopping.finally(() => { if (this.stopPromise === stopping) this.stopPromise = null; });
  }
}
