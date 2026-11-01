import assert from 'node:assert/strict';
import test from 'node:test';
import { RbmkModel } from '../public/client/rbmk-model.js';
import {
  storedMass,
  storedEnergy,
  INITIAL_MASS,
  INITIAL_ENERGY,
  hydraulicFlow,
} from '../public/client/rbmk-cycle.js';
import {
  RoomShortcut,
  xrRoomShortcut,
  keyboardRoomShortcut,
} from '../public/client/physical-room-input.js';
import { PHYSICAL_MAP, REACTOR_MAP } from '../public/shared/room.js';
import { validState } from '../public/shared/world.js';

function advance(model, seconds, dt = 0.1) {
  for (let i = 0; i < Math.round(seconds / dt); i++) model.step(dt);
  return model.snapshot();
}

for (const scenario of [
  'normal',
  'small-loca',
  'feedwater-loss',
  'turbine-trip',
  'loss-offsite-power',
]) {
  test(`whole system conserves mass and energy: ${scenario}`, () => {
    const model = new RbmkModel();
    model.setControl('scenario', scenario);
    model.setControl('emergencyInjection', scenario === 'small-loca');
    advance(model, 120);
    const c = model.cycle;
    assert(Math.abs(storedMass(model) + c.escapedMass - INITIAL_MASS) < 1e-4);
    assert(
      Math.abs(
        storedEnergy(model) +
          c.escapedEnergy +
          c.rejectedEnergy +
          c.generatedEnergy -
          c.producedEnergy -
          INITIAL_ENERGY,
      ) < 1e-4,
    );
    assert(model.loopMasses.every((v) => v > 0));
  });
}

test('one loop loses cooling without moving its heat source to the other loop', () => {
  const model = new RbmkModel();
  model.setControl('scenario', 'mcp-left-trip');
  const s = advance(model, 10);
  assert(s.fuelTemperatures[0] > s.fuelTemperatures[1] + 15);
  assert(s.flowLeft < s.flowRight);
  assert(s.voidFractions[0] > s.voidFractions[1]);
});

test('conservation can start at a persisted migration boundary', () => {
  const model = new RbmkModel();
  model.loopMasses[0] = 690000;
  model.loopEnergies[0] = 870000;
  model.fuelTemperatures = [710, 710];
  model.fuelTemperature = 710;
  model.cycle.initialMass = storedMass(model);
  model.cycle.initialEnergy = storedEnergy(model);
  const restored = new RbmkModel();
  assert(restored.restore(model.snapshot()));
  const state = advance(restored, 10);
  assert(Math.abs(state.cycle.massError) < 1e-4);
  assert(Math.abs(state.cycle.energyError) < 1e-4);
});

test('sensor failure leaves the physical water and heat history unchanged', () => {
  const actual = new RbmkModel(),
    failed = new RbmkModel();
  failed.setControl('scenario', 'flow-sensor-failure');
  advance(actual, 10);
  advance(failed, 10);
  assert.deepEqual(failed.loopMasses, actual.loopMasses);
  assert.deepEqual(failed.fuelTemperatures, actual.fuelTemperatures);
  assert.deepEqual(failed.cycle, actual.cycle);
  assert(failed.measuredFlowLeft < actual.measuredFlowLeft * 0.6);
});

test('finite reserve and return vessels cannot provide unlimited water', () => {
  const model = new RbmkModel();
  model.cycle.injectionMass = [1, 2];
  model.cycle.returnMass = [1, 2];
  model.cycle.returnEnergy = model.cycle.returnMass.map(
    (m) => m * (2.8 - 3200 / 1500),
  );
  model.setControl('emergencyInjection', true);
  advance(model, 1);
  assert.deepEqual(model.cycle.injectionMass, [0, 0]);
  assert(model.cycle.returnMass.every((v) => v >= 0));
  assert(model.cycle.injection.every((v) => v === 0));
});

test('feed loss transfers inventory to return side, and level is not mass alone', () => {
  const model = new RbmkModel();
  model.setControl('scenario', 'feedwater-loss');
  const s = advance(model, 60);
  assert(s.cycle.returnMass[0] > 200000);
  assert(s.loopMasses[0] < 700000);
  assert(Math.abs(s.geometricLevels[0] - s.drumLevelLeft) > 1);
});

test('condenser failure propagates through turbine valve and steam pressure', () => {
  const m = new RbmkModel();
  m.setControl('condenserCooling1', false);
  const s = advance(m, 45);
  assert(s.equipment.condenserPressure1 > 18);
  assert(s.equipment.turbineValve1 < 0.1);
  assert(s.cycle.steam[0] < s.cycle.steam[1]);
  assert(s.loopPressures[0] > s.loopPressures[1]);
});

test('pump/network head intersection responds to valves, coastdown and natural head', () => {
  assert(Math.abs(hydraulicFlow([1, 1, 1, 0], 1, 1) - 100) < 1e-6);
  assert(hydraulicFlow([1, 1, 0, 0], 1, 1) < 85);
  assert(hydraulicFlow([1, 1, 1, 0], 0.5, 1) < 65);
  assert(hydraulicFlow([0, 0, 0, 0], 1, 1) > 0);
  assert(hydraulicFlow([0, 0, 0, 0], 1, 0) < 1e-6);
});

test('coupled history survives serialization and rejects corrupt cycle atomically', () => {
  const a = new RbmkModel(),
    b = new RbmkModel();
  a.setControl('scenario', 'small-loca');
  advance(a, 20);
  assert(b.restore(JSON.parse(JSON.stringify(a.snapshot()))));
  assert.deepEqual(advance(a, 10), advance(b, 10));
  const previous = b.snapshot(),
    invalid = structuredClone(previous);
  invalid.cycle.injectionMass[0] = -1;
  assert.equal(b.restore(invalid), false);
  assert.deepEqual(b.snapshot(), previous);
});

test('inner step refinement converges on the coupled response', () => {
  const states = [0.025, 0.0125, 0.00625].map((dt) => {
    const model = new RbmkModel();
    model.setControl('scenario', 'mcp-left-trip');
    return advance(model, 10, dt);
  });
  for (const key of ['power', 'pressure', 'fuelTemperature']) {
    const coarse = Math.abs(states[0][key] - states[2][key]);
    const fine = Math.abs(states[1][key] - states[2][key]);
    assert(fine < coarse, `${key}: ${fine} < ${coarse}`);
    assert(coarse < Math.max(1, Math.abs(states[2][key]) * 0.02));
  }
});

test('shortcuts require release after connection, focus loss, and each activation', () => {
  const shortcut = new RoomShortcut();
  assert.equal(shortcut.poll(true), false);
  assert.equal(shortcut.poll(false), false);
  assert.equal(shortcut.poll(true), true);
  assert.equal(shortcut.poll(true), false);
  shortcut.poll(false, false);
  assert.equal(shortcut.poll(true), false);
  shortcut.poll(false);
  assert.equal(shortcut.poll(true), true);
});

test('XR shortcut requires both real xr-standard squeeze buttons, not trigger/menu', () => {
  const hand = (handedness, index = 1, mapping = 'xr-standard') => ({
    handedness,
    gamepad: {
      mapping,
      buttons: Array.from({ length: 6 }, (_, i) => ({ pressed: i === index })),
    },
  });
  assert(xrRoomShortcut([hand('left'), hand('right')]));
  assert(!xrRoomShortcut([hand('left')]));
  assert(!xrRoomShortcut([hand('left', 0), hand('right', 0)]));
  assert(!xrRoomShortcut([hand('left', 5), hand('right', 5)]));
  assert(!xrRoomShortcut([hand('left', 1, 'standard'), hand('right')]));
});

test('P shortcut respects typing, modifiers and autorepeat', () => {
  const e = { code: 'KeyP', target: { closest: () => null } };
  assert(keyboardRoomShortcut(e));
  assert(!keyboardRoomShortcut({ ...e, repeat: true }));
  assert(!keyboardRoomShortcut({ ...e, ctrlKey: true }));
  assert(!keyboardRoomShortcut({ ...e, target: { closest: () => ({}) } }));
});

test('physical room has an independent validated map identity', () => {
  const state = {
    sequence: 1,
    position: [0, 0, 7],
    rotation: [0, 0, 0, 1],
    pitch: 0,
    map: PHYSICAL_MAP,
  };
  assert(validState(state, PHYSICAL_MAP));
  assert(!validState(state, REACTOR_MAP));
  assert(!validState({ ...state, position: [100, 0, 0] }, PHYSICAL_MAP));
});
