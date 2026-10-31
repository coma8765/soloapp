import assert from 'node:assert/strict';
import { RBMK_MODEL_VERSION, RbmkModel } from '../public/client/rbmk-model.js';
import { RBMK_CONTROLS, RBMK_PANEL_PARTS } from '../public/client/rbmk-data.js';
import { REACTOR_MAP } from '../public/shared/room.js';
import { validState } from '../public/shared/world.js';

function advance(model, seconds, step = 0.1) {
  for (let elapsed = 0; elapsed < seconds; elapsed += step) model.step(step);
  return model.snapshot();
}

{
  assert.equal(RBMK_PANEL_PARTS.length, 24);
  assert.equal(new Set(RBMK_PANEL_PARTS.map((part) => part.id)).size, 24);
  for (const wall of ['front', 'back', 'left', 'right']) {
    const parts = RBMK_PANEL_PARTS.filter((part) => part.wall === wall);
    assert.equal(parts.length, 6, `${wall} should have six mapped zones`);
    for (const column of [-8, -2, 4]) {
      for (const row of [1, 6]) {
        assert.equal(
          parts.filter((part) => {
            const [offset, bottom, width, height] = part.area;
            return (
              column >= offset &&
              column < offset + width &&
              row >= bottom &&
              row < bottom + height
            );
          }).length,
          1,
          `${wall} panel point ${column},${row} should map exactly once`,
        );
      }
    }
  }
  for (const part of RBMK_PANEL_PARTS)
    for (const control of part.controls || [])
      assert(RBMK_CONTROLS[control], `${part.id}: unknown control ${control}`);
}

{
  const state = {
    type: 'state',
    map: REACTOR_MAP,
    sequence: 1,
    position: [0, 0, 7.4],
    rotation: [0, 0, 0, 1],
    pitch: 0,
    speed: 0,
  };
  assert(validState(state, REACTOR_MAP));
  assert(!validState({ ...state, map: 'planet' }, REACTOR_MAP));
}

{
  const model = new RbmkModel();
  const state = advance(model, 10);
  assert(Math.abs(state.power - 100) < 3);
  assert(Math.abs(state.pressure - 7) < 0.2);
  assert(state.orm > 25);
  assert.deepEqual(state.alarms, []);
}

{
  const model = new RbmkModel();
  model.setControl('automaticRegulator', false);
  model.setControl('manualRodInsertion', 80);
  const state = advance(model, 20);
  assert(state.power < 70, `rod insertion should reduce power: ${state.power}`);
  assert(state.reactivity < 0);
}

{
  const model = new RbmkModel();
  model.setControl('scenario', 'feedwater-loss');
  const state = advance(model, 18);
  assert(state.drumLevelLeft < -600);
  assert(state.drumLevelRight < -600);
  assert(state.alarms.some((alarm) => alarm.includes('УРОВЕНЬ БС')));
}

{
  const model = new RbmkModel();
  model.setControl('scenario', 'mcp-left-trip');
  const state = advance(model, 10);
  assert(state.flowLeft < 40);
  assert(state.flowRight > 90);
  assert(state.alarms.includes('РАСХОД КМПЦ-Л НИЗКИЙ'));
}

{
  const model = new RbmkModel();
  model.setControl('scenario', 'flow-sensor-failure');
  const state = advance(model, 8);
  assert(state.flowLeft > 90);
  assert(state.measuredFlowLeft < 60);
  assert(state.alarms.some((alarm) => alarm.includes('РАСХОДОМЕР')));
}

{
  const leaking = new RbmkModel();
  leaking.setControl('scenario', 'small-loca');
  const withoutInjection = advance(leaking, 20);
  const cooled = new RbmkModel();
  cooled.setControl('scenario', 'small-loca');
  cooled.setControl('emergencyInjection', true);
  const withInjection = advance(cooled, 20);
  assert(withInjection.coolantInventory > withoutInjection.coolantInventory);
  assert(withInjection.fuelTemperature < withoutInjection.fuelTemperature);
}

{
  const model = new RbmkModel();
  model.setControl('scenario', 'turbine-trip');
  let peakPressure = model.pressure;
  for (let elapsed = 0; elapsed < 12; elapsed += 0.1) {
    peakPressure = Math.max(peakPressure, model.step(0.1).pressure);
  }
  assert(peakPressure > 7.6);
  assert(model.scrammed);
}

{
  const model = new RbmkModel();
  model.setControl('scenario', 'loss-offsite-power');
  const state = model.step(0.1);
  assert(state.scrammed);
  assert.equal(state.scramReason, 'Потеря внешнего электроснабжения');
}

{
  const model = new RbmkModel();
  model.scram();
  const state = advance(model, 5);
  assert(state.power < 1);
  assert.equal(state.controls.manualRodInsertion, 100);
  assert(state.alarms.some((alarm) => alarm.startsWith('АЗ-5')));
}

{
  const source = new RbmkModel();
  source.setControl('scenario', 'small-loca');
  source.setControl('emergencyInjection', true);
  const snapshot = advance(source, 4);
  const follower = new RbmkModel();
  assert(follower.restore(snapshot));
  assert.equal(follower.snapshot().modelVersion, RBMK_MODEL_VERSION);
  assert.deepEqual(follower.snapshot().controls, snapshot.controls);
  assert.equal(follower.snapshot().power, snapshot.power);
  assert.equal(follower.setControl('scenario', 'unknown'), undefined);
}

console.log('RBMK educational model v2: 10 scenarios passed');
