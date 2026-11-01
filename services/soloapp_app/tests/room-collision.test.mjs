import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const B = createRequire(import.meta.url)('../public/vendor/babylon.js');
globalThis.window = Object.assign(new EventTarget(), { BABYLON: B });
const { resolveRoomMovement } =
  await import('../public/client/room-collision.js');
const v = (x, z, y = 0) => new B.Vector3(x, y, z);

function fixture(t, angle = 0) {
  const engine = new B.NullEngine();
  const scene = new B.Scene(engine);
  const root = new B.TransformNode('rotated section', scene);
  root.rotation.y = angle;
  root.position.set(2, 0, -3);
  const mesh = B.MeshBuilder.CreateBox(
    'cabinet',
    { width: 3, height: 1, depth: 2 },
    scene,
  );
  mesh.parent = root;
  mesh.position.y = 0.5;
  mesh.isPickable = false;
  const world = (x, z) =>
    B.Vector3.TransformCoordinates(v(x, z), root.computeWorldMatrix(true));
  const local = (p) =>
    B.Vector3.TransformCoordinates(
      p,
      B.Matrix.Invert(root.computeWorldMatrix(true)),
    );
  const move = (from, to, meshes = [mesh]) =>
    local(resolveRoomMovement(world(...from), world(...to), meshes));
  t.after(() => engine.dispose());
  return { scene, root, mesh, world, local, move };
}

for (const angle of [0, 0.6, -1.4]) {
  test(`cabinet at yaw ${angle} blocks all four faces and long-frame tunnelling`, (t) => {
    const f = fixture(t, angle);
    for (const sign of [-1, 1]) {
      const front = f.move([0, sign * 4], [0, -sign * 4]);
      assert(Math.abs(front.z - sign * 1.3501) < 1e-5);
      const side = f.move([sign * 4, 0], [-sign * 4, 0]);
      assert(Math.abs(side.x - sign * 1.8501) < 1e-5);
    }
  });
}

test('diagonal motion slides along the console and can move away again', (t) => {
  const f = fixture(t, 0.6);
  const p = f.move([0, 3], [1, 0]);
  assert(Math.abs(p.x - 1) < 1e-5);
  assert(Math.abs(p.z - 1.3501) < 1e-5);
  const out = f.move([p.x, p.z], [1, 3]);
  assert(Math.abs(out.z - 3) < 1e-5);
});

test('a clear passage beside the rotated panel remains open', (t) => {
  const f = fixture(t, 0.8);
  const p = f.move([1.9, 4], [1.9, -4]);
  assert(Math.abs(p.z + 4) < 1e-5);
});

test('tilted plate overhang blocks the body before the cabinet edge', (t) => {
  const f = fixture(t, 0.6);
  const plate = B.MeshBuilder.CreateBox(
    'sloped top',
    { width: 3, height: 0.16, depth: 2.5 },
    f.scene,
  );
  plate.parent = f.root;
  plate.position.y = 1.08;
  plate.rotation.x = 0.24;
  const p = f.move([0, 3], [0, 0], [f.mesh, plate]);
  const edge = 1.25 * Math.cos(0.24) + 0.08 * Math.sin(0.24) + 0.35;
  assert(Math.abs(p.z - edge - 0.0001) < 1e-5);
});

test('disabled rooms, floor and ceiling do not block walking', (t) => {
  const f = fixture(t);
  f.root.setEnabled(false);
  assert(Math.abs(f.move([0, 3], [0, -3]).z + 3) < 1e-5);
  f.root.setEnabled(true);
  f.mesh.position.y = -0.5;
  assert(Math.abs(f.move([0, 3], [0, -3]).z + 3) < 1e-5);
  f.mesh.position.y = 5;
  assert(Math.abs(f.move([0, 3], [0, -3]).z + 3) < 1e-5);
});

test('a restored pose inside a cabinet is moved to a free face', (t) => {
  const f = fixture(t);
  const p = f.move([0, 0.8], [0, 0.8]);
  assert(Math.abs(p.z - 1.3501) < 1e-5);
});

test('sliding is swept against a second wall at a corner', (t) => {
  const f = fixture(t);
  const wall = B.MeshBuilder.CreateBox(
    'side wall',
    { width: 0.2, height: 2, depth: 8 },
    f.scene,
  );
  wall.parent = f.root;
  wall.position.set(1.8, 1, 0);
  const p = f.move([0, 3], [5, 0], [f.mesh, wall]);
  assert(p.x < 1.351 && p.z >= 1.35, p.asArray().join(','));
});
