let session = '', proposal = null, changeKey = '', handoffPending = null;
const $ = id => document.getElementById(id);
const result = value => { $('result').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
async function call(path, body) {
  const response = await fetch(path, {method: 'POST', headers: {'Content-Type':'application/json', 'X-Session':session}, body:JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || data.error);
  return data;
}
function clearProposal() { proposal = null; changeKey = ''; $('confirm').disabled = true; $('reject').disabled = true; $('proposal').textContent = 'No change proposed.'; }
async function run(fn) { try { result(await fn()); } catch (error) { result(`Request was not confirmed: ${error.message}. If the connection was interrupted, the outcome may be unknown; retry the same request.`); } }
$('start').onclick = () => run(async () => { const data = await call('/api/sessions', {customer_id:$('customer').value}); session = data.session_id; handoffPending = null; clearProposal(); return `Session started for ${data.customer_id}.`; });
$('lookup').onclick = () => run(() => call('/api/order', {order_id:$('order').value}));
$('slots').onclick = () => run(() => call('/api/appointments/slots', {appointment_id:$('appointment').value}));
$('propose').onclick = () => run(async () => { clearProposal(); proposal = await call('/api/appointments/propose', {appointment_id:$('appointment').value, slot_id:$('slot').value}); if (proposal.no_op) { clearProposal(); return 'Appointment already uses that slot; no change was made.'; } changeKey = crypto.randomUUID(); $('proposal').textContent = `Move ${proposal.appointment_id} from ${proposal.original_slot} to ${proposal.slot_id} at ${proposal.time_utc}?`; $('confirm').disabled = false; $('reject').disabled = false; return proposal; });
$('confirm').onclick = () => run(async () => { const data = await call('/api/appointments/confirm', {confirmation_id:proposal.confirmation_id, idempotency_key:changeKey}); clearProposal(); return data; });
$('reject').onclick = () => run(async () => { const data = await call('/api/appointments/reject', {confirmation_id:proposal.confirmation_id}); clearProposal(); return data; });
$('handoff').onclick = () => run(async () => { if (!handoffPending) handoffPending = {issue:$('issue').value, language:$('language').value, summary:$('issue').value, idempotency_key:crypto.randomUUID()}; const data = await call('/api/handoff', handoffPending); handoffPending = null; return data; });
