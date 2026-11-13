import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveVoice } from '../live-voice.mjs';

test('Live returns all completed function results before continuing the delegated response', async () => {
  const sent = [], requests = [];
  const voice = new LiveVoice({session:'fictional', audio:{pause(){}}, request:async (path, body) => { requests.push([path, body]); return {orders:[]}; }});
  voice.channel = {readyState:'open', send:raw => sent.push(JSON.parse(raw))};
  await voice.receive({type:'response.event', delegation_id:'d1', event:{type:'response.created', response:{id:'r1'}}});
  await voice.receive({type:'response.event', delegation_id:'d1', event:{type:'response.output_item.done', response_id:'r1', item:{type:'function_call', call_id:'c1', name:'list_orders', arguments:'{}'}}});
  assert.deepEqual(sent, []);
  await voice.receive({type:'response.event', delegation_id:'d1', event:{type:'response.completed', response:{id:'r1'}}});
  assert.deepEqual(requests, [['/api/orders', {}]]);
  assert.deepEqual(sent.map(value => value.type), ['response.item.create','response.create']);
  assert.equal(sent[0].item.call_id, 'c1');
});

test('Live refuses unknown tools and closes microphone on pause', async () => {
  const sent = [], calls=[];
  const voice = new LiveVoice({session:'fictional', audio:{pause(){}}, request:async (...args) => { calls.push(args); }});
  voice.channel = {readyState:'open', send:raw => sent.push(JSON.parse(raw))};
  await voice.receive({type:'response.event', delegation_id:'d', event:{type:'response.created', response:{id:'r'}}});
  await voice.receive({type:'response.event', delegation_id:'d', event:{type:'response.output_item.done', response_id:'r', item:{type:'function_call', call_id:'c', name:'change_appointment', arguments:'{}'}}});
  await voice.receive({type:'response.event', delegation_id:'d', event:{type:'response.completed', response:{id:'r'}}});
  assert.deepEqual(calls, []);
  assert.match(sent[0].item.output, /not permitted/);
  const track = {enabled:true, stopped:false, stop(){this.stopped=true;}};
  voice.stream = {getAudioTracks:() => [track]};
  voice.audioSender = {replaceTrack:async () => {}};
  assert.equal(voice.pause(true), true);
  assert.equal(track.stopped, true);
});

test('stopping Live releases microphone and waits for server confirmation before closing the peer', async () => {
  let confirm;
  const confirmation = new Promise(resolve => { confirm = resolve; });
  const track = {stopped:false, stop(){this.stopped=true;}};
  const peer = {closed:false, close(){this.closed = true;}};
  const voice = new LiveVoice({session:'fictional', audio:{pause(){}, srcObject:null}, fetchImpl:async () => { await confirmation; return {ok:true}; }});
  voice.stream = {getTracks:() => [track]};
  voice.peer = peer;
  voice.callId = 'live_1';
  const stopping = voice.stop();
  assert.equal(track.stopped, true);
  assert.equal(peer.closed, false);
  confirm();
  await stopping;
  assert.equal(peer.closed, true);
  assert.equal(voice.callId, null);
});

test('Live does not claim a replacement session restores history after a disconnect', async () => {
  const voice = new LiveVoice({session:'fictional', audio:{pause(){}}});
  voice.isPaused = true;
  await assert.rejects(voice.restart(), /history will not be restored/);
});

test('Live normalizes a spoken-form order ID before a customer-scoped lookup', async () => {
  const requests = [];
  const voice = new LiveVoice({session:'fictional', audio:{pause(){}}, request:async (path, body) => { requests.push([path, body]); return {status:'shipped'}; }});
  await voice.runTool({name:'lookup_order', arguments:JSON.stringify({order_id:'o r d dash a dash two zero one'})});
  assert.deepEqual(requests, [['/api/order-details', {order_id:'ord-a-201'}]]);
});

test('provider-initiated close leaves server cleanup available without claiming confirmation', async () => {
  const ended = [], statuses = [];
  const voice = new LiveVoice({session:'fictional', audio:{pause(){},srcObject:null}, ended:value => ended.push(value), status:value => statuses.push(value)});
  voice.callId = 'live_1';
  await voice.receive({type:'session.closed'});
  assert.equal(voice.callId, 'live_1');
  assert.deepEqual(ended, [false]);
  assert.match(statuses.at(-1), /confirm server cleanup/);
});

test('Live starts microphone only after session.started and uses the Live signaling route', async () => {
  const track = {enabled:true, stop(){}};
  const stream = {getAudioTracks:() => [track], getTracks:() => [track]};
  let peer;
  class Peer {
    constructor() { peer = this; this.iceGatheringState = 'complete'; this.connectionState = 'connected'; }
    createDataChannel() { return this.channel = {readyState:'open', send(){}, close(){}}; }
    addTrack() { return {replaceTrack:async () => {}}; }
    async createOffer() { return {sdp:'offer'}; }
    async setLocalDescription(offer) { this.localDescription = offer; }
    async setRemoteDescription(answer) { this.remoteDescription = answer; }
    close() {}
  }
  const paths = [];
  const voice = new LiveVoice({session:'fictional', media:{getUserMedia:async () => stream}, Peer, audio:{pause(){},srcObject:null}, fetchImpl:async (path) => {
    paths.push(path);
    return {ok:true, headers:{get:() => 'live_1'}, text:async () => 'answer'};
  }});
  assert.equal(await voice.start(), true);
  assert.equal(track.enabled, false);
  assert.deepEqual(paths, ['/api/live/call']);
  assert.equal(peer.remoteDescription.sdp, 'answer');
  await voice.receive({type:'session.started'});
  assert.equal(track.enabled, true);
  await voice.stop();
});

test('Live does not return a stale lookup result after newer speech arrives', async () => {
  let resolveRequest;
  const sent = [];
  const pending = new Promise(resolve => { resolveRequest = resolve; });
  const voice = new LiveVoice({session:'fictional', audio:{pause(){}}, request:async () => pending});
  voice.channel = {readyState:'open', send:raw => sent.push(JSON.parse(raw))};
  await voice.receive({type:'response.event', delegation_id:'d1', event:{type:'response.created', response:{id:'r1'}}});
  await voice.receive({type:'response.event', delegation_id:'d1', event:{type:'response.output_item.done', response_id:'r1', item:{type:'function_call', call_id:'c1', name:'list_orders', arguments:'{}'}}});
  const completion = voice.receive({type:'response.event', delegation_id:'d1', event:{type:'response.completed', response:{id:'r1'}}});
  await voice.receive({type:'session.input_transcript.delta', delta:'Actually, another order'});
  resolveRequest({private_old_order:'ord-a-201'});
  await completion;
  assert.doesNotMatch(sent[0].item.output, /ord-a-201/);
  assert.match(sent[0].item.output, /superseded/);
});

test('Live manual measurement marks only explicit operator timestamps', async () => {
  const {VoiceMetrics} = await import('../voice-metrics.mjs');
  let now = 100;
  const records = [];
  const voice = new LiveVoice({audio:{pause(){}}, metrics:new VoiceMetrics('live', () => now), metric:record => records.push(record)});
  assert.equal(voice.beginMeasurement(), true);
  assert.equal(voice.beginMeasurement(), false);
  now = 110; assert.equal(voice.markMeasurement('utterance_end'), true);
  await voice.receive({type:'session.input_transcript.delta', delta:'Hello'});
  now = 140; assert.equal(voice.markMeasurement('first_audible'), true);
  now = 160; assert.equal(voice.markMeasurement('first_useful_audible'), true);
  assert.equal(voice.finishMeasurement('success'), true);
  assert.equal(records[0].intervals_ms.utterance_end_to_first_audible, 30);
  assert.equal(records[0].intervals_ms.utterance_end_to_first_useful_audible, 50);
  assert.equal(records[0].intervals_ms.vad_stop_to_transcript_complete, null);
});

test('Live withholds an old tool result when newer speech arrives before response completion', async () => {
  const sent = [];
  const voice = new LiveVoice({session:'fictional', audio:{pause(){}}, request:async () => ({old_order:'ord-a-201'})});
  voice.channel = {readyState:'open', send:raw => sent.push(JSON.parse(raw))};
  await voice.receive({type:'response.event', delegation_id:'d', event:{type:'response.created', response:{id:'r'}}});
  await voice.receive({type:'response.event', delegation_id:'d', event:{type:'response.output_item.done', response_id:'r', item:{type:'function_call', call_id:'c', name:'list_orders', arguments:'{}'}}});
  await voice.receive({type:'session.input_transcript.delta', delta:'Actually, another order'});
  await voice.receive({type:'response.event', delegation_id:'d', event:{type:'response.completed', response:{id:'r'}}});
  assert.match(sent[0].item.output, /superseded/);
});
