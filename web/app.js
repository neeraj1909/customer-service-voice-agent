import { Conversation, createRequest, clearPlayback } from './conversation.mjs';
let session = '', proposal = null, changeKey = '', handoffPending = null;
const $ = id => document.getElementById(id);
const result = value => { $('result').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
const call = createRequest({getSession: () => session});
function clearProposal() { proposal = null; changeKey = ''; $('confirm').disabled = true; $('reject').disabled = true; $('proposal').textContent = 'No change proposed.'; }
async function run(fn) { try { result(await fn()); } catch (error) { result(error.definitive ? `Request rejected: ${error.message}. No change was made; correct the input.` : `Request was not confirmed: ${error.message}. If the connection was interrupted, the outcome may be unknown; retry the same request.`); } }
$('start').onclick = () => run(async () => { const data = await call('/api/sessions', {customer_id:$('customer').value}); session = data.session_id; handoffPending = null; clearProposal(); conversation.reset(); conversation.setLanguage($('conversation-language').value); transcript.replaceChildren(); lastAssistant = ''; invalidateTranscript(); invalidateSynthesis(); return `Session started for ${data.customer_id}.`; });
$('lookup').onclick = () => run(() => call('/api/order', {order_id:$('order').value}));
$('slots').onclick = () => run(() => call('/api/appointments/slots', {appointment_id:$('appointment').value}));
$('propose').onclick = () => run(async () => { const nextProposal = await call('/api/appointments/propose', {appointment_id:$('appointment').value, slot_id:$('slot').value}); clearProposal(); proposal = nextProposal; if (proposal.no_op) { clearProposal(); return 'Appointment already uses that slot; no change was made.'; } changeKey = crypto.randomUUID(); $('proposal').textContent = `Move ${proposal.appointment_id} from ${proposal.original_slot} to ${proposal.slot_id} at ${proposal.time_utc}?`; $('confirm').disabled = false; $('reject').disabled = false; return proposal; });
$('confirm').onclick = () => run(async () => { const data = await call('/api/appointments/confirm', {confirmation_id:proposal.confirmation_id, idempotency_key:changeKey}); clearProposal(); return data; });
$('reject').onclick = () => run(async () => { const data = await call('/api/appointments/reject', {confirmation_id:proposal.confirmation_id}); clearProposal(); return data; });
$('handoff').onclick = () => run(async () => { if (!handoffPending) handoffPending = {issue:$('issue').value, language:$('language').value, summary:$('issue').value, idempotency_key:crypto.randomUUID()}; try { const data = await call('/api/handoff', handoffPending); handoffPending = null; return data; } catch (error) { if (error.definitive) handoffPending = null; else if (error.uncertain) error.message += ` Pending local handoff issue: ${handoffPending.issue}`; throw error; } });

const transcript = $('conversation-log');
let lastAssistant = '', audioUrl = '';
function say(speaker, message) { const p = document.createElement('p'); p.textContent = `${speaker}: ${message}`; transcript.appendChild(p); if (speaker === 'Assistant') { invalidateSynthesis(); lastAssistant = message; } }
const conversation = new Conversation({request:call, say:message => say('Assistant', message)});
$('conversation-language').onchange = () => conversation.setLanguage($('conversation-language').value);
$('conversation-form').onsubmit = async event => {
  event.preventDefault();
  const input = $('conversation-input');
  const value = input.value.trim();
  if (!value) return;
  input.value = '';
  copiedTranscript = false;
  say('You', value);
  $('conversation-submit').disabled = true;
  try { await conversation.send(value); $('conversation-language').value = conversation.language; } finally { $('conversation-submit').disabled = false; input.focus(); }
};

const audioStatus = message => { $('audio-status').textContent = message; };
let transcriptVersion = 0, synthesisVersion = 0, transcriptReady = false, copiedTranscript = false;
let pendingTranscription = null, pendingSynthesis = null;
function invalidateTranscript() {
  transcriptVersion++;
  transcriptReady = false;
  $('audio-transcript').value = '';
  if (copiedTranscript) $('conversation-input').value = '';
  copiedTranscript = false;
  if (pendingTranscription) pendingTranscription.abort();
}
function invalidateSynthesis() {
  synthesisVersion++;
  audioUrl = clearPlayback($('audio-playback'), audioUrl);
  if (pendingSynthesis) pendingSynthesis.abort();
}
$('audio-file').onchange = () => { invalidateTranscript(); audioStatus('Audio file changed; transcribe the new file before copying.'); };
$('audio-language').onchange = () => { invalidateTranscript(); audioStatus('Recognition language changed; transcribe again before copying.'); };
$('audio-voice').onchange = () => { invalidateSynthesis(); audioStatus('Voice changed; generate new response audio.'); };
$('audio-transcribe').onclick = async () => {
  invalidateTranscript();
  const file = $('audio-file').files[0];
  if (!file || file.size > 8 * 1024 * 1024) { audioStatus('Choose a WAV file of at most 8 MiB.'); return; }
  $('audio-transcribe').disabled = true;
  const originalSession = session, originalLanguage = $('audio-language').value, version = transcriptVersion;
  const controller = new AbortController();
  pendingTranscription = controller;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 65000);
  audioStatus('Transcription in progress; please wait.');
  try {
    const response = await fetch('/api/audio/transcribe', {method:'POST', headers:{'Content-Type':'audio/wav', 'X-Session':originalSession, 'X-Audio-Language':originalLanguage}, body:file, signal:controller.signal});
    const data = await response.json();
    if (version !== transcriptVersion || session !== originalSession || $('audio-file').files[0] !== file || $('audio-language').value !== originalLanguage) return;
    if (!response.ok) throw new Error(data.error || 'audio_unavailable');
    $('audio-transcript').value = data.text;
    transcriptReady = true;
    audioStatus('Transcription complete. Review and edit it before copying it to the command input. Nothing has been submitted.');
  } catch (error) {
    if (version === transcriptVersion) audioStatus(timedOut ? 'Transcription timed out. Nothing was submitted.' : `Transcription unavailable: ${error.message}. Nothing was submitted.`);
  } finally {
    clearTimeout(timeout);
    if (pendingTranscription === controller) pendingTranscription = null;
    $('audio-transcribe').disabled = false;
  }
};
$('audio-use').onclick = () => {
  if (!transcriptReady || !$('audio-transcript').value.trim()) { audioStatus('Transcribe the current file before copying its transcript.'); return; }
  $('conversation-input').value = $('audio-transcript').value;
  copiedTranscript = true;
  $('conversation-input').focus();
  audioStatus('Transcript copied. Review it and press Send to submit; nothing has been submitted yet.');
};
$('audio-synthesize').onclick = async () => {
  invalidateSynthesis();
  if (!lastAssistant) { audioStatus('There is no assistant response to synthesize yet.'); return; }
  $('audio-synthesize').disabled = true;
  const originalSession = session, originalResponse = lastAssistant, originalVoice = $('audio-voice').value, version = synthesisVersion;
  const controller = new AbortController();
  pendingSynthesis = controller;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 25000);
  audioStatus('Generating local response audio; please wait.');
  try {
    const response = await fetch('/api/audio/synthesize', {method:'POST', headers:{'Content-Type':'application/json', 'X-Session':originalSession}, body:JSON.stringify({text:originalResponse, language:originalVoice}), signal:controller.signal});
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'audio_unavailable'); }
    const blob = await response.blob();
    if (version !== synthesisVersion || session !== originalSession || lastAssistant !== originalResponse || $('audio-voice').value !== originalVoice) return;
    audioUrl = URL.createObjectURL(blob);
    $('audio-playback').src = audioUrl;
    audioStatus('Local response audio generated. Use the player to listen.');
  } catch (error) {
    if (version === synthesisVersion) audioStatus(timedOut ? 'Local synthesis timed out.' : `Local synthesis unavailable: ${error.message}.`);
  } finally {
    clearTimeout(timeout);
    if (pendingSynthesis === controller) pendingSynthesis = null;
    $('audio-synthesize').disabled = false;
  }
};
