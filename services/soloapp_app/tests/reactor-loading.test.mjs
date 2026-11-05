import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const B = createRequire(import.meta.url)('../public/vendor/babylon.js');
globalThis.window = Object.assign(new EventTarget(), { BABYLON: B });
globalThis.BABYLON = B;
class Element extends EventTarget {
  constructor() {
    super();
    this.style = {};
    this.children = [];
    this.classList = { add() {}, remove() {}, contains: () => false };
  }
  append(...children) {
    this.children.push(...children);
  }
  after() {}
  remove() {}
  setAttribute(name, value) {
    this[name] = value;
  }
  close() {
    this.open = false;
  }
  blur() {}
}
const elements = new Map();
globalThis.document = Object.assign(new EventTarget(), {
  body: new Element(),
  createElement: (tag) =>
    tag === 'canvas' ? new OffscreenCanvas(1, 1) : new Element(),
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  },
});
globalThis.OffscreenCanvas = class {
  constructor(width, height) {
    Object.assign(this, { width, height });
    this.context = new Proxy(
      {},
      {
        get: (object, key) => object[key] ?? (() => ({ width: 50 })),
      },
    );
  }
  getContext() {
    return this.context;
  }
};
const { ReactorRoom } = await import('../public/client/reactor-room.js');
const { ReactorDoor } = await import('../public/client/reactor-door.js');

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

function fixture(t) {
  const engine = new B.NullEngine();
  const scene = new B.Scene(engine);
  const player = {
    position: new B.Vector3(0, 100, 0),
    forward: B.Vector3.Forward(),
    pitch: 0,
    worldMap: 'planet',
    keys: new Set(),
    movementConstraints: [],
    setMap(map, position) {
      this.worldMap = map;
      this.position.copyFromFloats(...position);
    },
    update() {},
  };
  const planet = {
    visible: true,
    setVisible(value) {
      this.visible = value;
    },
  };
  const terrain = { spawn: () => [0, 100, 0], radius: () => 100 };
  const ui = Object.fromEntries(
    [
      'hints',
      'exit',
      'dialog',
      'close',
      'fields',
      'actions',
      'telemetry',
      'team',
    ].map((key) => [key, new Element()]),
  );
  const room = new ReactorRoom(
    scene,
    terrain,
    planet,
    player,
    new Element(),
    ui,
  );
  t.after(() => engine.dispose());
  return { room, scene, player, planet };
}

test('startup keeps the door usable without building or fetching the room', (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    throw Error('unexpected fetch');
  });
  const { room, scene } = fixture(t);
  assert.equal(room.root.getChildMeshes().length, 0);
  assert.equal(room.instructor, undefined);
  assert.equal(room.physicalConsole, undefined);
  assert.equal(room.door.views.length, 1);
  assert(scene.meshes.length > 0, 'planet doorway is built');
  room.update(0);
  assert.equal(requests, 0);
});

test('simultaneous first entries wait for one preparation and enter only once', async (t) => {
  const { room, player, planet } = fixture(t);
  const download = deferred();
  let builds = 0;
  t.mock.method(room, 'buildInterior', async () => {
    builds++;
    await download.promise;
    room.instructor = { enter() {} };
    room.roomLight = { setEnabled() {} };
    room.journal = { store: { recordAction() {} } };
  });
  const first = room.enter();
  const second = room.enter();
  assert.equal(builds, 1);
  assert.equal(room.loading, true);
  assert.equal(room.uiOpen, true);
  assert.equal(player.worldMap, 'planet');
  assert.equal(planet.visible, true);
  download.resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, false]);
  assert.equal(player.worldMap, 'rbmk-training-room');
  assert.equal(room.loading, false);
  assert.equal(room.loadingElement.hidden, true);
  room.active = false;
  room.cooldown = 0;
  assert.equal(room.enter(), true, 'warm entry needs no asynchronous load');
  assert.equal(builds, 1);
});

test('failed preparation leaves the player outside and can be retried', async (t) => {
  const { room, player, planet } = fixture(t);
  let attempts = 0;
  t.mock.method(room, 'buildInterior', async () => {
    if (++attempts === 1) throw Error('download unavailable');
  });
  assert.equal(await room.enter(), false);
  assert.equal(player.worldMap, 'planet');
  assert.equal(planet.visible, true);
  assert.equal(room.loading, false);
  assert.equal(room.loadingError, true);
  assert.equal(room.loadingRetry.hidden, false);
  assert.match(room.loadingLabel.textContent, /download unavailable/);
  assert.equal(await room.loadForEntry(), true);
  assert.equal(attempts, 2);
  assert.equal(room.prepared, true);
  assert.equal(room.loadingError, false);
  assert.equal(
    player.worldMap,
    'planet',
    'retrying assets cannot bypass the door',
  );
});

test('a timed-out load can finish in the background without duplicate construction', async (t) => {
  const { room } = fixture(t);
  const download = deferred();
  let builds = 0;
  t.mock.method(room, 'buildInterior', async () => {
    builds++;
    await download.promise;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const loading = room.loadForEntry();
  t.mock.timers.tick(30000);
  assert.equal(await loading, false);
  assert.equal(room.loadingError, true);
  download.resolve();
  await room.prepare();
  assert.equal(await room.loadForEntry(), true);
  assert.equal(builds, 1);
  assert.equal(room.loadingElement.hidden, true);
  assert.equal(room.loadingError, false);
});

test('a partial interior build is cleaned up before retry', async (t) => {
  const { room } = fixture(t);
  const build = room.buildRoom;
  let attempts = 0;
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
  t.mock.method(room, 'buildRoom', function () {
    build.call(this);
    if (++attempts === 1) throw Error('interrupted build');
  });
  await assert.rejects(room.prepare(), /interrupted build/);
  assert.equal(room.root.getChildMeshes().length, 0);
  assert.equal(room.door.views.length, 1);
  assert.equal(room.colliders.length, 0);
  await room.prepare();
  assert.equal(room.prepared, true);
  assert.equal(room.door.views.length, 2);
});

test('real interior builds on demand and keeps preloaded worker synchronization', async (t) => {
  const { room } = fixture(t);
  t.mock.method(console, 'warn', () => {});
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return { ok: false, status: 503 };
  });
  const sync = room.workers.sync;
  sync.receive({
    type: 'workers_state',
    storage: 'postgresql',
    revision: 5,
    count: 3,
  });
  await room.prepare();
  assert(room.root.getChildMeshes().length > 100);
  assert.equal(room.prepared, true);
  assert.equal(room.root.isEnabled(), false);
  assert.equal(room.workers.sync, sync);
  assert.equal(sync.count, 3);
  assert(requested.some((url) => url.endsWith('/training/QUICK_START.md')));
  assert(requested.some((url) => url.endsWith('.glb')));
  const meshes = room.root.getChildMeshes().length;
  await room.prepare();
  assert.equal(room.root.getChildMeshes().length, meshes);
});

for (const outcome of ['ready', 'failed', 'moved']) {
  test(`door passage waits for destination preparation (${outcome})`, async () => {
    const loading = deferred();
    const room = {
      player: { worldMap: 'planet', position: {} },
      loadForEntry: () => loading.promise,
    };
    const sent = [];
    const door = Object.assign(Object.create(ReactorDoor.prototype), {
      room,
      view: () => ({}),
      local: () => ({ x: 0, y: 0, z: 0 }),
      sync: { request: (...args) => sent.push(args) },
    });
    const pending = door.requestPass('planet');
    void door.requestPass('planet');
    assert.equal(sent.length, 0);
    if (outcome === 'moved') room.player.worldMap = 'another-room';
    loading.resolve(outcome !== 'failed');
    await pending;
    assert.deepEqual(sent, outcome === 'ready' ? [['pass', 'planet']] : []);
  });
}
