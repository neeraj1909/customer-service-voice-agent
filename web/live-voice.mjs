import { RealtimeVoice, normalizeOrderId } from './realtime-voice.mjs';

// Experimental full-duplex transport. Live speaks while checks run; it does not
// provide the baseline's transcript-first scope gate.
export class LiveVoice extends RealtimeVoice {
  constructor(options = {}) {
    super(options);
    this.responses = new Map();
    this.responseByDelegation = new Map();
    this.eventSequence = 0;
    this.inputRevision = 0;
  }

  async startCall() {
    if (this.peer || this.stream || this.starting) throw new Error('Voice is already starting or active.');
    if (!this.session) throw new Error('Start a fictional customer session first.');
    if (!this.media?.getUserMedia || !this.Peer || !this.fetchImpl) throw new Error('Microphone or WebRTC is unavailable in this browser.');
    const generation = ++this.generation;
    this.starting = true;
    this.status('Connecting experimental Live voice; allow microphone access.');
    try {
      const stream = await this.media.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true}, video:false});
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return false; }
      this.stream = stream;
      stream.getAudioTracks().forEach(track => { track.enabled = false; });
      const peer = this.peer = new this.Peer();
      const channel = this.channel = peer.createDataChannel('oai-events');
      channel.onmessage = ({data}) => {
        if (generation !== this.generation) return;
        try { void this.receive(JSON.parse(data), generation).catch(() => this.status('Live voice event failed.')); } catch { /* ignore malformed events */ }
      };
      channel.onerror = () => this.status('Live voice event channel failed. End the call and try again.');
      channel.onclose = () => { if (generation === this.generation) this.status('Live voice disconnected. End the call and try again.'); };
      peer.ontrack = ({streams}) => {
        if (generation !== this.generation || !streams?.[0]) return;
        this.audio.srcObject = streams[0];
        if (!this.isPaused) Promise.resolve(this.audio.play()).catch(() => { if (generation === this.generation && !this.isPaused) this.status('Playback blocked; use the audio controls.'); });
      };
      peer.onconnectionstatechange = () => {
        if (generation !== this.generation) return;
        if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') this.status('Live voice connection interrupted. End the call and try again.');
      };
      for (const track of stream.getAudioTracks()) this.audioSender = peer.addTrack(track, stream);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (peer.iceGatheringState && peer.iceGatheringState !== 'complete') {
        await new Promise((resolve, reject) => {
          const finish = error => { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', check); error ? reject(error) : resolve(); };
          const check = () => { if (peer.iceGatheringState === 'complete') finish(); };
          const timer = setTimeout(() => finish(new Error('Timed out while gathering network candidates.')), 10000);
          peer.addEventListener('icegatheringstatechange', check);
          check();
        });
      }
      if (generation !== this.generation) return false;
      const response = await this.fetchImpl('/api/live/call', {method:'POST', headers:{'Content-Type':'application/sdp', 'X-Session':this.session}, body:peer.localDescription?.sdp ?? offer.sdp});
      const callId = response.headers.get('X-Call-ID');
      if (callId) this.callId = callId;
      if (generation !== this.generation) return false;
      if (!response.ok) throw new Error(`Live voice service unavailable (${response.status}).`);
      if (!callId) throw new Error('Live voice service did not identify the call.');
      const answer = await response.text();
      if (generation !== this.generation) return false;
      if (!answer.trim()) throw new Error('Live voice service returned an empty answer.');
      await peer.setRemoteDescription({type:'answer', sdp:answer});
      return generation === this.generation;
    } catch (error) {
      if (generation === this.generation) {
        this.stream?.getTracks().forEach(track => track.stop());
        try { await this.endServerCall(); } finally { this.closeLocal(); }
      }
      throw error;
    } finally { if (generation === this.generation) this.starting = false; }
  }

  async receive(data, generation = this.generation) {
    if (!data || typeof data.type !== 'string') return;
    this.event(data);
    if (data.type === 'session.started') {
      this.stream?.getAudioTracks().forEach(track => { track.enabled = !this.endRequested && !this.microphoneMuted && !this.isPaused; });
      if (this.endRequested) return;
      const names = {en:'English', hi:'Hindi', hinglish:'Hinglish'};
      if (Object.hasOwn(names, this.language)) this.send({type:'session.instructions.append', delegation_id:null, content:`For this call, reply in ${names[this.language]}.`});
      this.status('Connected to experimental Live voice. Speak to Mira.');
      this.armIdle();
    } else if (data.type === 'session.closed') {
      this.closeLocal();
      this.status('Live session closed. Select End call to confirm server cleanup.');
      this.ended(false);
    } else if (data.type === 'error') {
      this.status('The Live voice service reported an error.');
    } else if (data.type === 'session.input_transcript.delta' || data.type === 'session.output_transcript.delta') {
      if (data.type === 'session.input_transcript.delta') this.inputRevision++;
      this.idleDeadline = null;
      this.armIdle();
    }
    if (data.type !== 'response.event' || !data.event) return;
    const event = data.event;
    const delegationId = data.delegation_id;
    if (event.type === 'response.created' && typeof event.response?.id === 'string') {
      this.responseByDelegation.set(delegationId, event.response.id);
      this.responses.set(event.response.id, {calls:[], revision:this.inputRevision});
    }
    const responseId = event.response_id ?? event.response?.id ?? this.responseByDelegation.get(delegationId);
    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call' &&
        typeof event.item.call_id === 'string' && event.item.call_id && this.responses.has(responseId) &&
        !this.responses.get(responseId).calls.some(item => item.call_id === event.item.call_id)) {
      this.responses.get(responseId).calls.push(event.item);
    }
    if (event.type !== 'response.completed' || !this.responses.has(responseId)) return;
    const {calls, revision} = this.responses.get(responseId);
    this.responses.delete(responseId);
    this.responseByDelegation.delete(delegationId);
    if (!calls.length) return;
    this.status('Checking your request.');
    const outputs = revision === this.inputRevision ? await Promise.all(calls.map(item => this.runTool(item))) : [];
    if (generation !== this.generation || this.channel?.readyState !== 'open') return;
    for (let i = 0; i < calls.length; i++) {
      const output = revision === this.inputRevision ? outputs[i] : {error:'Request superseded by newer speech; do not use the earlier result.'};
      this.send({type:'response.item.create', item:{type:'function_call_output', call_id:calls[i].call_id, output:JSON.stringify(output)}});
    }
    this.send({type:'response.create'});
  }

  send(value) {
    if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify({...value, event_id:`mira_${++this.eventSequence}`}));
  }

  async runTool(item) {
    try {
      const args = JSON.parse(item.arguments);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid');
      if (item.name === 'list_orders' && Object.keys(args).length === 0) return await this.request('/api/orders', {});
      const field = item.name === 'lookup_order' ? 'order_id' : item.name === 'list_appointment_slots' ? 'appointment_id' : null;
      if (!field || Object.keys(args).length !== 1 || typeof args[field] !== 'string') throw new Error('invalid');
      const id = field === 'order_id' ? normalizeOrderId(args[field]) : args[field].trim().toLowerCase();
      if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new Error('invalid');
      return await this.request(field === 'order_id' ? '/api/order-details' : '/api/appointments/slots', {[field]:id});
    } catch { return {error:'Tool request failed or was not permitted. No change was made.'}; }
  }

  async restart() {
    if (!this.peer || ['disconnected','failed','closed'].includes(this.peer.connectionState) || this.channel?.readyState !== 'open') {
      throw new Error('Live connection was lost. End this call and start another; conversation history will not be restored.');
    }
    return super.restart();
  }

  async endServerCall() {
    if (!this.callId) return;
    const id = this.callId;
    const response = await this.fetchImpl(`/api/live/call/${encodeURIComponent(id)}`, {method:'DELETE', headers:{'X-Session':this.session}, keepalive:true});
    if (!response.ok) throw new Error('Could not confirm the Live session ended. Try End again.');
    if (this.callId === id) this.callId = null;
  }

  stop(preserveHistory = false) {
    if (!preserveHistory) this.endRequested = true;
    if (this.stopPromise) return this.stopPromise;
    const stopping = (async () => {
      this.clearIdle();
      this.stream?.getTracks().forEach(track => track.stop());
      this.audio.pause();
      if (this.pendingStart) { try { await this.pendingStart; } catch { /* cleanup below */ } }
      // The server closes Live through its sideband and waits for confirmation;
      // leave the peer open until that succeeds so the session can finalize.
      await this.endServerCall();
      this.closeLocal();
      this.responses.clear();
      this.responseByDelegation.clear();
      if (!preserveHistory) this.isPaused = false;
    })();
    this.stopPromise = stopping;
    return stopping.finally(() => { if (this.stopPromise === stopping) this.stopPromise = null; });
  }
}
