import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORKER_COUNT,
  WORKER_PERIOD,
  workerPose,
  WorkerClock,
  WorkerProximity,
} from '../public/client/worker-patrol.js';

const posesAt = (time) =>
  Array.from({ length: WORKER_COUNT }, (_, i) => workerPose(i, time));
test('seven distinct workers follow a bounded, continuous, periodic route clear of furniture', () => {
  assert.equal(WORKER_COUNT, 7);
  for (let t = 0; t < WORKER_PERIOD * 1000; t += 100) {
    const poses = posesAt(t);
    poses.forEach((p, i) => {
      assert(Math.abs(p.x) <= 8 && p.z >= 5.3 && p.z <= 9.1);
      // Journal desk ends at z=3.95; copier and chief occupy the inside of the loop.
      assert(Math.hypot(p.x - 5.5, p.z - 7.6) >= 1.49);
      assert(Math.hypot(p.x - 3.95, p.z - 7.5) >= 1.59);
      const next = workerPose(i, t + 10);
      assert(Math.hypot(next.x - p.x, next.z - p.z) <= 0.00701);
      const repeat = workerPose(i, t + WORKER_PERIOD * 1000);
      assert(Math.hypot(repeat.x - p.x, repeat.z - p.z) < 1e-10);
      poses
        .slice(i + 1)
        .forEach((q) => assert(Math.hypot(p.x - q.x, p.z - q.z) > 2));
    });
  }
});

test('late joiners with different system clocks converge on database time and extrapolate', () => {
  let aTime = 1000,
    bTime = 90000;
  const a = new WorkerClock(() => aTime, 12345);
  const b = new WorkerClock(() => bTime, 987654321);
  const stamp = Date.UTC(2026, 10, 1);
  a.sync(stamp);
  b.sync(stamp);
  assert.deepEqual(posesAt(a.now()), posesAt(b.now()));
  aTime += 4300;
  bTime += 4300;
  assert.deepEqual(posesAt(a.now()), posesAt(b.now()));
  assert.equal(a.now(), stamp + 4300);
  // Delayed/repeated/invalid frames must not rewind a live patrol.
  a.sync(stamp + 2000);
  assert.equal(a.now(), stamp + 4300);
  for (const bad of [stamp, undefined, NaN, Infinity, -1, '123', 1.2])
    assert.equal(a.sync(bad), false);
  a.sync(stamp + 4400);
  assert.equal(a.now(), stamp + 4400);
});

test('only nearest worker answers, with hysteresis and individual/global cooldowns', () => {
  const p = new WorkerProximity();
  const poses = [
    { x: 0, z: 0 },
    { x: 1, z: 0 },
  ];
  assert.equal(p.poll(poses, { x: 0, z: 0 }, 1000), 0);
  assert.equal(p.poll(poses, { x: 1, z: 0 }, 2000), null);
  assert.equal(p.poll(poses, { x: 1, z: 0 }, 7000), 1);
  assert.equal(
    p.poll(poses, { x: 0, z: 0 }, 40000),
    null,
    'staying nearby does not repeat',
  );
  p.poll(poses, { x: 0, z: 3 }, 40001);
  assert.equal(p.poll(poses, { x: 0, z: 0 }, 40002), 0);
  p.poll(poses, { x: 0, z: 3 }, 47000);
  assert.equal(
    p.poll(poses, { x: -1, z: 0 }, 47001),
    null,
    'individual cooldown survives leaving',
  );
});

test('chat/announcement/mute defer a reply until available, leaving room clears proximity', () => {
  const p = new WorkerProximity();
  const poses = [{ x: 0, z: 0 }];
  const player = { x: 0, z: 0 };
  assert.equal(p.poll(poses, player, 1000, false), null);
  assert.equal(p.poll(poses, player, 1001), 0);
  p.reset();
  assert.equal(p.poll(poses, player, 1002), 0);
});
