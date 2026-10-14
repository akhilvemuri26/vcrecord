import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudio, audioRms, EMPTY_TRANSCRIPT_MESSAGE } from '../src/audio-analysis.ts';

test('missing PCM is distinct from exact zero input', () => {
  assert.equal(analyzeAudio().kind, 'missing');
  assert.match(analyzeAudio(new Float32Array()).message, /not captured/);
  assert.equal(analyzeAudio(new Float32Array(16000)).kind, 'silent');
  assert.match(analyzeAudio(new Float32Array(1)).message, /input was silent/);
});

test('quiet nonzero and brief audio surrounded by silence remain recognition candidates', () => {
  const quiet = new Float32Array([0.000001, -0.000001]);
  assert.ok(audioRms(quiet) < 0.003);
  assert.equal(analyzeAudio(quiet).kind, 'captured');
  const brief = new Float32Array(160000);
  brief[80000] = 0.01;
  assert.ok(audioRms(brief) < 0.003);
  assert.equal(analyzeAudio(brief).kind, 'captured');
  assert.match(EMPTY_TRANSCRIPT_MESSAGE, /No transcript was recognized/);
  assert.doesNotMatch(EMPTY_TRANSCRIPT_MESSAGE, /No speech|silent/);
});
