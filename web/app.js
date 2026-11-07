import { Conversation, createRequest } from './conversation.mjs';
let session = '', proposal = null, changeKey = '', handoffPending = null;
const $ = id => document.getElementById(id);
const result = value => { $('result').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
const call = createRequest({getSession: () => session});
function clearProposal() { proposal = null; changeKey = ''; $('confirm').disabled = true; $('reject').disabled = true; $('proposal').textContent = 'No change proposed.'; }
async function run(fn) { try { result(await fn()); } catch (error) { result(error.definitive ? `Request rejected: ${error.message}. No change was made; correct the input.` : `Request was not confirmed: ${error.message}. If the connection was interrupted, the outcome may be unknown; retry the same request.`); } }
$('start').onclick = () => run(async () => { const data = await call('/api/sessions', {customer_id:$('customer').value}); session = data.session_id; handoffPending = null; clearProposal(); conversation.reset(); conversation.setLanguage($('conversation-language').value); return `Session started for ${data.customer_id}.`; });
$('lookup').onclick = () => run(() => call('/api/order', {order_id:$('order').value}));
$('slots').onclick = () => run(() => call('/api/appointments/slots', {appointment_id:$('appointment').value}));
$('propose').onclick = () => run(async () => { const nextProposal = await call('/api/appointments/propose', {appointment_id:$('appointment').value, slot_id:$('slot').value}); clearProposal(); proposal = nextProposal; if (proposal.no_op) { clearProposal(); return 'Appointment already uses that slot; no change was made.'; } changeKey = crypto.randomUUID(); $('proposal').textContent = `Move ${proposal.appointment_id} from ${proposal.original_slot} to ${proposal.slot_id} at ${proposal.time_utc}?`; $('confirm').disabled = false; $('reject').disabled = false; return proposal; });
$('confirm').onclick = () => run(async () => { const data = await call('/api/appointments/confirm', {confirmation_id:proposal.confirmation_id, idempotency_key:changeKey}); clearProposal(); return data; });
$('reject').onclick = () => run(async () => { const data = await call('/api/appointments/reject', {confirmation_id:proposal.confirmation_id}); clearProposal(); return data; });
$('handoff').onclick = () => run(async () => { if (!handoffPending) handoffPending = {issue:$('issue').value, language:$('language').value, summary:$('issue').value, idempotency_key:crypto.randomUUID()}; try { const data = await call('/api/handoff', handoffPending); handoffPending = null; return data; } catch (error) { if (error.definitive) handoffPending = null; else if (error.uncertain) error.message += ` Pending local handoff issue: ${handoffPending.issue}`; throw error; } });

const transcript = $('conversation-log');
function say(speaker, message) { const p = document.createElement('p'); p.textContent = `${speaker}: ${message}`; transcript.appendChild(p); }
const conversation = new Conversation({request:call, say:message => say('Assistant', message)});
$('conversation-language').onchange = () => conversation.setLanguage($('conversation-language').value);
$('conversation-form').onsubmit = async event => {
  event.preventDefault();
  const input = $('conversation-input');
  const value = input.value.trim();
  if (!value) return;
  input.value = '';
  say('You', value);
  $('conversation-submit').disabled = true;
  try { await conversation.send(value); $('conversation-language').value = conversation.language; } finally { $('conversation-submit').disabled = false; input.focus(); }
};
