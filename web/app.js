import { Conversation, createRequest, clearPlayback, orderExamples } from './conversation.mjs';
import { RealtimeVoice } from './realtime-voice.mjs';
import { LiveVoice } from './live-voice.mjs';
import { VoiceMetrics } from './voice-metrics.mjs';
let session = '', proposal = null, changeKey = '', handoffPending = null;
const $ = id => document.getElementById(id);
const result = value => { $('result').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
const call = createRequest({getSession: () => session});
function clearProposal() { proposal = null; changeKey = ''; $('confirm').disabled = true; $('reject').disabled = true; $('proposal').textContent = 'No change proposed.'; }
let activeRequests = 0;
function setBusy(change) { activeRequests += change; $('customer').disabled = activeRequests > 0; $('start').disabled = activeRequests > 0; }
let voice = null, voiceBusy = false;
const voiceRecords = [], voiceRecordCounts = new Map();
const measureControls = ['voice-measure-begin','voice-measure-end-speech','voice-measure-audible','voice-measure-useful','voice-measure-finish','voice-measure-timeout','voice-measure-error'];
function disableMeasureControls() { for (const id of measureControls) $(id).disabled = true; }
const voiceStatus = message => { $('voice-status').textContent = message; };
function releaseVoiceBusy() { if (voiceBusy) { voiceBusy = false; setBusy(-1); } }
function resetVoiceControls() { $('voice-restart').hidden = true; $('voice-restart').textContent = 'Pause'; $('voice-mute').disabled = true; $('voice-mute').textContent = 'Mute microphone'; $('voice-mute').setAttribute('aria-pressed', 'false'); $('voice-language').disabled = false; $('voice-mode').disabled = false; for (const id of ['voice-metrics','voice-case-id','voice-run-id']) $(id).disabled = false; disableMeasureControls(); }
$('voice-start').onclick = async () => {
  if (!session) { voiceStatus('Start a fictional customer session first.'); return; }
  if (voiceBusy || voice?.callId) return;
  const arm = $('voice-mode').value === 'live' ? 'live' : 'baseline';
  const capture = $('voice-metrics').checked, caseId = $('voice-case-id').value.trim(), runId = $('voice-run-id').value.trim();
  if (capture && (![caseId, runId].every(id => /^[A-Za-z0-9_-]{1,40}$/.test(id)))) { voiceStatus('For timing capture, enter case and run IDs using letters, numbers, hyphens or underscores.'); return; }
  voiceBusy = true; setBusy(1);
  $('voice-start').disabled = true; $('voice-stop').disabled = false; $('voice-language').disabled = true; $('voice-mode').disabled = true;
  for (const id of ['voice-metrics','voice-case-id','voice-run-id']) $(id).disabled = true;
  const Voice = arm === 'live' ? LiveVoice : RealtimeVoice;
  const metric = record => {
    const type = record.measurement === 'operator_estimated' ? 'manual' : 'auto';
    const key = `${arm}:${caseId}:${runId}:${type}`;
    const sequence = (voiceRecordCounts.get(key) ?? 0) + 1;
    voiceRecordCounts.set(key, sequence);
    voiceRecords.push({...record, case_id:caseId, run_id:`${runId}-${type}-${sequence}`, quality:{scope:'unreviewed', task:'unreviewed'}});
    $('voice-export').disabled = false;
  };
  voice = new Voice({session, request:call, audio:$('voice-playback'), language:$('voice-language').value, status:voiceStatus, metrics:capture ? new VoiceMetrics(arm) : null, metric,
    paused: isPaused => { $('voice-restart').textContent = isPaused ? 'Resume' : 'Pause'; $('voice-mute').disabled = isPaused; },
    ended: closed => { if (closed) { releaseVoiceBusy(); resetVoiceControls(); $('voice-stop').disabled = true; $('voice-start').disabled = false; } else $('voice-stop').disabled = false; }});
  try { if (await voice.start()) { $('voice-mute').disabled = voice.isPaused; $('voice-restart').textContent = voice.isPaused ? 'Resume' : 'Pause'; $('voice-restart').hidden = false; $('voice-measure-begin').disabled = !capture; } }
  catch (error) { voiceStatus(`Voice could not start: ${error.message}`); if (!voice.callId) { releaseVoiceBusy(); resetVoiceControls(); $('voice-stop').disabled = true; $('voice-start').disabled = false; } }
};
$('voice-measure-begin').onclick = () => { if (voice?.beginMeasurement()) { disableMeasureControls(); $('voice-measure-end-speech').disabled = false; $('voice-measure-timeout').disabled = false; $('voice-measure-error').disabled = false; } };
$('voice-measure-end-speech').onclick = () => { if (voice?.markMeasurement('utterance_end')) { $('voice-measure-end-speech').disabled = true; $('voice-measure-audible').disabled = false; } };
$('voice-measure-audible').onclick = () => { if (voice?.markMeasurement('first_audible')) { $('voice-measure-audible').disabled = true; $('voice-measure-useful').disabled = false; $('voice-measure-finish').disabled = false; } };
$('voice-measure-useful').onclick = () => { if (voice?.markMeasurement('first_useful_audible')) $('voice-measure-useful').disabled = true; };
$('voice-measure-finish').onclick = () => { voice?.finishMeasurement('success'); disableMeasureControls(); $('voice-measure-begin').disabled = false; };
for (const outcome of ['timeout', 'error']) $(`voice-measure-${outcome}`).onclick = () => { voice?.finishMeasurement(outcome); disableMeasureControls(); $('voice-measure-begin').disabled = false; };
$('voice-export').onclick = () => {
  if (!voiceRecords.length) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(voiceRecords, null, 2)], {type:'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = 'mira-voice-timings.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};
$('voice-restart').onclick = async () => {
  $('voice-restart').disabled = true;
  try { if (voice?.isPaused) await voice.restart(); else await voice?.pause(); }
  catch (error) { voiceStatus(`Voice could not ${voice?.isPaused ? 'resume' : 'pause'}: ${error.message}`); }
  finally { $('voice-restart').disabled = false; }
};
$('voice-mute').onclick = () => {
  const muted = $('voice-mute').getAttribute('aria-pressed') !== 'true';
  if (voice?.setMicrophoneMuted(muted)) { $('voice-mute').setAttribute('aria-pressed', String(muted)); $('voice-mute').textContent = muted ? 'Unmute microphone' : 'Mute microphone'; }
};
$('voice-stop').onclick = async () => {
  $('voice-stop').disabled = true;
  try { await voice?.stop(); voiceStatus('Voice call ended.'); releaseVoiceBusy(); resetVoiceControls(); $('voice-start').disabled = false; }
  catch (error) { voiceStatus(error.message); $('voice-stop').disabled = false; }
};
globalThis.addEventListener?.('pagehide', () => { if (voice) void voice.stop().catch(() => {}); });
async function run(fn) { setBusy(1); try { result(await fn()); } catch (error) { result(error.definitive ? `Request rejected: ${error.message}. No change was made; correct the input.` : `Request was not confirmed: ${error.message}. If the connection was interrupted, the outcome may be unknown; retry the same request.`); } finally { setBusy(-1); } }
$('start').onclick = () => run(async () => { const data = await call('/api/sessions', {customer_id:$('customer').value}); session = data.session_id; handoffPending = null; clearProposal(); conversation.reset(); conversation.setLanguage($('conversation-language').value); transcript.replaceChildren(); lastAssistant = ''; invalidateTranscript(); invalidateSynthesis(); const examples = orderExamples(data.customer_id); $('session-examples').textContent = `Active fictional customer: ${data.customer_id}. Example order IDs for a fresh database: ${examples.join(', ')}. Existing databases may differ; look up an ID to check its status.`; $('order').value = examples[0] || ''; $('appointment').value = data.customer_id === 'cust-a' ? 'appt-a-1' : 'appt-b-1'; return `Session started for ${data.customer_id}.`; });
$('lookup').onclick = () => run(() => call('/api/order-details', {order_id:$('order').value}));
$('orders-history').onclick = () => run(() => call('/api/orders', {}));
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
  setBusy(1);
  try { await conversation.send(value); $('conversation-language').value = conversation.language; } finally { setBusy(-1); $('conversation-submit').disabled = false; input.focus(); }
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
  const commandSection = $('conversation-input').closest?.('details');
  if (commandSection) commandSection.open = true;
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
