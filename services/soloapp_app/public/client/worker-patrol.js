// Destinations use shared server time and a per-worker seed. There is no fixed
// loop: each leg gets a new random destination in the connected walkable area.
export const WORKER_COUNT = 7;
export const WORKER_REPLY = 'Извините, сейчас я занят';
export const WORKER_LEG_MS = 45000;
export const WORKER_RADIUS = 0.35;

function random(seed) {
  let n = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

export function workerDestination(index, milliseconds, navigation) {
  const phase = milliseconds + index * 6300;
  const leg = Math.floor(phase / WORKER_LEG_MS);
  const choose = (n) =>
    navigation.targets[
      Math.floor(random(n + index * 104729) * navigation.targets.length)
    ];
  return {
    key: leg,
    from: choose(leg),
    target: choose(leg + 1),
    fraction: (phase - leg * WORKER_LEG_MS) / WORKER_LEG_MS,
  };
}

// Stateless initial pose makes a late join independent of local wall-clock skew.
// Live movement then yields to people and re-plans around their current poses.
export function workerPose(index, milliseconds, navigation) {
  const { key, from, target, fraction } = workerDestination(
    index,
    milliseconds,
    navigation,
  );
  const cacheKey = `${index}:${key}`;
  if (!navigation.routes.has(cacheKey)) {
    if (navigation.routes.size >= 64) navigation.routes.clear();
    navigation.routes.set(cacheKey, navigation.path(from, target));
  }
  const path = navigation.routes.get(cacheKey);
  const lengths = path
    .slice(1)
    .map((p, i) => Math.hypot(p.x - path[i].x, p.z - path[i].z));
  const length = lengths.reduce((a, b) => a + b, 0);
  const pause = 0.05 + random(key + index * 31) * 0.05;
  let remaining = length * Math.max(0, (fraction - pause) / (1 - pause));
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i] && lengths[i] > 0) {
      const a = path[i],
        b = path[i + 1],
        t = remaining / lengths[i];
      return {
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        yaw: Math.atan2(a.x - b.x, a.z - b.z),
        speed:
          fraction < pause
            ? 0
            : length / ((WORKER_LEG_MS / 1000) * (1 - pause)),
      };
    }
    remaining -= lengths[i];
  }
  return { x: target.x, z: target.z, yaw: 0, speed: 0 };
}

export class WorkerClock {
  constructor(monotonic = () => performance.now(), wall = Date.now()) {
    this.monotonic = monotonic;
    this.offset = wall - monotonic();
    this.lastStamp = 0;
  }
  sync(serverTime) {
    if (
      !Number.isSafeInteger(serverTime) ||
      serverTime <= this.lastStamp ||
      serverTime <= 0
    )
      return false;
    const candidate = serverTime - this.monotonic();
    // The largest offset is the least delayed server sample. Once anchored,
    // variable network latency cannot send the patrol backwards.
    this.offset = this.lastStamp ? Math.max(this.offset, candidate) : candidate;
    this.lastStamp = serverTime;
    return true;
  }
  now() {
    return this.monotonic() + this.offset;
  }
}

export class WorkerProximity {
  constructor() {
    this.reset();
  }
  reset() {
    this.near = new Set();
    this.cooldowns = new Map();
    this.nextReply = 0;
  }
  poll(poses, player, now, available = true) {
    for (const index of this.near)
      if (
        Math.hypot(poses[index].x - player.x, poses[index].z - player.z) > 2.5
      )
        this.near.delete(index);
    if (!available || now < this.nextReply) return null;
    const nearest = poses
      .map((pose, index) => ({
        index,
        distance: Math.hypot(pose.x - player.x, pose.z - player.z),
      }))
      .filter(
        ({ index, distance }) =>
          distance <= 1.7 &&
          !this.near.has(index) &&
          now >= (this.cooldowns.get(index) || 0),
      )
      .sort((a, b) => a.distance - b.distance)[0];
    if (!nearest) return null;
    this.near.add(nearest.index);
    this.cooldowns.set(nearest.index, now + 30000);
    this.nextReply = now + 6000;
    return nearest.index;
  }
}
