import assert from 'node:assert/strict';
import {
  EngineerSession,
  nearEngineer,
  ENGINEER_POSITION,
  QUESTION_RADIUS,
} from '../public/client/engineer-session.js';
import { REACTOR_MAP } from '../public/shared/room.js';
import {
  ProfessorVoiceTurn,
  askEngineer,
} from '../public/client/professor-voice.js';

let now = 0;
const a = new EngineerSession(() => now),
  b = new EngineerSession(() => now);
const members = new Set([1, 2]);
const message = (turn, stage = 'listening', text = '') => ({
  turn,
  stage,
  text,
});
a.receive(2, message('two'));
a.receive(1, message('one'));
b.receive(1, message('one'));
b.receive(2, message('two'));
assert.equal(a.owner(members), 1);
assert.equal(
  b.owner(members),
  1,
  'Simultaneous questions converge regardless of arrival order',
);
a.receive(1, message('old', 'idle'));
assert.equal(
  a.owner(members),
  1,
  'A stale cancellation cannot cancel a newer turn',
);
a.receive(1, message('one', 'idle'));
assert.equal(a.owner(members), 2);
now = 7000;
a.receive(2, message('two', 'answer', 'Ответ'));
now = 9000;
assert.equal(a.owner(members), 2, 'Heartbeat renews the answer lease');
now = 15001;
assert.equal(
  a.owner(members),
  null,
  'Disconnected or hidden speaker cannot lock the engineer',
);
a.receive(1, message('new'));
assert.equal(a.owner(new Set([2])), null);
assert.equal(a.receive(1, message('bad', 'unknown')), false);
assert.equal(a.receive(1, message('bad', 'answer', 'x'.repeat(1201))), false);
assert.equal(a.receive(NaN, message('bad')), false);
assert(
  nearEngineer(
    { map: REACTOR_MAP, position: ENGINEER_POSITION },
    QUESTION_RADIUS,
  ),
);
assert(
  !nearEngineer(
    { map: 'surface', position: ENGINEER_POSITION },
    QUESTION_RADIUS,
  ),
);
assert(
  !nearEngineer({ map: REACTOR_MAP, position: [NaN, 0, 0] }, QUESTION_RADIUS),
);
assert(
  !nearEngineer(
    { map: REACTOR_MAP, position: [3.95, 0, 10.1] },
    QUESTION_RADIUS,
  ),
);

let requests = 0,
  claims = 0,
  released = 0,
  allowed = false;
const voice = new Float32Array(8000).fill(0.1),
  silence = new Float32Array(16000);
const turn = new ProfessorVoiceTurn({
  onSpeechStart: () => {
    claims++;
    return allowed;
  },
  request: async () => {
    requests++;
    return {};
  },
  onResult() {},
  onError(error) {
    throw error;
  },
  onState(state) {
    if (!state) released++;
  },
});
turn.push(voice);
turn.push(silence);
await turn.chain;
assert.equal(requests, 0, 'Busy engineer does not upload a second question');
allowed = true;
turn.push(new Float32Array(320).fill(0.1));
turn.push(silence);
assert.equal(requests, 0);
assert.equal(released, 1, 'Brief noise releases its claim');
turn.push(voice);
turn.push(silence);
await turn.chain;
assert.equal(requests, 1);
assert.equal(released, 2);
assert(claims > 0);

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/v1/soloapp_app/v1/engineer/respond');
    assert.equal(options.headers.Authorization, 'Bearer test-session');
    assert.equal(options.headers['Content-Type'], 'audio/wav');
    assert.equal(new DataView(options.body).getUint32(24, true), 16000);
    return new Response(
      JSON.stringify({
        transcript: 'Вопрос',
        answer: 'Ответ',
        audio_base64: '',
      }),
    );
  };
  assert.equal(
    (await askEngineer(voice, 'test-session', new AbortController().signal))
      .answer,
    'Ответ',
  );
} finally {
  globalThis.fetch = originalFetch;
}
console.log(
  'Engineer proximity, contention, lease recovery, voice gating and authenticated WAV request: OK',
);
