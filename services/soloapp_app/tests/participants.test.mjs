import assert from 'node:assert/strict';
import test from 'node:test';
import { Participants } from '../public/client/participants.js';

const message = (admin) => ({
  type: 'participants',
  admin,
  players: [
    { id: 1, email: 'a@gmail.com', ping: 14.4, fps: 90.2 },
    { id: 2, email: 'member@example.test', ping: null, fps: null },
  ],
});
test('administrator sees all sessions, own metrics and unknown values', () => {
  const roster = new Participants();
  roster.accept(message(true), 100);
  assert.equal(roster.rows(101).length, 2);
  assert.deepEqual(roster.rows(101)[0], {
    id: 1,
    email: 'a@gmail.com',
    ping: 14,
    fps: 90,
  });
  assert.equal(roster.rows(101)[1].fps, null);
  assert.match(roster.text(101), /member@example.test · — мс · — FPS/);
  assert.equal(roster.rows(5100)[0].fps, null, 'stale server messages expire');
});
test('regular account keeps email labels but never retains other metrics', () => {
  const roster = new Participants();
  roster.accept(message(false), 100);
  assert.equal(roster.label(2), 'member@example.test');
  assert.equal(roster.players.get(1).fps, null);
  assert.deepEqual(roster.rows(101), []);
  assert.equal(roster.text(101), '');
});
test('disconnect, account switch and participant departure clear previous data', () => {
  const roster = new Participants();
  roster.accept(message(true), 100);
  roster.accept({ ...message(true), players: [message(true).players[0]] }, 200);
  assert.equal(roster.players.has(2), false);
  roster.reset();
  assert.equal(roster.admin, false);
  assert.equal(roster.players.size, 0);
  assert.equal(roster.label(1), 'Участник');
  roster.accept(message(false), 300);
  assert.deepEqual(roster.rows(301), []);
});
test('malformed and unsupported metrics stay unknown', () => {
  const roster = new Participants();
  roster.accept(
    { admin: true, players: [{ id: 1, email: '', fps: -1, ping: Infinity }] },
    1,
  );
  assert.equal(roster.rows(2)[0].fps, null);
  assert.equal(roster.rows(2)[0].ping, null);
  assert.equal(roster.label(1), 'Участник');
});
