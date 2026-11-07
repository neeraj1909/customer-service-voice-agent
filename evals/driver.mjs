// Exercise the same controlled conversation implementation as the browser UI.
import {Conversation, createRequest} from '../web/conversation.mjs';
import {performance} from 'node:perf_hooks';
const [base, raw] = process.argv.slice(2);
const input = JSON.parse(raw);
const start = await fetch(`${base}/api/sessions`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({customer_id:'cust-a'})});
if (!start.ok) throw new Error('session setup failed');
const {session_id} = await start.json();
const trace = [], messages = [], turnMessages = [], durations = [];
const request = createRequest({getSession: () => session_id, fetchImpl: async (path, options) => {
  const before = performance.now();
  const response = await fetch(`${base}${path}`, options);
  const data = await response.clone().json();
  trace.push({path, request: JSON.parse(options.body), status:response.status, response:data, duration_ms: performance.now() - before});
  return response;
}});
let key = 0;
const conversation = new Conversation({request, say: message => messages.push(message), key: () => `eval-${++key}`});
for (const command of input.commands) {
  const before = performance.now();
  const startMessage = messages.length;
  await conversation.send(command);
  turnMessages.push(messages.slice(startMessage));
  durations.push(performance.now() - before);
}
console.log(JSON.stringify({trace, messages, turn_messages:turnMessages, durations_ms:durations}));
