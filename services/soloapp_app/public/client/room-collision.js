const B = window.BABYLON;
const SKIN = 0.0001;
const PLAYER_RADIUS = 0.35;
const PLAYER_HEIGHT = 1.75;

// Project each structural mesh onto its horizontal axes. This follows the
// curved bank's yaw and includes the overhang of tilted console tops.
function footprint(mesh, feet, radius) {
  if (!mesh.isEnabled() || !mesh.isVisible) return null;
  const matrix = mesh.computeWorldMatrix(true);
  const box = mesh.getBoundingInfo().boundingBox;
  if (
    box.maximumWorld.y <= feet + 0.05 ||
    box.minimumWorld.y >= feet + PLAYER_HEIGHT
  )
    return null;
  const x = B.Vector3.TransformNormal(B.Axis.X, matrix);
  x.y = 0;
  if (x.lengthSquared() < 0.000001) x.set(1, 0, 0);
  x.normalize();
  const z = new B.Vector3(-x.z, 0, x.x);
  const axes = [x, z];
  return axes.map((axis) => {
    const values = box.vectorsWorld.map((v) => B.Vector3.Dot(v, axis));
    return {
      axis,
      min: Math.min(...values) - radius,
      max: Math.max(...values) + radius,
    };
  });
}

function sweep(position, delta, box) {
  let enter = -Infinity,
    exit = Infinity,
    normal;
  for (const { axis, min, max } of box) {
    const origin = B.Vector3.Dot(position, axis);
    const speed = B.Vector3.Dot(delta, axis);
    if (Math.abs(speed) < 1e-10) {
      if (origin <= min || origin >= max) return null;
      continue;
    }
    const a = (min - origin) / speed;
    const b = (max - origin) / speed;
    const near = Math.min(a, b);
    if (near > enter) {
      enter = near;
      normal = axis.scale(speed > 0 ? -1 : 1);
    }
    exit = Math.min(exit, Math.max(a, b));
    if (enter > exit) return null;
  }
  if (enter < -1e-8 || enter > 1 || exit < 0 || !normal) return null;
  return { time: Math.max(0, enter), normal };
}

// Horizontal swept discs share the same contact solver as furniture, so
// sliding past a person cannot push the participant through a nearby panel.
function sweepPerson(position, delta, person, radius) {
  const x = position.x - person.x,
    z = position.z - person.z;
  const size = radius + person.radius;
  const a = delta.x ** 2 + delta.z ** 2;
  const b = x * delta.x + z * delta.z;
  const c = x * x + z * z - size * size;
  if (a < 1e-12 || b >= 0) return null;
  const discriminant = b * b - a * c;
  if (discriminant < 0) return null;
  const time = (-b - Math.sqrt(discriminant)) / a;
  if (time < -1e-8 || time > 1) return null;
  const normal = new B.Vector3(
    x + delta.x * time,
    0,
    z + delta.z * time,
  ).normalize();
  return { time: Math.max(0, time), normal };
}

export function resolveRoomMovement(
  before,
  next,
  meshes,
  radius = PLAYER_RADIUS,
  people = [],
) {
  const boxes = meshes.map((m) => footprint(m, next.y, radius)).filter(Boolean);
  const position = before.clone();
  position.y = next.y;
  const delta = next.subtract(before);
  delta.y = 0;
  // Recover a restored/teleported pose inside furniture before sweeping.
  for (let pass = 0; pass < 8; pass++) {
    let overlap = false;
    for (const box of boxes) {
      const distances = box.map(({ axis, min, max }) => {
        const p = B.Vector3.Dot(position, axis);
        return { axis, low: p - min, high: max - p };
      });
      if (!distances.every((d) => d.low > 0 && d.high > 0)) continue;
      const faces = distances.flatMap(({ axis, low, high }) => [
        { distance: low, normal: axis.scale(-1) },
        { distance: high, normal: axis },
      ]);
      const face = faces.reduce((a, b) => (a.distance < b.distance ? a : b));
      position.addInPlace(face.normal.scale(face.distance + SKIN));
      overlap = true;
    }
    for (const person of people) {
      const offset = new B.Vector3(
        position.x - person.x,
        0,
        position.z - person.z,
      );
      const distance = offset.length();
      const size = radius + person.radius;
      if (distance >= size) continue;
      const outward =
        distance > 1e-8 ? offset.scale(1 / distance) : B.Vector3.Right();
      position.addInPlace(outward.scale(size - distance + SKIN));
      overlap = true;
    }
    if (!overlap) break;
  }
  // Sweep the whole frame, including long frames, then slide along the first
  // contact. Re-sweep the remainder so adjacent consoles cannot be crossed.
  for (let pass = 0; pass < 8 && delta.lengthSquared() > 1e-12; pass++) {
    let hit = null;
    for (const box of boxes) {
      const candidate = sweep(position, delta, box);
      if (candidate && (!hit || candidate.time < hit.time)) hit = candidate;
    }
    for (const person of people) {
      const candidate = sweepPerson(position, delta, person, radius);
      if (candidate && (!hit || candidate.time < hit.time)) hit = candidate;
    }
    if (!hit) {
      position.addInPlace(delta);
      break;
    }
    position.addInPlace(delta.scale(hit.time));
    position.addInPlace(hit.normal.scale(SKIN));
    delta.scaleInPlace(1 - hit.time);
    const inward = B.Vector3.Dot(delta, hit.normal);
    if (inward < 0) delta.subtractInPlace(hit.normal.scale(inward));
  }
  return position;
}
