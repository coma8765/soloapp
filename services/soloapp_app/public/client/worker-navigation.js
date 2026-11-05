// A small, deterministic walkable grid built from the room's actual furniture.
// AABB clearance is deliberately conservative around sloped/rotated cabinets.
const CLEARANCE = 0.43;
const STEP = 0.6;
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function crossesBox(a, b, box) {
  let lo = 0,
    hi = 1;
  for (const axis of ['x', 'z']) {
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < 1e-10) {
      if (a[axis] < box.min[axis] || a[axis] > box.max[axis]) return false;
      continue;
    }
    const t1 = (box.min[axis] - a[axis]) / delta;
    const t2 = (box.max[axis] - a[axis]) / delta;
    lo = Math.max(lo, Math.min(t1, t2));
    hi = Math.min(hi, Math.max(t1, t2));
    if (lo > hi) return false;
  }
  return true;
}

export class WorkerNavigation {
  constructor(obstacles = []) {
    this.obstacles = obstacles.map(({ min, max }, sourceIndex) => ({
      sourceIndex,
      min: { x: min.x - CLEARANCE, z: min.z - CLEARANCE },
      max: { x: max.x + CLEARANCE, z: max.z + CLEARANCE },
    }));
    // Instrument faces and keys are contained by their cabinets: retain only
    // the outer bounds instead of testing thousands of decorative meshes.
    this.obstacles = this.obstacles.filter(
      (box, i, all) =>
        !all.some(
          (other, j) =>
            i !== j &&
            other.min.x <= box.min.x &&
            other.min.z <= box.min.z &&
            other.max.x >= box.max.x &&
            other.max.z >= box.max.z &&
            (j < i ||
              other.min.x < box.min.x ||
              other.min.z < box.min.z ||
              other.max.x > box.max.x ||
              other.max.z > box.max.z),
        ),
    );
    const grid = new Map();
    for (let x = -17; x <= 17; x++)
      for (let z = -17; z <= 16; z++) {
        const node = { x: x * STEP, z: z * STEP, neighbours: [] };
        if (this.clear(node, node)) grid.set(`${x},${z}`, node);
      }
    for (const [key, node] of grid) {
      const [x, z] = key.split(',').map(Number);
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const neighbour = grid.get(`${x + dx},${z + dz}`);
        if (neighbour && this.clear(node, neighbour))
          node.neighbours.push(neighbour);
      }
    }
    // Discard pockets behind cabinets; all random destinations must be connected.
    const unseen = new Set(grid.values());
    this.nodes = [];
    while (unseen.size) {
      const component = [unseen.values().next().value];
      unseen.delete(component[0]);
      for (let i = 0; i < component.length; i++)
        for (const n of component[i].neighbours)
          if (unseen.delete(n)) component.push(n);
      if (component.length > this.nodes.length) this.nodes = component;
    }
    this.targets = this.nodes.filter((p) => Math.abs(p.x) > 1.8 || p.z < 8);
    if (!this.targets.length) throw Error('No walkable worker destinations');
    this.routes = new Map();
  }

  clear(a, b, people = []) {
    if (this.obstacles.some((box) => crossesBox(a, b, box))) return false;
    const dx = b.x - a.x,
      dz = b.z - a.z;
    const length = dx * dx + dz * dz;
    return people.every((p) => {
      const t = length
        ? Math.max(
            0,
            Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / length),
          )
        : 0;
      // Let a worker step away from contact even inside the planning margin.
      if (length > 0 && t === 0 && distance(b, p) > distance(a, p)) return true;
      return (
        Math.hypot(a.x + t * dx - p.x, a.z + t * dz - p.z) >
        p.radius + CLEARANCE
      );
    });
  }

  nearest(point, people = []) {
    let best = null,
      gap = Infinity;
    for (const n of this.nodes) {
      const d = distance(n, point);
      if (d < gap && this.clear(point, n) && this.clear(n, n, people)) {
        best = n;
        gap = d;
      }
    }
    return best;
  }

  path(point, target, people = []) {
    const start = this.nearest(point, people);
    if (!start || !this.clear(target, target, people)) return [];
    const queue = [start],
      previous = new Map([[start, null]]);
    for (let i = 0; i < queue.length && !previous.has(target); i++) {
      for (const next of queue[i].neighbours) {
        if (previous.has(next) || !this.clear(queue[i], next, people)) continue;
        previous.set(next, queue[i]);
        queue.push(next);
      }
    }
    if (!previous.has(target)) return [];
    const path = [];
    for (let p = target; p; p = previous.get(p)) path.push(p);
    path.reverse();
    const result = [point];
    for (let i = 0; i < path.length;) {
      let end = path.length - 1;
      while (end > i && !this.clear(result.at(-1), path[end], people)) end--;
      // An actor may be touching us: wait rather than step through them.
      if (!this.clear(result.at(-1), path[end], people)) return [];
      result.push(path[end]);
      i = end + 1;
    }
    return result;
  }
}
