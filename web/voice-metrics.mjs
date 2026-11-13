// Client-observed timestamps only. Provider output-start events are not proof of
// audible playback; callers must mark audible events from a measured boundary.
const INTERVALS = {
  vad_stop_to_transcript_complete: ['vad_stopped', 'transcript_complete'],
  scope_request_to_result: ['scope_request', 'scope_result'],
  delete_request_to_ack: ['delete_request', 'delete_ack'],
  response_request_to_output_started: ['response_requested', 'output_started'],
  vad_stop_to_output_started: ['vad_stopped', 'output_started'],
  tool_request_to_result: ['tool_request', 'tool_result'],
  utterance_end_to_first_audible: ['utterance_end', 'first_audible'],
  utterance_end_to_first_useful_audible: ['utterance_end', 'first_useful_audible'],
};
const EVENTS = new Set(Object.values(INTERVALS).flat());
const OUTCOMES = new Set(['success', 'error', 'timeout', 'cancelled']);

export class VoiceMetrics {
  constructor(arm, clock = () => performance.now()) {
    if (!['baseline', 'live'].includes(arm)) throw new Error('Unknown voice comparison arm');
    this.arm = arm;
    this.clock = clock;
    this.nextId = 0;
    this.attempts = new Map();
  }

  begin() {
    const start = this.clock();
    if (!Number.isFinite(start)) throw new Error('Monotonic clock unavailable');
    const id = ++this.nextId;
    this.attempts.set(id, {start, events: {}});
    return id;
  }

  mark(id, event) {
    const attempt = this.attempts.get(id);
    if (!attempt || !EVENTS.has(event) || Object.hasOwn(attempt.events, event)) return false;
    const now = this.clock();
    if (!Number.isFinite(now)) return false;
    attempt.events[event] = now - attempt.start;
    return true;
  }

  finish(id, outcome) {
    const attempt = this.attempts.get(id);
    if (!attempt || !OUTCOMES.has(outcome)) return null;
    this.attempts.delete(id);
    const intervals = {};
    const invalid = [];
    for (const [name, [start, end]] of Object.entries(INTERVALS)) {
      const a = attempt.events[start], b = attempt.events[end];
      if (a === undefined || b === undefined) intervals[name] = null;
      else if (a < 0 || b < a) { intervals[name] = null; invalid.push(name); }
      else intervals[name] = b - a;
    }
    return {arm: this.arm, measurement: 'automatic', outcome, events_ms: attempt.events, intervals_ms: intervals, invalid_intervals: invalid};
  }
}
