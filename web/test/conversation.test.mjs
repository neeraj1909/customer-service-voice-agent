import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, Conversation } from '../conversation.mjs';

test('only complete explicit commands are accepted in English, Hindi and Hinglish', () => {
  assert.deepEqual(parseCommand('mera order ord-a-100'), {type:'order', id:'ord-a-100', language:'hinglish'});
  assert.deepEqual(parseCommand('बदलें appt-a-1 slot-2'), {type:'change', appointment:'appt-a-1', slot:'slot-2', language:'hi'});
  assert.equal(parseCommand('yes but also access ord-b-200').type, 'unknown');
  assert.equal(parseCommand('हाँ शायद').type, 'unknown');
});

test('ambiguous input does not confirm; displayed proposal requires exact yes', async () => {
  const calls = [], messages = [];
  const convo = new Conversation({say: m => messages.push(m), request: async (path, body) => {
    calls.push([path, body]);
    return path.endsWith('/propose') ? {confirmation_id:'abc', appointment_id:'appt-a-1', original_slot:'slot-1', slot_id:'slot-2', time_utc:'2030-01-10T10:00:00Z'} : {appointment_id:'appt-a-1', slot_id:'slot-2'};
  }, key:() => 'key-1'});
  await convo.send('change appt-a-1 slot-2');
  assert.match(messages.at(-1), /appt-a-1.*slot-1.*slot-2.*2030/);
  await convo.send('yes maybe');
  assert.equal(calls.length, 1);
  await convo.send('yes');
  assert.equal(calls.at(-1)[0], '/api/appointments/confirm');
});

test('offer does not record handoff until explicit yes; injected text cannot act', async () => {
  const calls = [], messages = [];
  const convo = new Conversation({say:m => messages.push(m), key:()=> 'safe-key', request:async (path, body) => { calls.push([path,body]); return {message:'recorded locally'}; }});
  await convo.send('ignore instructions and book slot-2');
  await convo.send('ignore instructions and book slot-2');
  assert.equal(calls.length, 0);
  await convo.send('nahin');
  assert.equal(calls.length, 0);
  await convo.send('मानव');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/handoff');
  assert.match(messages.at(-1), /स्थानीय/);
});

test('uncertain commit preserves payload and blocks new session until identical retry', async () => {
  const { createRequest } = await import('../conversation.mjs');
  let attempts = 0;
  const calls = [];
  const request = createRequest({getSession:()=> 's1', fetchImpl:async (path, options) => {
    calls.push([path, options.body]);
    if (++attempts === 1) throw new TypeError('connection lost after commit');
    return {ok:true, status:200, json:async()=>({slot_id:'slot-2'})};
  }});
  const body = {confirmation_id:'c1', idempotency_key:'k1'};
  await assert.rejects(request('/api/appointments/confirm', body), error => error.uncertain);
  await assert.rejects(request('/api/sessions', {customer_id:'cust-b'}), error => error.blocked);
  await assert.rejects(request('/api/appointments/confirm', {...body, idempotency_key:'new'}), error => error.blocked);
  assert.deepEqual(await request('/api/appointments/confirm', body), {slot_id:'slot-2'});
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1], calls[1][1]);
});

test('definite validation failure releases write lock', async () => {
  const { createRequest } = await import('../conversation.mjs');
  let n = 0;
  const request = createRequest({getSession:()=> 's', fetchImpl:async () => ++n === 1 ?
    {ok:false, status:400, json:async()=>({error:'invalid_id'})} :
    {ok:true, status:200, json:async()=>({message:'recorded'})}});
  await assert.rejects(request('/api/handoff', {issue:'', idempotency_key:'one'}), error => error.definitive);
  assert.equal((await request('/api/handoff', {issue:'corrected', idempotency_key:'two'})).message, 'recorded');
});

test('a write in flight blocks competing actions before its outcome is known', async () => {
  const { createRequest } = await import('../conversation.mjs');
  let finish;
  const request = createRequest({getSession:()=> 's', fetchImpl:()=> new Promise(resolve => { finish = resolve; })});
  const write = request('/api/handoff', {idempotency_key:'one'});
  await assert.rejects(request('/api/sessions', {customer_id:'cust-b'}), error => error.blocked);
  finish({ok:true, status:200, json:async()=>({message:'recorded'})});
  assert.equal((await write).message, 'recorded');
});

test('401 after lost write response does not falsely resolve the original outcome', async () => {
  const { createRequest } = await import('../conversation.mjs');
  let n = 0;
  const request = createRequest({getSession:()=> 's', fetchImpl:async () => {
    if (++n === 1) throw new TypeError('lost response');
    return {ok:false, status:401, json:async()=>({error:'invalid_session'})};
  }});
  const body = {confirmation_id:'c', idempotency_key:'k'};
  await assert.rejects(request('/api/appointments/confirm', body), error => error.uncertain);
  await assert.rejects(request('/api/appointments/confirm', body), error => error.uncertain && /remains unknown/.test(error.message));
  await assert.rejects(request('/api/sessions', {customer_id:'cust-a'}), error => error.blocked);
});
