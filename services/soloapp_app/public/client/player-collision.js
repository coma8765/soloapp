import { resolveRoomMovement } from './room-collision.js';

const B = window.BABYLON;

// Use the room's swept-disc solver in the local tangent plane. Keep altitude:
// a collision must neither lift the player nor pull them below the terrain.
export function resolvePlanetPeople(before, next, people) {
  if (!people.length) return next;
  const up = before.normalizeToNew();
  const reference = Math.abs(up.y) < 0.9 ? B.Axis.Y : B.Axis.Z;
  const right = B.Vector3.Cross(reference, up).normalize();
  const forward = B.Vector3.Cross(up, right).normalize();
  const project = (point) => {
    const offset = point.subtract(before);
    return new B.Vector3(
      B.Vector3.Dot(offset, right),
      0,
      B.Vector3.Dot(offset, forward),
    );
  };
  const nearby = [];
  for (const person of people) {
    const position = new B.Vector3(person.x, person.y, person.z);
    if (
      B.Vector3.Dot(position, up) <= 0 ||
      Math.abs(position.length() - before.length()) >= 1.75
    )
      continue;
    const local = project(position);
    nearby.push({ ...person, x: local.x, z: local.z });
  }
  if (!nearby.length) return next;
  const target = project(next);
  const result = resolveRoomMovement(
    B.Vector3.Zero(),
    target,
    [],
    0.35,
    nearby,
  );
  if (result.equals(target)) return next;
  return before
    .add(right.scale(result.x))
    .add(forward.scale(result.z))
    .normalize()
    .scale(next.length());
}
