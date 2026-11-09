import test from 'node:test';
import assert from 'node:assert/strict';
import {RealtimeVoice} from '../realtime-voice.mjs';

function fixture({getUserMedia} = {}) {
  const sent = [], calls = [], track = {stopped: false, stop() { this.stopped = true; }};
  const stream = {getTracks: () => [track], getAudioTracks: () => [track]};
  class Peer {
    constructor() { this.connectionState = 'new'; }
    createDataChannel() { return this.channel = {readyState:'open', send: x => sent.push(JSON.parse(x)), close() { this.closed = true; }}; }
    addTrack() {}
    async createOffer() { return {sdp:'offer'}; }
    async setLocalDescription(description) { this.localDescription = description; }
    async setRemoteDescription(description) { this.remoteDescription = description; }
    close() { this.closed = true; }
  }
  const audio = {muted:false, pause(){this.paused=true;}, play:async()=>{}};
  const media = {getUserMedia: getUserMedia ?? (async () => stream)};
  const fetchImpl = async (url, options) => { calls.push({url, options}); return url === '/api/realtime/call' ?
    {ok:true, headers:{get: () => 'call-123'}, text:async()=> 'answer'} : {ok:true}; };
  let requests = [];
  const request = async (path, body) => { requests.push({path, body}); return {order_id:body.order_id, status:'shipped'}; };
  return {voice:new RealtimeVoice({session:'session-1', request, audio, media, Peer, fetchImpl}), sent, calls, track, audio, requests};
}

test('requires a session before using the microphone', async () => {
  const f = fixture(); f.voice.session = '';
  await assert.rejects(f.voice.start(), /session first/);
  assert.equal(f.calls.length, 0);
});

test('connects with a scoped session and releases microphone and server call', async () => {
  const f = fixture();
  assert.equal(await f.voice.start(), true);
  assert.equal(f.calls[0].options.headers['X-Session'], 'session-1');
  await f.voice.stop();
  assert.equal(f.track.stopped, true);
  assert.equal(f.calls[1].url, '/api/realtime/call/call-123');
  assert.equal(f.calls[1].options.headers['X-Session'], 'session-1');
});

test('a failed connection closes the call and releases the UI for retry', async () => {
  const f = fixture(), ended = [], statuses = [];
  f.voice.ended = closed => ended.push(closed);
  f.voice.status = message => statuses.push(message);
  await f.voice.start();
  const peer = f.voice.peer;
  peer.connectionState = 'disconnected'; peer.onconnectionstatechange();
  assert.match(statuses.at(-1), /waiting/);
  peer.connectionState = 'failed'; peer.onconnectionstatechange();
  for (let i = 0; i < 10 && !ended.length; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ended, [true]);
  assert.equal(f.track.stopped, true);
  assert.equal(f.calls.at(-1).url, '/api/realtime/call/call-123');
  assert.match(statuses.at(-1), /Start a new call/);
});

test('failed cleanup keeps the End call recovery path available', async () => {
  const f = fixture(), ended = [];
  const fetch = f.voice.fetchImpl;
  f.voice.fetchImpl = (url, options) => url === '/api/realtime/call' ? fetch(url, options) : Promise.resolve({ok:false});
  f.voice.ended = closed => ended.push(closed);
  await f.voice.start();
  f.voice.peer.connectionState = 'failed'; f.voice.peer.onconnectionstatechange();
  for (let i = 0; i < 10 && !ended.length; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ended, [false]);
  assert.equal(f.voice.callId, 'call-123');
});

test('permissions failure leaves no active call', async () => {
  const f = fixture({getUserMedia: async () => { throw new Error('Permission denied'); }});
  await assert.rejects(f.voice.start(), /Permission denied/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.voice.peer, null);
});

test('explains the local call limit when the server rejects a new call', async () => {
  const f = fixture();
  f.voice.fetchImpl = async () => ({ok:false, status:429, headers:{get:() => null}});
  await assert.rejects(f.voice.start(), /two-call limit/);
  assert.equal(f.track.stopped, true);
});

test('ending during offer negotiation stops capture and hangs up a late call', async () => {
  const f = fixture();
  let resolveOffer;
  const fetch = f.voice.fetchImpl;
  f.voice.fetchImpl = (url, options) => url === '/api/realtime/call' ?
    new Promise(resolve => { resolveOffer = resolve; }) : fetch(url, options);
  const start = f.voice.start();
  while (!resolveOffer) await new Promise(resolve => setImmediate(resolve));
  const stop = f.voice.stop();
  assert.equal(f.track.stopped, true);
  resolveOffer({ok:true, headers:{get:() => 'call-123'}, text:async()=> 'answer'});
  assert.equal(await start, false);
  await stop;
  assert.equal(f.calls[0].url, '/api/realtime/call/call-123');
});

test('speech detection does not leave WebRTC playback muted during overlapping turns', async () => {
  const f = fixture(); await f.voice.start();
  await f.voice.receive({type:'response.created', response:{id:'r1'}});
  await f.voice.receive({type:'input_audio_buffer.speech_started'});
  assert.equal(f.audio.muted, false);
  await f.voice.receive({type:'output_audio_buffer.started', response_id:'r1'});
  await f.voice.receive({type:'input_audio_buffer.speech_stopped'});
  assert.equal(f.audio.muted, false);
  await f.voice.receive({type:'output_audio_buffer.cleared', response_id:'r1'});
  await f.voice.receive({type:'response.created', response:{id:'r2'}});
  await f.voice.receive({type:'output_audio_buffer.started', response_id:'r2'});
  assert.equal(f.audio.muted, false);
  await f.voice.stop();
});

test('requests browser echo cancellation and noise suppression', async () => {
  let constraints;
  const track = {stop() {}};
  const stream = {getTracks: () => [track], getAudioTracks: () => [track]};
  const f = fixture({getUserMedia: async value => { constraints = value; return stream; }});
  await f.voice.start();
  assert.deepEqual(constraints, {audio:{echoCancellation:true, noiseSuppression:true}, video:false});
  await f.voice.stop();
});

test('microphone mute changes the outbound track and restores it', async () => {
  const f = fixture(); await f.voice.start();
  assert.equal(f.voice.setMicrophoneMuted(true), true);
  assert.equal(f.track.enabled, false);
  f.voice.setMicrophoneMuted(false);
  assert.equal(f.track.enabled, true);
  await f.voice.stop();
});

test('selected language is sent only from the fixed allowlist', async () => {
  const f = fixture(); f.voice.language = 'en'; await f.voice.start();
  f.voice.channel.onopen();
  assert.match(f.sent[0].item.content[0].text, /reply in English/);
  await f.voice.stop();
  const invalid = fixture(); invalid.voice.language = 'unexpected'; await invalid.voice.start();
  invalid.voice.channel.onopen();
  assert.equal(invalid.sent.length, 0);
  await invalid.voice.stop();
});

test('reports why a response stopped when provider gives a known reason', async () => {
  const f = fixture(), statuses=[]; f.voice.status = text => statuses.push(text);
  await f.voice.receive({type:'response.done',response:{status:'incomplete',status_details:{reason:'max_output_tokens'}}});
  assert.match(statuses.at(-1), /length limit/);
  await f.voice.receive({type:'response.done',response:{status:'cancelled',status_details:{reason:'turn_detected'}}});
  assert.match(statuses.at(-1), /heard a sound/);
});

test('permits only well-formed read tools once per call ID', async () => {
  const f = fixture(); await f.voice.start(); f.voice.approvedTurn = f.voice.turn;
  const event = {type:'response.function_call_arguments.done', name:'lookup_order', call_id:'c1', arguments:'{"order_id":"ord-a-201"}'};
  await f.voice.receive(event); await f.voice.receive(event);
  assert.deepEqual(f.requests, [{path:'/api/order-details', body:{order_id:'ord-a-201'}}]);
  assert.equal(f.sent.length, 2);
  await f.voice.receive({...event, call_id:'c2', name:'change_appointment'});
  assert.equal(f.requests.length, 1);
  assert.match(f.sent[2].item.output, /not permitted/);
  await f.voice.stop();
});


test('order history is scoped to the existing session and accepts no customer argument', async () => {
  const f = fixture(); await f.voice.start(); f.voice.approvedTurn = f.voice.turn;
  await f.voice.receive({type:'response.function_call_arguments.done', name:'list_orders', call_id:'history', arguments:'{}'});
  assert.deepEqual(f.requests, [{path:'/api/orders', body:{}}]);
  await f.voice.receive({type:'response.function_call_arguments.done', name:'list_orders', call_id:'bad', arguments:'{"customer":"cust-b"}'});
  assert.equal(f.requests.length, 1);
  assert.match(f.sent[2].item.output, /not permitted/);
  await f.voice.stop();
});


test('normalizes a clearly spoken order identifier without changing its customer', async () => {
  const f = fixture(); await f.voice.start(); f.voice.approvedTurn = f.voice.turn;
  await f.voice.receive({type:'response.function_call_arguments.done', name:'lookup_order', call_id:'spelled', arguments:'{"order_id":"ORD A 201"}'});
  assert.deepEqual(f.requests, [{path:'/api/order-details', body:{order_id:'ord-a-201'}}]);
  await f.voice.receive({type:'response.function_call_arguments.done', name:'lookup_order', call_id:'words', arguments:'{"order_id":"O R D dash A dash two zero one"}'});
  assert.deepEqual(f.requests[1], {path:'/api/order-details', body:{order_id:'ord-a-201'}});
  await f.voice.receive({type:'response.function_call_arguments.done', name:'lookup_order', call_id:'foreign', arguments:'{"order_id":"ORD B two zero one"}'});
  assert.deepEqual(f.requests[2], {path:'/api/order-details', body:{order_id:'ord-b-201'}});
  await f.voice.receive({type:'response.function_call_arguments.done', name:'lookup_order', call_id:'unclear', arguments:'{"order_id":"order a two zero one"}'});
  assert.equal(f.requests.length, 3);
  await f.voice.stop();
});

test('reports speech, lookup and provider errors without displaying provider details', async () => {
  const f = fixture(), statuses = [];
  f.voice.status = message => statuses.push(message);
  await f.voice.start(); f.voice.approvedTurn = f.voice.turn;
  await f.voice.receive({type:'input_audio_buffer.speech_started'});
  await f.voice.receive({type:'input_audio_buffer.speech_stopped'});
  f.voice.approvedTurn = f.voice.turn;
  await f.voice.receive({type:'response.function_call_arguments.done', name:'list_orders', call_id:'status', arguments:'{}'});
  await f.voice.receive({type:'error', error:{message:'private provider detail'}});
  assert.deepEqual(statuses.slice(-5), ['Listening.', 'Processing your request.', 'Checking your request.', 'Preparing a response.', 'The voice service reported an error. Try again or restart the call.']);
  await f.voice.stop();
});


test('checks a transcript and deletes the original before responding with the approved request', async () => {
  const f = fixture(); await f.voice.start();
  f.voice.request = async (path, body) => {
    assert.equal(path, '/api/realtime/scope');
    assert.equal(body.transcript, 'Where is my order and what is the capital of France?');
    return {decision:'allow', safe_text:'Where is my order?'};
  };
  const pending = f.voice.receive({type:'conversation.item.input_audio_transcription.completed', item_id:'i1', transcript:'Where is my order and what is the capital of France?'});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.sent, [{type:'conversation.item.delete', item_id:'i1'}]);
  await f.voice.receive({type:'conversation.item.deleted', item_id:'i1'});
  await pending;
  assert.equal(f.sent[1].item.content[0].text, 'Where is my order?');
  assert.equal(f.sent[2].type, 'response.create');
  await f.voice.stop();
});
