import assert from 'node:assert/strict';
import test from 'node:test';
import { RbmkModel } from '../public/client/rbmk-model.js';
import {
  PHYSICS,
  equilibriumPrecursors,
  neutronStep,
  poisonStep,
} from '../public/client/rbmk-physics.js';

function advance(model, seconds, step = 0.25) {
  const count = Math.round(seconds / step);
  for (let i = 0; i < count; i++) model.step(step);
  return model.snapshot();
}

test('nominal equilibrium retains inventories, temperature and poison for 20 minutes', () => {
  const model = new RbmkModel();
  const state = advance(model, 1200);
  for (const [field, expected] of Object.entries({
    power: 100,
    pressure: 6.87,
    drumLevelLeft: 0,
    drumLevelRight: 0,
    iodine: 1,
    xenon: 1,
    orm: 30,
    fuelTemperature: 700,
    graphiteTemperature: 640,
  }))
    assert(
      Math.abs(state[field] - expected) < 1e-6,
      `${field}: ${state[field]}`,
    );
  assert.deepEqual(state.alarms, []);
  assert.equal(state.controls.pumpsLeft, 3);
  assert.equal(state.controls.pumpsRight, 3);
});

test('manual mode ignores power setpoint and moves actual rods at finite speed', () => {
  const model = new RbmkModel();
  model.setControl('automaticRegulator', false);
  model.setControl('targetPower', 0);
  assert(Math.abs(advance(model, 20).power - 100) < 1e-8);
  model.setControl('manualRodInsertion', 80);
  assert.equal(model.rods.manualRodInsertion, 45);
  model.step(0.1);
  assert(
    model.rods.manualRodInsertion > 45 && model.rods.manualRodInsertion < 46,
  );
  assert(
    model.orm > 30,
    'inserted absorber must increase the equivalent inserted margin',
  );
  assert(advance(model, 20).power < 50);
});

test('scram retains precursor and heat history, reset of latch does not withdraw rods', () => {
  const model = new RbmkModel();
  model.scram();
  assert.equal(model.rods.manualRodInsertion, 45);
  assert.equal(model.clearScram(), false);
  const fiveSeconds = advance(model, 5);
  assert(fiveSeconds.power < 20);
  assert(fiveSeconds.rods.manualRodInsertion < 100);
  assert(fiveSeconds.decayHeatMW > 100);
  assert(fiveSeconds.fuelTemperature > fiveSeconds.coolantTemperature);
  const stopped = advance(model, 55);
  assert(stopped.power < 3);
  assert.equal(stopped.rods.manualRodInsertion, 100);
  assert.equal(model.clearScram(), true);
  assert.equal(model.rods.manualRodInsertion, 100);
  assert.equal(model.controls.manualRodInsertion, 100);
});

test('point kinetics has an exact critical fixed point and a subcritical response', () => {
  const precursors = equilibriumPrecursors();
  const critical = neutronStep(1, precursors, 0, 0.025);
  assert(Math.abs(critical.power - 1) < 1e-12);
  critical.precursors.forEach((value, i) =>
    assert(Math.abs(value - precursors[i]) < 1e-10),
  );
  assert(neutronStep(1, precursors, -0.001, 0.025).power < 1);
});

test('iodine uses the sourced hourly half-life and xenon rises after shutdown', () => {
  assert.deepEqual(poisonStep(1, 1, 1, 86400), { iodine: 1, xenon: 1 });
  const halfLife = poisonStep(1, 1, 0, PHYSICS.iodineHalfLife);
  assert(Math.abs(halfLife.iodine - 0.5) < 1e-12);
  assert(halfLife.xenon > 1);
  const late = poisonStep(1, 1, 0, 48 * 3600);
  assert(late.xenon < halfLife.xenon);
  const split = poisonStep(
    ...Object.values(poisonStep(1, 1, 0, 3600)),
    0,
    3600,
  );
  const direct = poisonStep(1, 1, 0, 7200);
  assert(Math.abs(split.xenon - direct.xenon) < 1e-12);
});

test('mass and energy balances close independently in each water loop', () => {
  const model = new RbmkModel();
  model.setControl('scenario', 'small-loca');
  const state = advance(model, 20);
  assert(state.loopMasses[0] < state.loopMasses[1]);
  assert(
    Math.abs(state.loopMasses[1] - 700000) <
      Math.abs(state.loopMasses[0] - 700000) / 10,
  );
  for (const value of [...state.massResiduals, ...state.energyResiduals])
    assert(Math.abs(value) < 1e-5);
});

test('individual MCP and its outlet valve affect its loop with a coastdown', () => {
  const model = new RbmkModel();
  model.setControl('mcpLeft1', false);
  assert.equal(model.controls.pumpsLeft, 2);
  assert.equal(model.equipment.pumpSpeedLeft1, 1);
  let state = advance(model, 15);
  assert(state.flowLeft < 85);
  assert(state.flowRight > 99);
  model.setControl('mcpValveLeft2', false);
  state = advance(model, 15);
  assert(state.flowLeft < 60);
  assert(state.equipment.pumpSpeedLeft2 < 0.02);
});

test('feed isolation, reserve feed pump and ECCS channels change delivered water', () => {
  const model = new RbmkModel();
  model.setControl('feedIsolationLeft', false);
  let state = advance(model, 30);
  assert(state.equipment.feedCapacityLeft < 0.01);
  assert(state.drumLevelLeft < state.drumLevelRight - 150);
  model.reset();
  model.setControl('feedPumpLeft1', false);
  state = advance(model, 20);
  assert(state.equipment.feedCapacityLeft < 0.51);
  model.setControl('feedPumpLeft3', true);
  state = advance(model, 20);
  assert(state.equipment.feedCapacityLeft > 0.99);
  model.reset();
  for (let i = 1; i <= 3; i++) model.setControl(`eccsChannel${i}`, false);
  model.setControl('emergencyInjection', true);
  state = advance(model, 10);
  assert.equal(state.equipment.eccsCapacity, 0);
  assert(Math.abs(state.coolantInventory - 100) < 1e-6);
});

test('SUZ cooling, gas circuit, condensers and generator excitation are separate states', () => {
  const model = new RbmkModel();
  model.setControl('suzCoolingValve', false);
  model.setControl('gasOutletValve', false);
  model.setControl('condenserCooling1', false);
  model.setControl('generatorExcitation2', false);
  const state = advance(model, 30);
  assert(state.equipment.suzFlow < 1);
  assert(state.equipment.gasPressure > 1.5);
  assert(state.equipment.gasFlow < 1);
  assert(state.equipment.condenserPressure1 > 18);
  assert.equal(state.equipment.condenserPressure2, 5);
  assert(state.equipment.turbineValve1 < 0.1);
  assert(state.equipment.generatorVoltage2 < 1);
  assert(state.flowLeft > 99 && state.flowRight > 99);
});

test('SPiR and blowdown remove heat and mass through their own commands', () => {
  const model = new RbmkModel();
  model.setControl('cooldownValve', true);
  model.setControl('blowdownValve', true);
  const state = advance(model, 10);
  assert(state.equipment.cooldownMW > 0);
  assert(state.equipment.blowdownKgS > 0);
  assert(state.coolantInventory < 100);
  assert(state.pressure < PHYSICS.nominalPressure);
});

test('acknowledgement and timed lamp test do not reset the physical cause', () => {
  const model = new RbmkModel();
  model.setControl('eccsAvailable', false);
  advance(model, 1);
  model.acknowledgeAlarms();
  const before = model.snapshot();
  model.testLamps();
  assert(model.equipment.lampTestUntil > model.elapsed);
  assert.equal(model.power, before.power);
  assert.equal(model.controls.eccsAvailable, false);
  assert(model.alarms.includes('САОР НЕДОСТУПНА'));
  advance(model, 4);
  assert.equal(model.equipment.lampTestUntil, 0);
  assert(model.equipment.acknowledged);
  model.setControl('scenario', 'small-loca');
  advance(model, 1);
  assert.equal(model.equipment.acknowledged, false);
});

test('snapshot retains all dynamic state, including a noncontiguous pump selection', () => {
  const source = new RbmkModel();
  source.setControl('mcpLeft1', false);
  source.setControl('mcpLeft4', true);
  source.setControl('scenario', 'small-loca');
  const state = advance(source, 5);
  const follower = new RbmkModel();
  assert(follower.restore(state));
  assert.deepEqual(follower.snapshot(), state);
  assert.deepEqual(advance(follower, 5), advance(source, 5));
  const before = follower.snapshot();
  const invalid = structuredClone(before);
  invalid.controls.targetPower = 20;
  invalid.precursors[3] = NaN;
  assert.equal(follower.restore(invalid), false);
  assert.deepEqual(
    follower.snapshot(),
    before,
    'invalid snapshots must be rejected atomically',
  );
});

test('a pump-trip transient converges when the external step is halved', () => {
  const states = [0.1, 0.05, 0.025].map((dt) => {
    const model = new RbmkModel();
    model.setControl('scenario', 'mcp-left-trip');
    return advance(model, 30, dt);
  });
  for (const field of [
    'power',
    'pressure',
    'drumLevelLeft',
    'fuelTemperature',
  ]) {
    assert(Math.abs(states[0][field] - states[2][field]) < 1e-7, field);
    assert(Math.abs(states[1][field] - states[2][field]) < 1e-7, field);
  }
});
