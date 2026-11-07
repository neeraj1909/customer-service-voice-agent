import { Conversation, createRequest, clearPlayback } from './conversation.mjs';
let session = '', proposal = null, changeKey = '', handoffPending = null;
const $ = id => document.getElementById(id);
const result = value => { $('result').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
const call = createRequest({getSession: () => session});
function clearProposal() { proposal = null; changeKey = ''; $('confirm').disabled = true; $('reject').disabled = true; $('proposal').textContent = 'No change proposed.'; }
async function run(fn) { try { result(await fn()); } catch (error) { result(error.definitive ? `Request rejected: ${error.message}. No change was made; correct the input.` : `Request was not confirmed: ${error.message}. If the connection was interrupted, the outcome may be unknown; retry the same request.`); } }
$('start').onclick = () => run(async () => { const data = await call('/api/sessions', {customer_id:$('customer').value}); session = data.session_id; handoffPending = null; clearProposal(); conversation.reset(); conversation.setLanguage($('conversation-language').value); transcript.replaceChildren(); lastAssistant = ''; $('audio-transcript').value = ''; audioUrl = clearPlayback($('audio-playback'), audioUrl); return `Session started for ${data.customer_id}.`; });
$('lookup').onclick = () => run(() => call('/api/order', {order_id:$('order').value}));
$('slots').onclick = () => run(() => call('/api/appointments/slots', {appointment_id:$('appointment').value}));
$('propose').onclick = () => run(async () => { const nextProposal = await call('/api/appointments/propose', {appointment_id:$('appointment').value, slot_id:$('slot').value}); clearProposal(); proposal = nextProposal; if (proposal.no_op) { clearProposal(); return 'Appointment already uses that slot; no change was made.'; } changeKey = crypto.randomUUID(); $('proposal').textContent = `Move ${proposal.appointment_id} from ${proposal.original_slot} to ${proposal.slot_id} at ${proposal.time_utc}?`; $('confirm').disabled = false; $('reject').disabled = false; return proposal; });
$('confirm').onclick = () => run(async () => { const data = await call('/api/appointments/confirm', {confirmation_id:proposal.confirmation_id, idempotency_key:changeKey}); clearProposal(); return data; });
$('reject').onclick = () => run(async () => { const data = await call('/api/appointments/reject', {confirmation_id:proposal.confirmation_id}); clearProposal(); return data; });
$('handoff').onclick = () => run(async () => { if (!handoffPending) handoffPending = {issue:$('issue').value, language:$('language').value, summary:$('issue').value, idempotency_key:crypto.randomUUID()}; try { const data = await call('/api/handoff', handoffPending); handoffPending = null; return data; } catch (error) { if (error.definitive) handoffPending = null; else if (error.uncertain) error.message += ` Pending local handoff issue: ${handoffPending.issue}`; throw error; } });

const transcript = $('conversation-log');
let lastAssistant = '', audioUrl = '';
function say(speaker, message) { const p = document.createElement('p'); p.textContent = `${speaker}: ${message}`; transcript.appendChild(p); if (speaker === 'Assistant') { audioUrl = clearPlayback($('audio-playback'), audioUrl); lastAssistant = message; } }
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

const audioStatus = message => { $('audio-status').textContent = message; };
$('audio-transcribe').onclick = async () => {
  const file = $('audio-file').files[0];
  if (!file || file.size > 8 * 1024 * 1024) { audioStatus('Choose a WAV file of at most 8 MiB.'); return; }
  $('audio-transcribe').disabled = true;
  const originalSession = session;
  try {
    const response = await fetch('/api/audio/transcribe', {method:'POST', headers:{'Content-Type':'audio/wav', 'X-Session':session, 'X-Audio-Language':$('audio-language').value}, body:file});
    const data = await response.json();
    if (session !== originalSession) { audioStatus('Session changed; old transcription was discarded.'); return; }
    if (!response.ok) throw new Error(data.error || 'audio_unavailable');
    $('audio-transcript').value = data.text;
    audioStatus('Transcription complete. Review and edit it before copying it to the command input. Nothing has been submitted.');
  } catch (error) { audioStatus(`Transcription unavailable: ${error.message}. Nothing was submitted.`); }
  finally { $('audio-transcribe').disabled = false; }
};
$('audio-use').onclick = () => {
  $('conversation-input').value = $('audio-transcript').value;
  $('conversation-input').focus();
  audioStatus('Transcript copied. Review it and press Send to submit; nothing has been submitted yet.');
};
$('audio-synthesize').onclick = async () => {
  if (!lastAssistant) { audioStatus('There is no assistant response to synthesize yet.'); return; }
  $('audio-synthesize').disabled = true;
  const originalSession = session, originalResponse = lastAssistant;
  try {
    const response = await fetch('/api/audio/synthesize', {method:'POST', headers:{'Content-Type':'application/json', 'X-Session':session}, body:JSON.stringify({text:lastAssistant, language:$('audio-voice').value})});
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'audio_unavailable'); }
    const blob = await response.blob();
    if (session !== originalSession || lastAssistant !== originalResponse) { audioStatus('Session or response changed; old audio was discarded.'); return; }
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(blob);
    $('audio-playback').src = audioUrl;
    audioStatus('Local response audio generated. Use the player to listen.');
  } catch (error) { audioStatus(`Local synthesis unavailable: ${error.message}.`); }
  finally { $('audio-synthesize').disabled = false; }
};
