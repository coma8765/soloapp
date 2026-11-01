import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const B = createRequire(import.meta.url)('../public/vendor/babylon.js');
globalThis.window = Object.assign(new EventTarget(), { BABYLON: B });
const { ReactorRoom } = await import('../public/client/reactor-room.js');
const { RbmkPhysicalConsole } =
  await import('../public/client/rbmk-console.js');

class Element extends EventTarget {
  style = {};
  open = false;
  after() {}
  close() {
    this.open = false;
  }
  getBoundingClientRect() {
    return { left: 40, top: 20, width: 800, height: 600 };
  }
}

function fixture(t) {
  const engine = new B.NullEngine({ renderWidth: 800, renderHeight: 600 });
  const scene = new B.Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new B.FreeCamera('view', new B.Vector3(0, 0, 3), scene);
  camera.setTarget(B.Vector3.Zero());
  const canvas = new Element();
  globalThis.document = Object.assign(new EventTarget(), {
    pointerLockElement: null,
    createElement: () => new Element(),
    body: { classList: { contains: () => false } },
  });
  const console = Object.create(RbmkPhysicalConsole.prototype);
  const activated = [];
  console.activate = (mesh) => {
    if (!mesh?.metadata?.rbmkControl) return false;
    activated.push(mesh);
    return true;
  };
  const button = (name, x, z = 0) => {
    const mesh = B.MeshBuilder.CreateBox(name, { size: 0.3 }, scene);
    mesh.position.set(x, 0, z);
    mesh.metadata = {
      rbmkControl: { name },
      baseColor: '#447755',
      cap: { material: new B.StandardMaterial(name, scene) },
    };
    mesh.computeWorldMatrix(true);
    return mesh;
  };
  const center = button('center', 0);
  const side = button('side', 1.2);
  const elements = Object.fromEntries(
    ['hints', 'exit', 'dialog', 'close', 'fields', 'actions'].map((id) => [
      id,
      new Element(),
    ]),
  );
  const room = Object.assign(Object.create(ReactorRoom.prototype), {
    scene,
    canvas,
    elements,
    active: true,
    player: { xr: false },
    physicalConsole: console,
    journal: { activate: () => false, focused: false },
  });
  room.bindUI();
  const frame = () => {
    camera.getViewMatrix(true);
    scene.updateTransformMatrix(true);
    scene.onBeforeRenderObservable.notifyObservers(scene);
  };
  const screen = (mesh) => {
    frame();
    const p = B.Vector3.Project(
      mesh.position,
      B.Matrix.Identity(),
      scene.getTransformMatrix(),
      new B.Viewport(0, 0, 800, 600),
    );
    return { x: p.x, y: p.y };
  };
  const pointer = (type, p = screen(side), button = 0) => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      clientX: p.x + 40,
      clientY: p.y + 20,
      button,
    });
    canvas.dispatchEvent(event);
  };
  const stale = screen(side);
  scene.pointerX = stale.x;
  scene.pointerY = stale.y;
  t.after(() => {
    engine.dispose();
    delete globalThis.document;
  });
  return {
    room,
    scene,
    camera,
    canvas,
    console,
    center,
    side,
    activated,
    frame,
    screen,
    pointer,
    button,
  };
}

test('locked crosshair highlights and clicks the center, ignoring stale cursor coordinates', (t) => {
  const f = fixture(t);
  document.pointerLockElement = f.canvas;
  f.pointer('pointermove');
  f.frame();
  assert.equal(f.console.hoveredButton?.name, 'center');
  // Babylon emits POINTERPICK before DOM click, using the stale cursor target.
  f.scene.onPointerObservable.notifyObservers({
    type: B.PointerEventTypes.POINTERPICK,
    pickInfo: { pickedMesh: f.side },
  });
  f.pointer('click');
  assert.deepEqual(
    f.activated.map((mesh) => mesh.name),
    ['center'],
  );
});

test('camera movement refreshes crosshair hover without any mouse event', (t) => {
  const f = fixture(t);
  document.pointerLockElement = f.canvas;
  f.frame();
  assert.equal(f.console.hoveredButton?.name, 'center');
  f.camera.setTarget(f.side.position);
  f.frame();
  assert.equal(f.console.hoveredButton?.name, 'side');
  assert.equal(f.center.scaling.x, 1);
  assert(f.room.activateCenter());
  assert.deepEqual(
    f.activated.map((mesh) => mesh.name),
    ['side'],
  );
  f.camera.setTarget(new B.Vector3(10, 0, 0));
  f.frame();
  assert.equal(f.console.hoveredButton, null);
});

test('gamepad crosshair refreshes hover even without pointer lock', (t) => {
  const f = fixture(t);
  document.body.classList.contains = (name) => name === 'playing';
  f.frame();
  assert.equal(f.console.hoveredButton?.name, 'center');
  f.room.activateCenter();
  assert.deepEqual(
    f.activated.map((mesh) => mesh.name),
    ['center'],
  );
});

test('instructor remains selectable with the cursor and the crosshair', (t) => {
  const f = fixture(t);
  f.center.metadata = { rbmkInstructor: true };
  let activations = 0;
  f.room.instructor = { activate: () => activations++ };
  const p = f.screen(f.center);
  f.scene.pointerX = p.x;
  f.scene.pointerY = p.y;
  f.pointer('pointermove', p);
  assert.equal(f.canvas.style.cursor, 'pointer');
  f.pointer('click', p);
  document.pointerLockElement = f.canvas;
  f.room.activateCenter();
  assert.equal(activations, 2);
  assert.deepEqual(f.activated, []);
});

test('unlocked click uses current event coordinates relative to the canvas', (t) => {
  const f = fixture(t);
  // There has been no pointermove to update Babylon's stored coordinates.
  f.pointer('click', f.screen(f.center));
  assert.deepEqual(
    f.activated.map((mesh) => mesh.name),
    ['center'],
  );
  f.pointer('pointermove');
  assert.equal(f.console.hoveredButton?.name, 'side');
  f.pointer('pointerleave');
  assert.equal(f.console.hoveredButton, null);
});

test('disabled and invisible hint geometry cannot intercept the center button', (t) => {
  const f = fixture(t);
  const hint = f.button('disabled hint', 0, 1);
  hint.metadata = { rbmkPart: { id: 'hint' } };
  hint.isPickable = false;
  document.pointerLockElement = f.canvas;
  f.frame();
  assert.equal(f.console.hoveredButton?.name, 'center');
  f.room.activateCenter();
  hint.isPickable = true;
  hint.isVisible = false;
  f.room.activateCenter();
  hint.isVisible = true;
  hint.setEnabled(false);
  f.room.activateCenter();
  assert.deepEqual(
    f.activated.map((mesh) => mesh.name),
    ['center', 'center', 'center'],
  );
});

test('right clicks, inactive rooms and desktop picks in XR do not activate buttons', (t) => {
  const f = fixture(t);
  f.pointer('click', f.screen(f.center), 2);
  f.room.active = false;
  f.canvas.style.cursor = 'help';
  f.frame();
  assert.equal(f.canvas.style.cursor, 'help');
  f.pointer('click', f.screen(f.center));
  f.room.active = true;
  f.room.player.xr = true;
  document.pointerLockElement = f.canvas;
  f.frame();
  f.pointer('click', f.screen(f.center));
  assert.equal(f.console.hoveredButton, null);
  assert.deepEqual(
    f.activated.map((mesh) => mesh.name),
    [],
  );
});
