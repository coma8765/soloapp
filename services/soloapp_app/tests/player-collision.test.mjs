import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const B = createRequire(import.meta.url)('../public/vendor/babylon.js');
globalThis.window = Object.assign(new EventTarget(), { BABYLON: B });
globalThis.document = Object.assign(new EventTarget(), {
  pointerLockElement: null,
});
const { Player } = await import('../public/client/player.js');
const { Network } = await import('../public/client/network.js');
const { resolvePlanetPeople } =
  await import('../public/client/player-collision.js');
const { resolveRoomMovement } =
  await import('../public/client/room-collision.js');
const { REACTOR_MAP, PHYSICAL_MAP, ROOM_MAP } =
  await import('../public/shared/room.js');
const v = (x, z, y = 0) => new B.Vector3(x, y, z);

function fixture(t, map = REACTOR_MAP, id = 1) {
  const engine = new B.NullEngine();
  const scene = new B.Scene(engine);
  const body = new B.TransformNode('local', scene);
  body.rotationQuaternion = B.Quaternion.Identity();
  const camera = new B.FreeCamera('camera', v(0, 3), scene);
  camera.rotationQuaternion = B.Quaternion.Identity();
  const player = Object.assign(Object.create(Player.prototype), {
    scene,
    body,
    camera,
    canvas: {},
    worldMap: map,
    inputEnabled: true,
    position: v(0, 3),
    forward: v(0, -1),
    pitch: 0,
    radialSpeed: 0,
    rotation: B.Quaternion.Identity(),
    speed: 0,
    roomColliders: [],
    roomPeople: () => [],
    networkPeople: () => [],
    movementConstraints: [],
    structures: [],
    keys: new Set(),
    planet: { trees: [] },
    terrain: { radius: () => 38 },
    avatar: { id: 'male', update() {} },
  });
  const network = new Network(
    scene,
    player,
    { reset() {} },
    { actors: new Map(), updateActor() {} },
    {},
    () => {},
  );
  network.id = id;
  const addRemote = (remoteId = 2, position = v(0, 0), remoteMap = map) => {
    const node = new B.TransformNode(`peer ${remoteId}`, scene);
    node.position.copyFrom(position);
    node.rotationQuaternion = B.Quaternion.Identity();
    const remote = {
      node,
      avatarId: 'male',
      sequence: -1,
      last: performance.now(),
      state: { map: remoteMap, speed: 0, pitch: 0 },
      target: position.clone(),
      rotation: B.Quaternion.Identity(),
      avatar: { update() {} },
    };
    network.remotes.set(remoteId, remote);
    return remote;
  };
  t.after(() => {
    document.pointerLockElement = null;
    engine.dispose();
  });
  return { player, network, addRemote, scene };
}

for (const map of [REACTOR_MAP, PHYSICAL_MAP, ROOM_MAP]) {
  for (const mode of ['keyboard', 'gamepad', 'touch', 'xr']) {
    test(`${map}: ${mode} movement cannot cross a remote player, even in a long frame`, (t) => {
      const { player, addRemote } = fixture(t, map);
      addRemote();
      if (mode === 'keyboard') {
        document.pointerLockElement = player.canvas;
        player.keys.add('KeyW');
      }
      if (mode === 'gamepad') player.gamepadMove = { x: 0, y: 1 };
      if (mode === 'touch') player.touchMove = { x: 0, y: 1 };
      player.xr = mode === 'xr';
      player.update(2, mode === 'xr' ? v(0, -1) : null);
      assert(Math.abs(player.position.z - 0.7001) < 1e-6);
      // The collider does not trap someone moving away from contact.
      player.forward.negateInPlace();
      player.update(0.1, mode === 'xr' ? v(0, 1) : null);
      assert(player.position.z > 0.9);
    });
  }
}

test('network collider follows the rendered body and excludes self, other maps and stale poses', (t) => {
  const { player, network, addRemote } = fixture(t);
  const visible = addRemote(2, v(1, 2));
  visible.target = v(8, 8);
  addRemote(1);
  addRemote(3, v(0, 0), PHYSICAL_MAP);
  addRemote(4).last = performance.now() - 4000;
  assert.deepEqual(
    player.networkPeople().map(({ x, z }) => [x, z]),
    [[1, 2]],
  );
  player.worldMap = PHYSICAL_MAP;
  assert.equal(player.networkPeople().length, 1);
  network.message({ type: 'left', id: 3 });
  assert.equal(player.networkPeople().length, 0);
  player.worldMap = REACTOR_MAP;
  network.clearPeers();
  assert.equal(player.networkPeople().length, 0);
});

test('NPC and network collisions coexist; a player above the floor does not block it', (t) => {
  const { player, addRemote } = fixture(t);
  const peer = addRemote(2, v(0, 0, 3));
  player.roomPeople = () => [{ x: 0, z: 1, radius: 0.35 }];
  player.gamepadMove = { x: 0, y: 1 };
  player.update(2);
  assert(Math.abs(player.position.z - 1.7001) < 1e-6);
  player.roomPeople = () => [];
  player.position = v(0, 3);
  player.update(1);
  assert(player.position.z < 0);
  peer.node.position.y = 0;
  player.position = v(0, 3);
  player.update(1);
  assert(Math.abs(player.position.z - 0.7001) < 1e-6);
});

test('coincident peer spawns separate in opposite directions', (t) => {
  const a = fixture(t, REACTOR_MAP, 1),
    b = fixture(t, REACTOR_MAP, 2);
  a.player.position = v(0, 0);
  b.player.position = v(0, 0);
  a.addRemote(2);
  b.addRemote(1);
  a.player.update(0);
  b.player.update(0);
  assert(a.player.position.x < -0.7);
  assert(b.player.position.x > 0.7);
});

test('two clients approaching head-on stop without crossing after exchanged poses', (t) => {
  const a = fixture(t, REACTOR_MAP, 1),
    b = fixture(t, REACTOR_MAP, 2);
  b.player.position = v(0, -3);
  b.player.forward = v(0, 1);
  a.addRemote(2, b.player.position);
  b.addRemote(1, a.player.position);
  a.player.gamepadMove = b.player.gamepadMove = { x: 0, y: 1 };
  for (let frame = 0; frame < 180; frame++) {
    if (frame % 3 === 0) {
      a.network.apply(2, b.player.state(frame));
      b.network.apply(1, a.player.state(frame));
    }
    a.network.update(1 / 60);
    b.network.update(1 / 60);
    a.player.update(1 / 60);
    b.player.update(1 / 60);
    assert(a.player.position.z > b.player.position.z, `frame ${frame}`);
  }
  const distance = B.Vector3.Distance(a.player.position, b.player.position);
  assert(distance >= 0.69 && distance < 0.72, String(distance));
});

test('sliding around a player still respects the neighbouring wall', (t) => {
  const { scene } = fixture(t);
  const wall = B.MeshBuilder.CreateBox(
    'wall',
    { width: 0.2, height: 3, depth: 20 },
    scene,
  );
  wall.position.set(1, 1.5, 0);
  const next = resolveRoomMovement(v(0, 2), v(2, -2), [wall], 0.35, [
    { x: 0, z: 0, radius: 0.35 },
  ]);
  assert(next.x <= 0.5501);
  assert(Math.hypot(next.x, next.z) >= 0.7);
});

for (const up of [B.Axis.Y, B.Axis.X, B.Axis.Z.negate()]) {
  test(`planet collision uses the local ground plane at ${up.asArray()}`, () => {
    const center = up.scale(38);
    const tangent = B.Vector3.Cross(
      up,
      Math.abs(up.y) < 0.9 ? B.Axis.Y : B.Axis.Z,
    ).normalize();
    const point = (offset) =>
      center.add(tangent.scale(offset)).normalize().scale(38);
    const before = point(3),
      next = point(-3);
    const person = { x: center.x, y: center.y, z: center.z, radius: 0.35 };
    const result = resolvePlanetPeople(before, next, [person]);
    assert(Math.abs(result.length() - 38) < 1e-8);
    assert(B.Vector3.Dot(result.subtract(center), tangent) > 0.69);
    assert(B.Vector3.Distance(result, center) < 0.72);
    const otherSide = {
      x: -center.x,
      y: -center.y,
      z: -center.z,
      radius: 0.35,
    };
    assert(resolvePlanetPeople(before, next, [otherSide]).equals(next));
    const above = center.normalizeToNew().scale(41);
    assert(
      resolvePlanetPeople(before, next, [
        { ...person, x: above.x, y: above.y, z: above.z },
      ]).equals(next),
    );
  });
}
