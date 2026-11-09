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

test('permissions failure leaves no active call', async () => {
  const f = fixture({getUserMedia: async () => { throw new Error('Permission denied'); }});
  await assert.rejects(f.voice.start(), /Permission denied/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.voice.peer, null);
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

test('interruption mutes old output and allows a later response', async () => {
  const f = fixture(); await f.voice.start();
  await f.voice.receive({type:'response.created', response:{id:'r1'}});
  await f.voice.receive({type:'input_audio_buffer.speech_started'});
  assert.equal(f.audio.muted, true);
  await f.voice.receive({type:'input_audio_buffer.speech_stopped'});
  await f.voice.receive({type:'output_audio_buffer.started', response_id:'r1'});
  assert.equal(f.audio.muted, true);
  await f.voice.receive({type:'response.created', response:{id:'r2'}});
  await f.voice.receive({type:'output_audio_buffer.started', response_id:'r2'});
  assert.equal(f.audio.muted, false);
  await f.voice.stop();
});

test('an old playing response remains muted after a newer response is created', async () => {
  const f = fixture(); await f.voice.start();
  await f.voice.receive({type:'response.created', response:{id:'r1'}});
  await f.voice.receive({type:'output_audio_buffer.started', response_id:'r1'});
  await f.voice.receive({type:'response.created', response:{id:'r2'}});
  await f.voice.receive({type:'input_audio_buffer.speech_started'});
  await f.voice.receive({type:'input_audio_buffer.speech_stopped'});
  await f.voice.receive({type:'output_audio_buffer.started', response_id:'r1'});
  assert.equal(f.audio.muted, true);
  await f.voice.receive({type:'output_audio_buffer.started', response_id:'r2'});
  assert.equal(f.audio.muted, false);
  await f.voice.stop();
});

test('permits only well-formed read tools once per call ID', async () => {
  const f = fixture(); await f.voice.start();
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
  const f = fixture(); await f.voice.start();
  await f.voice.receive({type:'response.function_call_arguments.done', name:'list_orders', call_id:'history', arguments:'{}'});
  assert.deepEqual(f.requests, [{path:'/api/orders', body:{}}]);
  await f.voice.receive({type:'response.function_call_arguments.done', name:'list_orders', call_id:'bad', arguments:'{"customer":"cust-b"}'});
  assert.equal(f.requests.length, 1);
  assert.match(f.sent[2].item.output, /not permitted/);
  await f.voice.stop();
});


test('normalizes a clearly spoken order identifier without changing its customer', async () => {
  const f = fixture(); await f.voice.start();
  await f.voice.receive({type:'response.function_call_arguments.done', name:'lookup_order', call_id:'spelled', arguments:'{"order_id":"ORD A 201"}'});
  assert.deepEqual(f.requests, [{path:'/api/order-details', body:{order_id:'ord-a-201'}}]);
  await f.voice.receive({type:'response.function_call_arguments.done', name:'lookup_order', call_id:'unclear', arguments:'{"order_id":"order a two zero one"}'});
  assert.equal(f.requests.length, 1);
  await f.voice.stop();
});
