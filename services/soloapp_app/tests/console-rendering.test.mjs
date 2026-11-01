import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const B = createRequire(import.meta.url)('../public/vendor/babylon.js');
globalThis.window = Object.assign(new EventTarget(), { BABYLON: B });
// Canvas rasterization is covered in the browser; keep real Babylon meshes,
// instance buffers, transforms, materials and picking in these tests.
globalThis.OffscreenCanvas = class {
  constructor(width, height) {
    Object.assign(this, { width, height });
    this.context = new Proxy(
      {},
      { get: (object, key) => object[key] ?? (() => {}) },
    );
  }
  getContext() {
    return this.context;
  }
};
const { RbmkPhysicalConsole } =
  await import('../public/client/rbmk-console.js');
const { RbmkModel } = await import('../public/client/rbmk-model.js');

function fixture(t) {
  const engine = new B.NullEngine();
  const scene = new B.Scene(engine);
  const root = new B.TransformNode('room', scene);
  const model = new RbmkModel();
  const console = new RbmkPhysicalConsole(scene, root, {
    state: () => model.snapshot(),
    control: (name, value) => {
      model.setControl(name, value);
      return true;
    },
    action: () => true,
  });
  const uploads = [];
  const original = B.DynamicTexture.prototype.update;
  B.DynamicTexture.prototype.update = function (...args) {
    uploads.push(this.name);
    return original.apply(this, args);
  };
  console.sync(true);
  uploads.length = 0;
  t.after(() => {
    B.DynamicTexture.prototype.update = original;
    engine.dispose();
  });
  return { console, scene, root, model, uploads };
}

test('instanced console retains every independent button ray target', (t) => {
  const { console, scene, root } = fixture(t);
  const names = new Set();
  for (const button of console.buttons) {
    button.computeWorldMatrix(true);
    const center = button.getAbsolutePosition();
    const normal = B.Vector3.TransformNormal(
      B.Vector3.Up(),
      button.getWorldMatrix(),
    ).normalize();
    const hit = scene.pickWithRay(
      new B.Ray(center.add(normal.scale(0.4)), normal.negate(), 0.8),
      (mesh) => console.buttons.includes(mesh),
    );
    assert.equal(hit?.pickedMesh, button, button.name);
    names.add(button.name);
    assert.equal(button.visibility, 0);
    assert(button.metadata.cap.isAnInstance);
  }
  assert.equal(names.size, console.buttons.length);
  root.setEnabled(false);
  assert(console.buttons.every((button) => !button.isEnabled()));
});

test('hover, hints and command color do not leak between shared caps', (t) => {
  const { console } = fixture(t);
  const [a, b] = console.buttons.filter(
    (mesh) =>
      mesh.metadata.rbmkControl?.mode === 'set' &&
      mesh.metadata.rbmkControl.value,
  );
  const bColor = b.metadata.cap.material.emissiveColor.clone();
  console.setHovered(a);
  assert.equal(console.hoveredButton, a);
  assert(b.metadata.cap.material.emissiveColor.equals(bColor));
  assert(!a.metadata.cap.material.emissiveColor.equals(bColor));
  console.setHints(true);
  assert(console.buttons.every((button) => button.visibility === 1));
  console.setHovered(null);
  console.setHints(false);
  assert(console.buttons.every((button) => button.visibility === 0));
});

test('unchanged commands do not upload textures; changed commands repaint immediately', (t) => {
  const { console, uploads, model, root } = fixture(t);
  console.sync(true);
  assert(
    !uploads.some(
      (name) =>
        name.includes('equipment command') || name.includes('control readout'),
    ),
  );
  const readout = console.readouts.find(
    (item) => item.name === 'manualRodInsertion',
  );
  model.setControl('manualRodInsertion', 60);
  console.sync(true);
  assert.equal(readout.renderedValue, 60);
  assert(uploads.includes(readout.texture.name));
  uploads.length = 0;
  root.setEnabled(false);
  console.lastDraw = -1000;
  console.sync();
  assert.equal(uploads.length, 0);
});

test('lamp test invalidates alarm textures on activation and expiry', (t) => {
  const { console, uploads, model } = fixture(t);
  model.equipment.lampTestUntil = model.elapsed + 10;
  console.sync(true);
  assert(
    console.signalPanels.every((panel) => uploads.includes(panel.texture.name)),
  );
  uploads.length = 0;
  model.equipment.lampTestUntil = 0;
  console.sync(true);
  assert(
    console.signalPanels.every((panel) => uploads.includes(panel.texture.name)),
  );
});

test('instanced button press changes command and restores its own pose', (t) => {
  const { console, model } = fixture(t);
  const button = console.buttons.find(
    (mesh) =>
      mesh.metadata.rbmkControl?.name === 'manualRodInsertion' &&
      mesh.metadata.rbmkControl.delta > 0,
  );
  const before = model.controls.manualRodInsertion;
  assert(console.activate(button));
  assert.equal(model.controls.manualRodInsertion, before + 5);
  assert.equal(button.position.y, button.metadata.restY - 0.055);
  console.updateButtons(performance.now() + 200, model.snapshot());
  assert.equal(button.position.y, button.metadata.restY);
  assert(
    button.getChildMeshes().every((mesh) => mesh.isEnabled() && mesh.isVisible),
  );
});
