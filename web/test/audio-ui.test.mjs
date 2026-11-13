import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

function dom() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {id, value:'', textContent:'', disabled:false, files:[], children:[], src:'', attributes:{},
      setAttribute(name,value){this.attributes[name]=value;}, getAttribute(name){return this.attributes[name] ?? null;},
      appendChild(node){this.children.push(node);}, replaceChildren(){this.children=[];}, focus(){}, pause(){this.paused=true;}, async play(){this.paused=false;}, load(){},
      removeAttribute(name){if (name==='src') this.src='';}});
    return elements.get(id);
  }
  return {element, document:{getElementById:element, createElement:() => ({textContent:''})}};
}

test('the voice pause control follows the assistant status', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="voice-status"[^>]*>[^<]*<\/p>\s*<button[^>]*id="voice-restart"/);
});

test('the voice comparison identifies the experimental guardrail difference', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="voice-mode"/);
  assert.match(html, /GPT-Live experimental/);
  assert.match(html, /does not run the baseline.s separate scope check/i);
  assert.match(html, /may answer unrelated questions/i);
});

test('the voice comparison can opt in to timing capture', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['voice-metrics', 'voice-case-id', 'voice-run-id', 'voice-export', 'voice-measure-begin', 'voice-measure-end-speech', 'voice-measure-audible', 'voice-measure-useful', 'voice-measure-finish']) assert.ok(html.includes(`id="${id}"`));
});

test('changing file and a failed transcription clear the old transcript and block copying', async () => {
  const {element, document} = dom();
  globalThis.document = document;
  globalThis.fetch = async path => path === '/api/sessions' ? {ok:true,json:async()=>({session_id:'s',customer_id:'cust-a'})} : {ok:false,json:async()=>({error:'audio_unavailable'})};
  element('customer').value='cust-a';
  element('conversation-language').value='en';
  element('audio-language').value='en';
  await import('../app.js?audio-ui-regression');
  await element('start').onclick();
  element('audio-transcript').value='yes';
  element('audio-file').files=[{name:'second.wav',size:200}];
  assert.equal(typeof element('audio-file').onchange,'function');
  element('audio-file').onchange();
  assert.equal(element('audio-transcript').value,'');
  await element('audio-transcribe').onclick();
  element('audio-use').onclick();
  assert.notEqual(element('conversation-input').value,'yes');
  assert.match(element('audio-status').textContent,/transcri/i);
});

test('file or language changes discard a delayed transcription response', async () => {
  const {element, document} = dom();
  globalThis.document = document;
  let finish;
  globalThis.fetch = async path => path === '/api/sessions' ? {ok:true,json:async()=>({session_id:'s',customer_id:'cust-a'})} : new Promise(resolve => { finish=resolve; });
  element('customer').value='cust-a'; element('conversation-language').value='en'; element('audio-language').value='en';
  await import('../app.js?audio-source-race');
  await element('start').onclick();
  const first={name:'first.wav',size:100};
  element('audio-file').files=[first];
  element('audio-file').onchange();
  const pending=element('audio-transcribe').onclick();
  assert.match(element('audio-status').textContent,/progress/i);
  element('audio-file').files=[{name:'second.wav',size:100}];
  element('audio-file').onchange();
  finish({ok:true,json:async()=>({text:'yes'})});
  await pending;
  assert.equal(element('audio-transcript').value,'');
  element('audio-use').onclick();
  assert.notEqual(element('conversation-input').value,'yes');
});

test('voice changes discard in-flight audio and synthesis failure removes old playback', async () => {
  const {element, document} = dom();
  globalThis.document = document;
  let finish, synthCalls=0;
  globalThis.fetch = async path => {
    if (path==='/api/sessions') return {ok:true,json:async()=>({session_id:'s',customer_id:'cust-a'})};
    if (path==='/api/audio/synthesize') {
      synthCalls++;
      if (synthCalls===1) return {ok:true,blob:async()=>new Blob(['wave'])};
      if (synthCalls===2) return {ok:false,json:async()=>({error:'audio_unavailable'})};
      return new Promise(resolve => { finish=resolve; });
    }
    throw new Error('unexpected request');
  };
  element('customer').value='cust-a'; element('conversation-language').value='en'; element('audio-voice').value='en';
  await import('../app.js?audio-voice-race');
  await element('start').onclick();
  element('conversation-input').value='unrecognized command';
  await element('conversation-form').onsubmit({preventDefault(){}});
  await element('audio-synthesize').onclick();
  assert.match(element('audio-playback').src,/^blob:/);
  await element('audio-synthesize').onclick();
  assert.equal(element('audio-playback').src,'');
  const pending=element('audio-synthesize').onclick();
  assert.match(element('audio-status').textContent,/generating/i);
  element('audio-voice').value='hi';
  element('audio-voice').onchange();
  finish({ok:true,blob:async()=>new Blob(['wave'])});
  await pending;
  assert.equal(element('audio-playback').src,'');
});

test('recognition language change clears previously copied transcript', async () => {
  const {element, document} = dom();
  globalThis.document = document;
  globalThis.fetch = async path => path === '/api/sessions' ? {ok:true,json:async()=>({session_id:'s',customer_id:'cust-a'})} : {ok:true,json:async()=>({text:'yes'})};
  element('customer').value='cust-a'; element('conversation-language').value='en'; element('audio-language').value='en';
  await import('../app.js?audio-language-change');
  await element('start').onclick();
  element('audio-file').files=[{name:'speech.wav',size:100}];
  element('audio-file').onchange();
  await element('audio-transcribe').onclick();
  element('audio-use').onclick();
  assert.equal(element('conversation-input').value,'yes');
  element('audio-language').value='hi';
  element('audio-language').onchange();
  assert.equal(element('audio-transcript').value,'');
  assert.equal(element('conversation-input').value,'');
});

test('customer session cannot be changed from the UI while live voice is active', async () => {
  const {element, document} = dom();
  globalThis.document = document;
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const oldPeer = globalThis.RTCPeerConnection;
  Object.defineProperty(globalThis, 'navigator', {configurable:true, value:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[], getAudioTracks:()=>[]})}}});
  globalThis.RTCPeerConnection = class {
    createDataChannel() { return {readyState:'open', close(){}}; }
    async createOffer() { return {sdp:'offer'}; }
    async setLocalDescription(d) { this.localDescription=d; }
    async setRemoteDescription() {}
    close() {}
  };
  globalThis.fetch = async path => path === '/api/sessions' ? {ok:true,json:async()=>({session_id:'s',customer_id:'cust-a'})} :
    path === '/api/realtime/call' ? {ok:true,headers:{get:()=> 'call-id'},text:async()=> 'answer'} : {ok:true};
  try {
    element('customer').value='cust-a'; element('conversation-language').value='en';
    await import('../app.js?live-voice-session');
    await element('start').onclick();
    await element('voice-start').onclick();
    assert.equal(element('start').disabled, true);
    assert.equal(element('customer').disabled, true);
    assert.equal(element('voice-mode').disabled, true);
    await element('voice-stop').onclick();
    assert.equal(element('start').disabled, false);
    assert.equal(element('customer').disabled, false);
    assert.equal(element('voice-mode').disabled, false);
  } finally {
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator;
    if (oldPeer) globalThis.RTCPeerConnection = oldPeer; else delete globalThis.RTCPeerConnection;
  }
});

test('choosing GPT-Live starts the Live endpoint and locks the mode during the call', async () => {
  const {element, document} = dom();
  globalThis.document = document;
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const oldPeer = globalThis.RTCPeerConnection;
  const requests = [];
  const oldCreateObjectURL = URL.createObjectURL, oldRevokeObjectURL = URL.revokeObjectURL;
  let exported;
  URL.createObjectURL = blob => { exported = blob; return 'blob:metrics'; };
  URL.revokeObjectURL = () => {};
  document.createElement = () => ({click(){}});
  Object.defineProperty(globalThis, 'navigator', {configurable:true, value:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[], getAudioTracks:()=>[]})}}});
  globalThis.RTCPeerConnection = class {
    createDataChannel() { return {readyState:'open', send(){}, close(){}}; }
    async createOffer() { return {sdp:'offer'}; }
    async setLocalDescription(d) { this.localDescription=d; }
    async setRemoteDescription() {}
    close() {}
  };
  globalThis.fetch = async (path, options = {}) => {
    requests.push([path, options.method]);
    if (path === '/api/sessions') return {ok:true, json:async()=>({session_id:'s', customer_id:'cust-a'})};
    if (path === '/api/live/call') return {ok:true, headers:{get:()=> 'live-id'}, text:async()=> 'answer'};
    return {ok:true};
  };
  try {
    element('customer').value='cust-a'; element('voice-mode').value='live';
    element('voice-metrics').checked=true; element('voice-case-id').value='order'; element('voice-run-id').value='run1';
    await import('../app.js?live-mode-selection');
    await element('start').onclick();
    await element('voice-start').onclick();
    assert.ok(requests.some(([path, method]) => path === '/api/live/call' && method === 'POST'));
    assert.equal(element('voice-mode').disabled, true);
    element('voice-measure-begin').onclick();
    element('voice-measure-end-speech').onclick();
    element('voice-measure-audible').onclick();
    element('voice-measure-useful').onclick();
    element('voice-measure-finish').onclick();
    element('voice-measure-begin').onclick();
    assert.equal(element('voice-measure-timeout').disabled, false);
    element('voice-measure-timeout').onclick();
    element('voice-measure-begin').onclick();
    element('voice-measure-error').onclick();
    assert.equal(element('voice-export').disabled, false);
    element('voice-export').onclick();
    const [record, timeout, error] = JSON.parse(await exported.text());
    assert.equal(record.arm, 'live');
    assert.equal(record.measurement, 'operator_estimated');
    assert.equal(record.case_id, 'order');
    assert.equal(record.run_id, 'run1-manual-1');
    assert.ok(record.intervals_ms.utterance_end_to_first_useful_audible >= 0);
    assert.equal(timeout.outcome, 'timeout');
    assert.equal(timeout.intervals_ms.utterance_end_to_first_audible, null);
    assert.equal(error.outcome, 'error');
    assert.equal(error.intervals_ms.utterance_end_to_first_audible, null);
    await element('voice-stop').onclick();
    assert.equal(element('voice-mode').disabled, false);
  } finally {
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator;
    if (oldPeer) globalThis.RTCPeerConnection = oldPeer; else delete globalThis.RTCPeerConnection;
    URL.createObjectURL = oldCreateObjectURL; URL.revokeObjectURL = oldRevokeObjectURL;
  }
});

test('a failed voice connection offers restart in the existing customer session', async () => {
  const {element, document} = dom();
  globalThis.document = document;
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const oldPeer = globalThis.RTCPeerConnection;
  let peer;
  Object.defineProperty(globalThis, 'navigator', {configurable:true, value:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[], getAudioTracks:()=>[]})}}});
  globalThis.RTCPeerConnection = class {
    constructor() { peer = this; }
    createDataChannel() { return {readyState:'open', close(){}}; }
    async createOffer() { return {sdp:'offer'}; }
    async setLocalDescription(d) { this.localDescription=d; }
    async setRemoteDescription() {}
    close() {}
  };
  globalThis.fetch = async path => path === '/api/sessions' ? {ok:true,json:async()=>({session_id:'s',customer_id:'cust-a'})} :
    path === '/api/realtime/call' ? {ok:true,headers:{get:()=> 'call-id'},text:async()=> 'answer'} : {ok:true};
  try {
    element('customer').value='cust-a'; element('conversation-language').value='en';
    await import('../app.js?live-voice-failure');
    await element('start').onclick();
    await element('voice-start').onclick();
    peer.connectionState='failed'; peer.onconnectionstatechange();
    for (let i=0; i<10 && element('voice-restart').textContent !== 'Resume'; i++) await new Promise(resolve=>setImmediate(resolve));
    assert.equal(element('voice-start').disabled, true);
    assert.equal(element('voice-stop').disabled, false);
    assert.equal(element('voice-restart').hidden, false);
    assert.equal(element('voice-restart').textContent, 'Resume');
    assert.match(element('voice-status').textContent, /Resume/);
    await element('voice-stop').onclick();
  } finally {
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator;
    if (oldPeer) globalThis.RTCPeerConnection = oldPeer; else delete globalThis.RTCPeerConnection;
  }
});

test('the microphone control mutes and unmutes a live call', async () => {
  const {element, document} = dom(); globalThis.document = document;
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), oldPeer = globalThis.RTCPeerConnection;
  const track = {enabled:true, stop(){}};
  Object.defineProperty(globalThis, 'navigator', {configurable:true, value:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[track], getAudioTracks:()=>[track]})}}});
  globalThis.RTCPeerConnection = class {
    createDataChannel() { return {readyState:'open', close(){}}; }
    addTrack() { return {replaceTrack:async()=>{}}; }
    async createOffer() { return {sdp:'offer'}; }
    async setLocalDescription(d) { this.localDescription=d; }
    async setRemoteDescription() {}
    close() {}
  };
  globalThis.fetch = async path => path === '/api/sessions' ? {ok:true,json:async()=>({session_id:'s',customer_id:'cust-a'})} :
    path === '/api/realtime/call' ? {ok:true,headers:{get:()=> 'call-id'},text:async()=> 'answer'} : {ok:true};
  try {
    element('customer').value='cust-a'; element('conversation-language').value='en';
    await import('../app.js?live-voice-mute');
    await element('start').onclick(); await element('voice-start').onclick();
    element('voice-mute').onclick();
    assert.equal(track.enabled, false);
    assert.equal(element('voice-mute').textContent, 'Unmute microphone');
    element('voice-mute').onclick();
    assert.equal(track.enabled, true);
    await element('voice-stop').onclick();
    assert.equal(element('voice-mute').disabled, true);
  } finally {
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator;
    if (oldPeer) globalThis.RTCPeerConnection = oldPeer; else delete globalThis.RTCPeerConnection;
  }
});

test('the pause control pauses and resumes a call without ending its customer session', async () => {
  const {element, document} = dom(); globalThis.document = document;
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), oldPeer = globalThis.RTCPeerConnection;
  const track = {enabled:true, stop(){}};
  let peer;
  Object.defineProperty(globalThis, 'navigator', {configurable:true, value:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[track], getAudioTracks:()=>[track]})}}});
  globalThis.RTCPeerConnection = class {
    constructor() { peer=this; this.connectionState='connected'; }
    createDataChannel() { return this.channel={readyState:'open', close(){}, send(){}}; }
    addTrack() { return {replaceTrack:async()=>{}}; }
    async createOffer() { return {sdp:'offer'}; }
    async setLocalDescription(d) { this.localDescription=d; }
    async setRemoteDescription() {}
    close() {}
  };
  globalThis.fetch = async path => path === '/api/sessions' ? {ok:true,json:async()=>({session_id:'s',customer_id:'cust-a'})} :
    path === '/api/realtime/call' ? {ok:true,headers:{get:()=> 'call-id'},text:async()=> 'answer'} : {ok:true};
  try {
    element('customer').value='cust-a'; element('conversation-language').value='en';
    await import('../app.js?live-voice-pause');
    await element('start').onclick(); await element('voice-start').onclick(); peer.channel.onopen();
    assert.equal(element('voice-restart').hidden, false);
    assert.equal(element('voice-restart').textContent, 'Pause');
    await element('voice-restart').onclick();
    assert.equal(track.enabled, false);
    assert.equal(element('voice-restart').textContent, 'Resume');
    assert.equal(element('customer').disabled, true);
    await element('voice-restart').onclick();
    assert.equal(track.enabled, true);
    assert.equal(element('voice-restart').textContent, 'Pause');
    await element('voice-stop').onclick();
    assert.equal(element('voice-restart').hidden, true);
  } finally {
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator;
    if (oldPeer) globalThis.RTCPeerConnection = oldPeer; else delete globalThis.RTCPeerConnection;
  }
});
