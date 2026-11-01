// All clients evaluate the same route against PostgreSQL time, independent of
// render rate, reactor speed, room entry time and the elected physics writer.
export const WORKER_COUNT = 7;
export const WORKER_REPLY = 'Извините, сейчас я занят';
export const WORKER_ROUTE = [
  [-8, 5.3],
  [-8, 9.1],
  [8, 9.1],
  [8, 5.3],
];
const speed = 0.7;
const pause = 2;
const legs = WORKER_ROUTE.map(([x, z], i) => {
  const [nx, nz] = WORKER_ROUTE[(i + 1) % WORKER_ROUTE.length];
  return {
    x,
    z,
    dx: nx - x,
    dz: nz - z,
    travel: Math.hypot(nx - x, nz - z) / speed,
  };
});
export const WORKER_PERIOD = legs.reduce(
  (sum, leg) => sum + leg.travel + pause,
  0,
);

export function workerPose(index, milliseconds) {
  let phase =
    (((milliseconds / 1000 + (index * WORKER_PERIOD) / WORKER_COUNT) %
      WORKER_PERIOD) +
      WORKER_PERIOD) %
    WORKER_PERIOD;
  for (const leg of legs) {
    const duration = leg.travel + pause;
    if (phase < duration) {
      const t = Math.max(0, phase - pause) / leg.travel;
      return {
        x: leg.x + leg.dx * t,
        z: leg.z + leg.dz * t,
        yaw: Math.atan2(-leg.dx, -leg.dz),
        speed: phase < pause ? 0 : speed,
      };
    }
    phase -= duration;
  }
  return workerPose(index, 0);
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
