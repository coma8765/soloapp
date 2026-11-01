import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { GamepadControls } from '../public/client/gamepad.js';
import {
  keyboardQualityShortcut,
  xrQualityPressed,
} from '../public/client/quality-input.js';

const B = createRequire(import.meta.url)('../public/vendor/babylon.js');
globalThis.window = Object.assign(new EventTarget(), {
  BABYLON: {
    ...B,
    DefaultRenderingPipeline: class {
      constructor() {
        this.sharpen = {};
      }
    },
  },
});
globalThis.document = Object.assign(new EventTarget(), {
  hidden: false,
  hasFocus: () => true,
  activeElement: null,
  body: { classList: { add() {}, remove() {} } },
});
globalThis.innerWidth = 1280;
globalThis.innerHeight = 720;
globalThis.devicePixelRatio = 2;
const { VisualQuality } = await import('../public/client/quality.js');
const { XRView } = await import('../public/client/xr.js');
const buttons = () =>
  Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
const hand = (handedness) => ({
  handedness,
  gamepad: { mapping: 'xr-standard', axes: [0, 0, 0, 0], buttons: buttons() },
});
const button = () => ({
  setAttribute(name, value) {
    this[name] = value;
  },
});

test('screen quality toggle changes density/MSAA/sharpen and button state', () => {
  const engine = {
    setHardwareScalingLevel(level) {
      this.scale = level;
    },
    getCaps: () => ({ maxMSAASamples: 4 }),
    resize() {},
  };
  const ui = button();
  const quality = new VisualQuality(engine, {}, {}, ui);
  assert.equal(engine.scale, 0.5);
  assert.equal(quality.pipeline.samples, 4);
  ui.onclick();
  assert.equal(engine.scale, 1);
  assert.equal(quality.pipeline.samples, 1);
  assert.equal(quality.pipeline.sharpenEnabled, false);
  assert.equal(ui['aria-pressed'], 'false');
  assert.equal(quality.toggle(), true);
  assert.equal(engine.scale, 0.5);
  assert.equal(ui['aria-pressed'], 'true');
});

test('Q ignores autorepeat, modifiers, handled events and typing fields', () => {
  assert(keyboardQualityShortcut({ code: 'KeyQ' }));
  for (const flag of [
    'repeat',
    'ctrlKey',
    'metaKey',
    'altKey',
    'defaultPrevented',
  ])
    assert.equal(
      keyboardQualityShortcut({ code: 'KeyQ', [flag]: true }),
      false,
    );
  assert.equal(keyboardQualityShortcut({ code: 'KeyP' }), false);
  assert.equal(
    keyboardQualityShortcut({ code: 'KeyQ', target: { closest: () => ({}) } }),
    false,
  );
});

test('standard L3 switches once per press and requires neutral after focus loss/reconnect', (t) => {
  const pad = {
    connected: true,
    mapping: 'standard',
    index: 0,
    id: 'Test pad',
    axes: [0, 0, 0, 0],
    buttons: buttons(),
  };
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: () => [],
  });
  t.mock.method(navigator, 'getGamepads', () => [pad]);
  const player = { inputEnabled: true, overview: false, turn() {}, pitch: 0 };
  const panel = {
    visible: false,
    settingsOpen: false,
    lobby: {},
    controllerFocus: '',
  };
  const controls = new GamepadControls(player, panel, { active: false }, {});
  let switches = 0,
    roomChanges = 0;
  controls.toggleQuality = () => switches++;
  controls.togglePhysical = () => roomChanges++;
  pad.buttons[10].pressed = true;
  controls.update(0.016);
  assert.equal(switches, 0, 'held at connection');
  pad.buttons[10].pressed = false;
  controls.update(0.016);
  controls.update(0.016);
  pad.buttons[10].pressed = true;
  for (let i = 0; i < 20; i++) controls.update(0.016);
  assert.equal(switches, 1);
  document.hidden = true;
  controls.update(0.016);
  document.hidden = false;
  controls.update(0.016);
  assert.equal(switches, 1, 'held after focus recovery');
  pad.buttons[10].pressed = false;
  controls.update(0.016);
  pad.buttons[10].pressed = true;
  controls.update(0.016);
  assert.equal(switches, 2);
  pad.connected = false;
  controls.update(0.016);
  pad.connected = true;
  controls.update(0.016);
  assert.equal(switches, 2, 'held after reconnection');
  assert.equal(roomChanges, 0);
});

async function xrFixture() {
  const player = {
    inputEnabled: true,
    keys: new Set(),
    update() {},
    camera: {},
  };
  const planet = { grass: { thinInstanceCount: 18000 }, setXRQuality() {} };
  const xr = new XRView({}, player, planet, {}, () => '');
  await xr.ready;
  const sources = [hand('left'), hand('right')];
  const session = { visibilityState: 'visible', inputSources: sources };
  xr.helper = {
    sessionManager: { session, referenceSpace: {}, fixedFoveation: 0 },
  };
  xr.hud = { setEnabled() {} };
  xr.enter();
  return { xr, sources, session, planet };
}

test('left Y is isolated from X, A, B, grip and non-XR gamepads', () => {
  const left = hand('left'),
    right = hand('right');
  for (const index of [0, 1, 2, 3, 4]) {
    left.gamepad.buttons[index].pressed = true;
    assert.equal(xrQualityPressed([left]), false);
  }
  right.gamepad.buttons[5].pressed = true;
  assert.equal(xrQualityPressed([right]), false);
  left.gamepad.buttons[5].pressed = true;
  assert(xrQualityPressed([left, right]));
  left.gamepad.mapping = 'standard';
  assert.equal(xrQualityPressed([left, right]), false);
});

test('actual XR polling changes quality live once, resets after hidden session and re-entry', async () => {
  const { xr, sources, session, planet } = await xrFixture();
  const y = sources[0].gamepad.buttons[5];
  let updates = 0;
  xr.onQualityChange = () => updates++;
  y.pressed = true;
  xr.input();
  assert.equal(updates, 0, 'release to arm after entry');
  y.pressed = false;
  xr.input();
  y.pressed = true;
  for (let i = 0; i < 20; i++) xr.input();
  assert.equal(updates, 1);
  assert.equal(xr.highQuality, true);
  assert.equal(planet.grass.thinInstanceCount, 12000);
  assert.equal(xr.helper.sessionManager.fixedFoveation, 0);
  session.visibilityState = 'hidden';
  xr.input();
  session.visibilityState = 'visible';
  xr.input();
  assert.equal(updates, 1);
  y.pressed = false;
  xr.input();
  y.pressed = true;
  xr.input();
  assert.equal(updates, 2);
  assert.equal(planet.grass.thinInstanceCount, 6000);
  assert.equal(xr.helper.sessionManager.fixedFoveation, 0.5);
  xr.exit();
  assert.equal(planet.grass.thinInstanceCount, 18000);
  xr.enter();
  const before = updates;
  xr.input();
  assert.equal(updates, before, 'held Y does not toggle on re-entry');
  assert.equal(planet.grass.thinInstanceCount, 6000);
});

test('XR viewport scale changes on the next frame; absent API and lost tracking are safe', async () => {
  const { xr } = await xrFixture();
  const scales = [];
  const frame = {
    getViewerPose: () => ({
      views: [
        { requestViewportScale: (scale) => scales.push(scale) },
        { requestViewportScale: (scale) => scales.push(scale) },
      ],
    }),
  };
  xr.applyViewportQuality(frame);
  assert.deepEqual(scales, [0.75, 0.75]);
  xr.toggleQuality();
  xr.applyViewportQuality(frame);
  assert.deepEqual(scales.slice(-2), [1, 1]);
  xr.applyViewportQuality({ getViewerPose: () => ({ views: [{}] }) });
  xr.applyViewportQuality({ getViewerPose: () => null });
  xr.active = false;
  xr.applyViewportQuality({
    getViewerPose() {
      throw Error('inactive XR');
    },
  });
});

test('installed Babylon supports foveation and prepending the scale callback before viewport lookup', () => {
  assert.equal(
    typeof Object.getOwnPropertyDescriptor(
      B.WebXRSessionManager.prototype,
      'fixedFoveation',
    )?.set,
    'function',
  );
  const observable = new B.Observable();
  const order = [];
  observable.add(() => order.push('viewport'));
  observable.add(() => order.push('scale'), -1, true);
  observable.notifyObservers({});
  assert.deepEqual(order, ['scale', 'viewport']);
});
