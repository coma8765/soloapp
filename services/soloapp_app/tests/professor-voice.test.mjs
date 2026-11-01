import assert from 'node:assert/strict';
import { ProfessorVoiceTurn } from '../public/client/professor-voice.js';
const voice = new Float32Array(8000).fill(0.1);
const silence = new Float32Array(16000);
let requests = 0,
  results = 0,
  unblock;
const errors = [];
const turn = new ProfessorVoiceTurn({
  request: async (samples) => {
    requests++;
    assert(samples.length <= 128000);
    await new Promise((r) => {
      unblock = r;
    });
    return { answer: 'test' };
  },
  onResult: () => results++,
  onError: (e) => errors.push(e),
});
turn.push(silence);
assert.equal(requests, 0);
turn.push(voice);
turn.push(silence);
await Promise.resolve();
assert.equal(requests, 1);
turn.push(voice);
turn.push(silence);
assert.equal(requests, 1, 'No recording during inference/playback');
unblock();
await turn.chain;
assert.equal(results, 1);
turn.push(voice);
turn.push(silence);
await Promise.resolve();
turn.cancel();
unblock();
await turn.chain;
assert.equal(results, 1, 'Cancelled turn cannot play stale reply');
assert.equal(errors.length, 0);
let oversized;
const cap = new ProfessorVoiceTurn({
  request: async (s) => {
    oversized = s.length;
    return {};
  },
  onResult() {},
  onError(e) {
    throw e;
  },
});
cap.push(new Float32Array(200000).fill(0.1));
await cap.chain;
assert.equal(oversized, 128000);
let failed = false;
const recovery = new ProfessorVoiceTurn({
  request: async () => {
    throw Error('offline');
  },
  onResult() {},
  onError() {
    failed = true;
  },
});
recovery.push(voice);
await recovery.finish();
assert(failed);
assert.equal(recovery.busy, false);
console.log(
  'Professor VAD, bounded turns, backpressure, cancellation and error recovery: OK',
);
