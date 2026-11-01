import assert from 'node:assert/strict';
import test from 'node:test';
import { GamepadControls } from '../public/client/gamepad.js';

// Exercise the actual polling classes with browser API fixtures. Hardware pose
// tracking and controller ergonomics still need a real-headset acceptance pass.
const events = new EventTarget();
globalThis.window = events;
window.BABYLON = { Vector3: { Zero: () => ({ x: 0, y: 0, z: 0 }) } };
globalThis.document = Object.assign(new EventTarget(), {
  hidden: false,
  hasFocus: () => true,
  activeElement: null,
});
const pad = {
  connected: true,
  mapping: 'standard',
  index: 0,
  id: 'Test controller',
  axes: [0, 0, 0, 0],
  buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
};
Object.defineProperty(navigator, 'getGamepads', {
  configurable: true,
  value: () => [pad],
});

test('real standard-gamepad poll dispatches the chord once and A interacts', () => {
  const player = { inputEnabled: true, overview: false, turn() {}, pitch: 0 };
  const panel = {
    visible: false,
    settingsOpen: false,
    lobby: {},
    controllerFocus: '',
  };
  const controls = new GamepadControls(player, panel, { active: false }, {});
  let switches = 0,
    selections = 0;
  controls.togglePhysical = () => switches++;
  controls.activateWorld = () => selections++;
  controls.update(0.016);
  controls.update(0.016);
  pad.buttons[4].pressed = pad.buttons[5].pressed = true;
  for (let i = 0; i < 20; i++) controls.update(0.016);
  assert.equal(switches, 1);
  pad.buttons[4].pressed = pad.buttons[5].pressed = false;
  controls.update(0.016);
  pad.buttons[0].pressed = true;
  controls.update(0.016);
  controls.update(0.016);
  assert.equal(selections, 1);
  pad.buttons[0].pressed = false;
  document.hidden = true;
  controls.update(0.016);
  document.hidden = false;
  pad.buttons[4].pressed = pad.buttons[5].pressed = true;
  controls.update(0.016);
  assert.equal(switches, 1, 'held chord on focus recovery must not teleport');
  pad.buttons[4].pressed = pad.buttons[5].pressed = false;
});

test('real XR poll dispatches both squeezes once, resets on hidden session', async () => {
  const { XRView } = await import('../public/client/xr.js');
  const player = { inputEnabled: true };
  const xr = new XRView({}, player, {}, {}, () => '');
  await xr.ready;
  const hand = (handedness) => ({
    handedness,
    gamepad: {
      mapping: 'xr-standard',
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 6 }, () => ({ pressed: false })),
    },
  });
  const sources = [hand('left'), hand('right')];
  const session = { visibilityState: 'visible', inputSources: sources };
  xr.helper = { sessionManager: { session } };
  xr.active = true;
  xr.authPanel = { visible: false };
  xr.sync = () => {};
  let switches = 0;
  xr.togglePhysical = () => switches++;
  xr.input();
  sources.forEach((s) => {
    s.gamepad.buttons[1].pressed = true;
  });
  for (let i = 0; i < 20; i++) xr.input();
  assert.equal(switches, 1);
  session.visibilityState = 'hidden';
  xr.input();
  session.visibilityState = 'visible';
  xr.input();
  assert.equal(switches, 1);
  sources.forEach((s) => {
    s.gamepad.buttons[1].pressed = false;
  });
  xr.input();
  sources.forEach((s) => {
    s.gamepad.buttons[1].pressed = true;
  });
  xr.input();
  assert.equal(switches, 2);
});
