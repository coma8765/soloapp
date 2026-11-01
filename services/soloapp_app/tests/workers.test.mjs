import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORKER_COUNT,
  WORKER_LEG_MS,
  workerDestination,
  workerPose,
  WorkerClock,
  WorkerProximity,
} from '../public/client/worker-patrol.js';

import { WorkerNavigation } from '../public/client/worker-navigation.js';
const navigation = new WorkerNavigation([
  { min: { x: -2, z: -1 }, max: { x: 2, z: 1 } },
]);
const posesAt = (time) =>
  Array.from({ length: WORKER_COUNT }, (_, i) =>
    workerPose(i, time, navigation),
  );
test('seven seeded random walks choose new reachable destinations instead of repeating a circuit', () => {
  assert.equal(WORKER_COUNT, 7);
  for (let i = 0; i < WORKER_COUNT; i++) {
    const destinations = new Set();
    for (let leg = 0; leg < 80; leg++) {
      const time = leg * WORKER_LEG_MS;
      const { target } = workerDestination(i, time, navigation);
      destinations.add(`${target.x},${target.z}`);
      for (let phase = 0; phase < WORKER_LEG_MS; phase += 1000) {
        const p = workerPose(i, time + phase, navigation);
        const next = workerPose(i, time + phase + 10, navigation);
        assert(navigation.clear(p, next), 'route keeps furniture clearance');
        assert(
          Math.hypot(next.x - p.x, next.z - p.z) < 0.02,
          'continuous, including leg boundaries',
        );
      }
    }
    assert(destinations.size > 50);
  }
  assert.notDeepEqual(posesAt(10000), posesAt(10000 + WORKER_LEG_MS));
});

test('navigation goes around furniture and stationary people instead of cutting corners', () => {
  const start = navigation.nearest({ x: -4, z: 0 });
  const target = navigation.nearest({ x: 4, z: 0 });
  const people = [{ x: 0, z: 2, radius: 0.35 }];
  const path = navigation.path(start, target, people);
  assert(path.length >= 3);
  path.slice(1).forEach((p, i) => assert(navigation.clear(path[i], p, people)));
  assert.deepEqual(
    navigation.path(start, target, [{ ...target, radius: 0.35 }]),
    [],
  );
});

test('a touching worker can plan a way away from a participant', () => {
  const nav = new WorkerNavigation();
  const start = { x: 0, z: 0 };
  const people = [{ x: 0.7001, z: 0, radius: 0.35 }];
  const path = nav.path(start, nav.nearest({ x: -4, z: 0 }), people);
  assert(path.length >= 2);
  path.slice(1).forEach((p, i) => assert(nav.clear(path[i], p, people)));
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
