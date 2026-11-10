import test from 'node:test';
import assert from 'node:assert/strict';

function dom() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {id, value:'', textContent:'', disabled:false, files:[], children:[], src:'', attributes:{},
      setAttribute(name,value){this.attributes[name]=value;}, getAttribute(name){return this.attributes[name] ?? null;},
      appendChild(node){this.children.push(node);}, replaceChildren(){this.children=[];}, focus(){}, pause(){this.paused=true;}, load(){},
      removeAttribute(name){if (name==='src') this.src='';}});
    return elements.get(id);
  }
  return {element, document:{getElementById:element, createElement:() => ({textContent:''})}};
}

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
    await element('voice-stop').onclick();
    assert.equal(element('start').disabled, false);
    assert.equal(element('customer').disabled, false);
  } finally {
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator;
    if (oldPeer) globalThis.RTCPeerConnection = oldPeer; else delete globalThis.RTCPeerConnection;
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
    for (let i=0; i<10 && element('voice-restart').hidden !== false; i++) await new Promise(resolve=>setImmediate(resolve));
    assert.equal(element('voice-start').disabled, true);
    assert.equal(element('voice-stop').disabled, false);
    assert.equal(element('voice-restart').hidden, false);
    assert.match(element('voice-status').textContent, /Restart/);
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
    addTrack() {}
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
