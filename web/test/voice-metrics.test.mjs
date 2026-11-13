import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceMetrics} from '../voice-metrics.mjs';

test('reports measured baseline intervals without retaining turn content', () => {
  let time = 100;
  const metrics = new VoiceMetrics('baseline', () => time);
  const id = metrics.begin();
  time = 110; metrics.mark(id, 'vad_stopped');
  time = 150; metrics.mark(id, 'transcript_complete');
  time = 155; metrics.mark(id, 'scope_request');
  time = 175; metrics.mark(id, 'scope_result');
  time = 185; metrics.mark(id, 'response_requested');
  time = 235; metrics.mark(id, 'output_started');
  const result = metrics.finish(id, 'success');
  assert.equal(result.arm, 'baseline');
  assert.equal(result.measurement, 'automatic');
  assert.equal(result.intervals_ms.vad_stop_to_transcript_complete, 40);
  assert.equal(result.intervals_ms.scope_request_to_result, 20);
  assert.equal(result.intervals_ms.response_request_to_output_started, 50);
  assert.equal(result.intervals_ms.utterance_end_to_first_audible, null);
  assert.equal(JSON.stringify(result).includes('transcript text'), false);
  assert.equal(metrics.finish(id, 'success'), null);
});

test('missing, repeated and out-of-order events are never invented or clamped', () => {
  let time = 0;
  const metrics = new VoiceMetrics('live', () => time);
  const id = metrics.begin();
  time = 40; metrics.mark(id, 'output_started');
  time = 50; metrics.mark(id, 'vad_stopped');
  assert.equal(metrics.mark(id, 'vad_stopped'), false);
  assert.equal(metrics.mark(id, 'secret transcript text'), false);
  const result = metrics.finish(id, 'timeout');
  assert.equal(result.intervals_ms.vad_stop_to_output_started, null);
  assert.ok(result.invalid_intervals.includes('vad_stop_to_output_started'));
  assert.equal(result.intervals_ms.scope_request_to_result, null);
  assert.equal(result.outcome, 'timeout');
  assert.equal(JSON.stringify(result).includes('secret transcript text'), false);
});

test('independent in-flight attempts remain separate and support audible markers', () => {
  let time = 1;
  const metrics = new VoiceMetrics('live', () => time);
  const first = metrics.begin();
  time = 2; const second = metrics.begin();
  time = 3; metrics.mark(first, 'utterance_end');
  time = 5; metrics.mark(second, 'utterance_end');
  time = 8; metrics.mark(first, 'first_audible');
  time = 9; metrics.mark(first, 'first_useful_audible');
  time = 12; metrics.mark(second, 'first_audible');
  assert.equal(metrics.finish(first, 'success').intervals_ms.utterance_end_to_first_useful_audible, 6);
  assert.equal(metrics.finish(second, 'success').intervals_ms.utterance_end_to_first_audible, 7);
});
