import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LakeProfessorSync,
  professorDisplay,
} from '../public/client/lake-professor-sync.js';
function setup() {
  let time = 100;
  const sent = [];
  const network = {
    auth: { token: 'test' },
    sequence: 0,
    player: { state: (sequence) => ({ type: 'state', sequence }) },
    send: (message) => {
      sent.push(message);
      return true;
    },
  };
  const sync = new LakeProfessorSync(network, () => time);
  sync.receive({ type: 'professor_welcome', protocol: 1 });
  const state = {
    type: 'professor_state',
    storage: 'postgresql',
    revision: 1,
    serverTime: 10000,
    lakes: Array.from({ length: 4 }, (_, id) => ({
      id,
      owner: 0,
      focus: 0,
      text: '',
      answer: '',
      position: null,
      phase: 'idle',
      startedAt: 0,
      until: 0,
    })),
  };
  sync.receive(state);
  const ack = (message, accepted = true) =>
    sync.receive({
      type: 'professor_ack',
      requestId: message.requestId,
      accepted,
      error: 'busy',
    });
  return {
    sync,
    network,
    sent,
    state,
    ack,
    advance: (ms) => {
      time += ms;
      sync.tick();
    },
  };
}
test('claim precedes expensive question, result acknowledgement precedes local playback', async () => {
  const { sync, sent, ack } = setup();
  let calls = 0,
    complete = false;
  const response = { transcript: 'Вопрос', answer: 'Ответ', audio_base64: '' };
  const request = sync
    .request(
      0,
      async () => {
        calls++;
        return response;
      },
      new AbortController().signal,
    )
    .then((v) => {
      complete = true;
      return v;
    });
  assert.equal(sent[0].type, 'state');
  assert.equal(sent[1].action, 'begin');
  assert.equal(calls, 0);
  ack(sent[1]);
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  assert.equal(sent[2].action, 'result');
  assert.equal(complete, false);
  ack(sent[2]);
  assert.deepEqual(await request, response);
});
test('busy professor never runs the HTTP question and cleans up claim', async () => {
  const { sync, sent, ack } = setup();
  const request = sync.request(
    0,
    () => {
      throw Error('must not call HTTP');
    },
    new AbortController().signal,
  );
  ack(sent[1], false);
  await assert.rejects(request, /другому участнику/);
  assert.equal(sent.at(-1).action, 'cancel');
  ack(sent.at(-1));
});
test('lost acknowledgements retry the identical command and time out', async () => {
  const { sync, sent, advance } = setup();
  const request = sync.command(0, 'turn', 'begin');
  advance(1500);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
  advance(10500);
  await assert.rejects(request, /не подтвердил/);
  assert.equal(sync.pending.size, 0);
});
test('disconnect rejects in-flight work; reconnect waits for a fresh snapshot', async () => {
  const { sync, state } = setup();
  const request = sync.command(0, 'turn', 'begin');
  sync.receive({ type: 'professor_disconnect' });
  await assert.rejects(request, /Нет соединения/);
  assert.equal(sync.record(0), null);
  sync.receive(state);
  assert.equal(sync.record(0), null);
  sync.receive({ type: 'professor_welcome', protocol: 1 });
  await assert.rejects(sync.command(0, 'next', 'begin'), /Ожидание/);
  sync.receive(state);
  assert.equal(sync.record(0).phase, 'idle');
});
test('abort cancels the claim and cannot publish a late HTTP result', async () => {
  const { sync, sent, ack } = setup();
  const abort = new AbortController();
  let done;
  const request = sync.request(
    0,
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
    abort.signal,
  );
  ack(sent[1]);
  await new Promise(setImmediate);
  abort.abort();
  done({ transcript: 'late', answer: 'late' });
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(sent.at(-1).action, 'cancel');
  assert(!sent.some((m) => m.action === 'result'));
  ack(sent.at(-1));
});
test('late join uses the same answer timeline despite a different local clock', () => {
  const a = setup(),
    b = setup();
  b.advance(80000);
  const state = structuredClone(a.state);
  Object.assign(state, { revision: 2, serverTime: 12000 });
  Object.assign(state.lakes[0], {
    owner: 1,
    focus: 1,
    position: [1, 0, 3],
    phase: 'answer',
    text: 'Вопрос',
    answer: 'Ответ',
    startedAt: 11000,
    until: 15000,
  });
  a.sync.receive(state);
  b.sync.receive(state);
  a.advance(200);
  b.advance(200);
  const display = (s) => professorDisplay(s.sync.record(0), s.sync.now());
  assert.deepEqual(display(a), display(b));
  assert.notEqual(display(a).nod, 0);
  a.sync.receive({ ...state, revision: 1, serverTime: 13000 });
  assert.equal(a.sync.state.revision, 2);
  a.sync.receive({ ...state, serverTime: 11900 });
  assert.equal(a.sync.state.serverTime, 12000);
  a.advance(3000);
  assert.equal(display(a).nod, 0);
  assert.equal(display(a).answer, 'Ответ');
});
