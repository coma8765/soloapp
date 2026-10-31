import assert from 'node:assert/strict';
import { RbmkModel } from '../public/client/rbmk-model.js';

function advance(model, seconds, step = 0.1) {
  for (let elapsed = 0; elapsed < seconds; elapsed += step) model.step(step);
  return model.snapshot();
}

{
  const model = new RbmkModel();
  const state = advance(model, 10);
  assert(Math.abs(state.power - 100) < 3);
  assert(Math.abs(state.pressure - 7) < 0.2);
  assert(state.orm > 26);
  assert.deepEqual(state.alarms, []);
}

{
  const model = new RbmkModel();
  model.setControl('rodInsertion', 80);
  const state = advance(model, 20);
  assert(state.power < 70, `rod insertion should reduce power: ${state.power}`);
  assert(state.orm > 35);
}

{
  const model = new RbmkModel();
  model.setControl('feedwaterFlow', 0);
  const state = advance(model, 18);
  assert(state.drumLevel < -600);
  assert(state.alarms.some((alarm) => alarm.includes('УРОВЕНЬ БС')));
}

{
  const model = new RbmkModel();
  model.setControl('pumpsPerLoop', 1);
  const state = model.step(0.1);
  assert(state.scrammed);
  assert.equal(state.scramReason, 'Менее двух ГЦН в петле');
}

{
  const model = new RbmkModel();
  model.scram();
  const state = advance(model, 5);
  assert(state.power < 1);
  assert.equal(state.controls.rodInsertion, 100);
  assert(state.alarms.some((alarm) => alarm.startsWith('АЗ-5')));
}

console.log('RBMK educational model: 5 scenarios passed');
