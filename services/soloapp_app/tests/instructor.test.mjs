import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  InstructorSession,
  VoiceActivity,
  quickStartLines,
} from '../public/client/instructor-session.js';

function fixture(lines = ['Первая фраза.', 'Вторая фраза.']) {
  let now = 0;
  const displayed = [],
    sent = [];
  const session = new InstructorSession({
    lines,
    clock: () => now,
    publish: (state) => sent.push(structuredClone(state)),
    present: (state) => displayed.push(structuredClone(state)),
    sessionId: () => 'test-session',
  });
  return {
    session,
    displayed,
    sent,
    time: (n) => {
      now = n;
    },
    tick: (n, leader = true, members = new Set([0, 1, 2])) => {
      now = n;
      session.tick(leader, members);
    },
  };
}

test('deployed QUICK_START matches the canonical document and excludes unfilled examples', () => {
  const canonical = readFileSync(
    new URL('../../../docs/QUICK_START.md', import.meta.url),
    'utf8',
  );
  const deployed = readFileSync(
    new URL('../public/assets/training/QUICK_START.md', import.meta.url),
    'utf8',
  );
  assert.equal(canonical, deployed);
  const lines = quickStartLines(canonical);
  assert(lines.length > 45);
  assert(lines.some((line) => line.includes('Перед нами общая панель')));
  assert(lines.some((line) => line.includes('Турбины используют пар')));
  assert(lines.some((line) => line.includes('АЗ-5')));
  assert(
    lines.every((line) => !/[[\]|#]/.test(line) && !line.includes('.md')),
  );
  assert(lines.every((line) => line.length <= 600));
  assert.deepEqual(
    quickStartLines(
      '> Первый текст.\n> Продолжение.\n\n[Указание]\n| Панель | «Реплика». |\n> [значение]',
    ),
    ['Первый текст.', 'Продолжение.', 'Реплика'],
  );
});

test('first entry waits five seconds; phrases advance once and finish', () => {
  const f = fixture();
  f.tick(4999);
  assert.equal(f.session.state, null);
  f.tick(5000);
  assert.equal(f.session.state.text, 'Первая фраза.');
  const revision = f.session.state.revision;
  f.session.finished(revision);
  f.session.finished(revision); // repeated/stale TTS callbacks cannot skip a phrase
  f.tick(5800);
  assert.equal(f.session.state.text, 'Вторая фраза.');
  f.session.finished(f.session.state.revision);
  f.tick(6600);
  assert.equal(f.session.state.kind, 'done');
  f.tick(100000);
  assert.equal(f.session.state.kind, 'done');
});

test('late participant adopts current phrase; follower cannot advance; leader handoff retains cursor', () => {
  const a = fixture(),
    b = fixture();
  a.tick(5000);
  a.session.finished(a.session.state.revision);
  a.tick(5800);
  b.time(8000);
  assert(b.session.receive(a.session.snapshot(), false)); // initial catch-up can come from prior leader
  assert.equal(b.session.state.index, 1);
  const revision = b.session.state.revision;
  b.tick(8000, false);
  b.session.finished(revision);
  assert.equal(b.session.state.revision, revision);
  b.tick(8001, true);
  b.session.finished(revision);
  b.tick(8801);
  assert.equal(b.session.state.kind, 'done');
  assert(a.session.receive(b.session.snapshot(), true));
  assert.equal(a.session.state.kind, 'done');
  const count = a.displayed.length;
  a.session.receive(b.session.snapshot(), true);
  assert.equal(a.displayed.length, count, 'heartbeats do not repeat speech');
});

test('voice interrupts, waits for all speakers, comments and resumes interrupted sentence', () => {
  const f = fixture();
  f.tick(5000);
  f.session.voice(1, true);
  f.tick(5200);
  assert.equal(f.session.state.kind, 'listening');
  f.session.voice(2, true);
  f.session.voice(1, false);
  f.tick(5400);
  assert.equal(f.session.state.kind, 'listening');
  f.session.voice(2, false);
  f.tick(6400);
  assert.equal(f.session.state.kind, 'listening');
  f.tick(6600);
  assert.equal(f.session.state.kind, 'comment');
  assert(f.session.state.text.includes('номер 2'));
  f.session.finished(f.session.state.revision);
  f.tick(7400);
  assert.equal(f.session.state.text, 'Первая фраза.');
});

test('lost stop packet and disconnected speaker do not block narration indefinitely', () => {
  const f = fixture();
  f.tick(5000);
  f.session.voice(1, true);
  f.tick(5200);
  f.tick(8000);
  assert.equal(f.session.state.kind, 'comment');
  f.session.voice(2, true);
  f.tick(8100);
  f.tick(9500, true, new Set([0]));
  assert.equal(f.session.state.kind, 'comment');
});

test('rapid control changes are coalesced, spoken after the participant and do not skip intro', () => {
  const f = fixture();
  f.tick(5000);
  for (let value = 1; value <= 30; value++)
    f.session.control(`Задание: ${value}`, 'участник #1');
  f.tick(5500);
  assert.equal(f.session.state.kind, 'intro');
  f.session.voice(1, true);
  f.tick(5600);
  f.session.voice(1, false);
  f.tick(6800);
  assert(f.session.state.text.includes('спасибо'));
  f.session.finished(f.session.state.revision);
  f.tick(11800);
  assert(f.session.state.text.includes('Задание: 30'));
  f.session.finished(f.session.state.revision);
  f.tick(12600);
  assert.equal(f.session.state.text, 'Первая фраза.');
});

test('caption deadlines advance without audio and re-entry starts a fresh session', () => {
  const f = fixture(['Одна фраза.']);
  f.tick(5000);
  f.tick(10000);
  f.tick(10800);
  assert.equal(f.session.state.kind, 'done');
  f.session.reset();
  f.tick(15799);
  assert.equal(f.session.state, null);
  f.tick(15800);
  assert.equal(f.session.state.kind, 'intro');
});

test('reject malformed/stale/nonleader snapshots, converge to elected leader after split', () => {
  const f = fixture();
  f.tick(5000);
  const current = f.session.snapshot();
  for (const bad of [
    { ...current, index: -1 },
    { ...current, remaining: Infinity },
    { ...current, text: 'x'.repeat(601) },
    { ...current, kind: 'execute' },
    { ...current, revision: 0 },
  ])
    assert.equal(f.session.receive(bad, true), false);
  assert.equal(f.session.receive({ ...current, revision: 20 }, false), false);
  assert(
    f.session.receive(
      { ...current, session: 'elected-peer', revision: 20 },
      true,
    ),
  );
  assert.equal(
    f.session.receive(
      { ...current, session: 'elected-peer', revision: 19 },
      true,
    ),
    false,
  );
});

test('activity detector ignores clicks and holds speech across short pauses', () => {
  const activity = new VoiceActivity();
  assert.equal(activity.sample(0.1, 0.05), false);
  assert.equal(activity.sample(0, 0.2), false);
  assert.equal(activity.sample(0.03, 0.2), true);
  assert.equal(activity.sample(0, 0.6), true);
  assert.equal(activity.sample(0, 0.2), false);
});

test('new leader does not thank a participant twice for a completed voice turn', () => {
  const a = fixture(),
    b = fixture();
  a.tick(5000);
  b.session.receive(a.session.snapshot(), true);
  for (const f of [a, b]) {
    f.session.voice(1, true);
    f.session.voice(1, false);
  }
  a.tick(5100);
  b.time(5100);
  b.session.receive(a.session.snapshot(), true);
  b.tick(5200, true);
  assert.equal(b.session.state.revision, a.session.state.revision);
});
