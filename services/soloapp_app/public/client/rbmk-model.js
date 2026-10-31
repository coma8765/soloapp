import { RBMK_CONTROLS, RBMK_SCENARIOS } from './rbmk-data.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const approach = (value, target, rate, dt) =>
  value + (target - value) * (1 - Math.exp(-rate * dt));
const finite = (value, fallback) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

export { RBMK_CONTROLS, RBMK_SCENARIOS } from './rbmk-data.js';
export const RBMK_MODEL_VERSION = 2;

export class RbmkModel {
  constructor() {
    this.reset();
  }

  reset() {
    this.controls = {
      targetPower: 100,
      manualRodInsertion: 45,
      shortenedRodInsertion: 20,
      automaticRodInsertion: 45,
      automaticRegulator: true,
      coolantFlowLeft: 100,
      coolantFlowRight: 100,
      pumpsLeft: 4,
      pumpsRight: 4,
      feedwaterLeft: 100,
      feedwaterRight: 100,
      turbineLoad1: 500,
      turbineLoad2: 500,
      generatorBreaker1: true,
      generatorBreaker2: true,
      steamDump: 0,
      eccsAvailable: true,
      emergencyInjection: false,
      scenario: 'normal',
    };
    this.power = 100;
    this.pressure = 7;
    this.drumLevelLeft = 0;
    this.drumLevelRight = 0;
    this.coolantInventory = 100;
    this.flowLeft = 100;
    this.flowRight = 100;
    this.measuredFlowLeft = 100;
    this.measuredFlowRight = 100;
    this.voidFraction = 0.12;
    this.coolantTemperature = 284;
    this.fuelTemperature = 700;
    this.graphiteTemperature = 640;
    this.iodine = 0;
    this.xenon = 0;
    this.orm = 30;
    this.reactivity = 0;
    this.steamFlow = 100;
    this.electricalPower = 1000;
    this.frequency = 50;
    this.scrammed = false;
    this.scramReason = '';
    this.elapsed = 0;
    this.alarms = [];
    return this.snapshot();
  }

  setControl(name, rawValue) {
    const schema = RBMK_CONTROLS[name];
    if (!schema) return undefined;
    if (schema.type === 'checkbox') {
      this.controls[name] = Boolean(rawValue);
      return this.controls[name];
    }
    if (schema.type === 'select') {
      if (!Object.hasOwn(schema.options, rawValue)) return undefined;
      this.controls[name] = rawValue;
      return rawValue;
    }
    if (!Number.isFinite(Number(rawValue))) return undefined;
    let value = clamp(Number(rawValue), schema.min, schema.max);
    value = Math.round(value / schema.step) * schema.step;
    this.controls[name] = value;
    return value;
  }

  scram(reason = 'АЗ-5 нажата оператором') {
    this.scrammed = true;
    this.scramReason = String(reason).slice(0, 160);
    this.controls.targetPower = 0;
    this.controls.manualRodInsertion = 100;
    this.controls.shortenedRodInsertion = 100;
    this.controls.automaticRodInsertion = 100;
  }

  clearScram() {
    if (this.power > 3 || this.controls.scenario !== 'normal') return false;
    this.scrammed = false;
    this.scramReason = '';
    this.controls.targetPower = 5;
    this.controls.manualRodInsertion = 75;
    this.controls.shortenedRodInsertion = 70;
    this.controls.automaticRodInsertion = 70;
    return true;
  }

  scenarioEffects() {
    const scenario = this.controls.scenario;
    return {
      pumpsLeft:
        scenario === 'mcp-left-trip' || scenario === 'loss-offsite-power'
          ? scenario === 'loss-offsite-power'
            ? 0
            : Math.min(1, this.controls.pumpsLeft)
          : this.controls.pumpsLeft,
      pumpsRight:
        scenario === 'loss-offsite-power' ? 0 : this.controls.pumpsRight,
      feedwaterLeft:
        scenario === 'feedwater-loss' || scenario === 'loss-offsite-power'
          ? 0
          : this.controls.feedwaterLeft,
      feedwaterRight:
        scenario === 'feedwater-loss' || scenario === 'loss-offsite-power'
          ? 0
          : this.controls.feedwaterRight,
      turbineAvailable:
        scenario !== 'turbine-trip' && scenario !== 'loss-offsite-power',
      leak: scenario === 'small-loca' ? 1 : 0,
      flowSensorBias: scenario === 'flow-sensor-failure' ? 0.48 : 1,
    };
  }

  step(rawDt) {
    const dt = clamp(finite(rawDt, 0), 0, 0.25);
    if (!dt) return this.snapshot();
    this.elapsed += dt;
    const c = this.controls;
    const effects = this.scenarioEffects();

    if (c.automaticRegulator && !this.scrammed) {
      c.automaticRodInsertion = clamp(
        c.automaticRodInsertion + (this.power - c.targetPower) * 0.045 * dt,
        0,
        100,
      );
    }

    const leftFlowTarget = c.coolantFlowLeft * (effects.pumpsLeft / 4);
    const rightFlowTarget = c.coolantFlowRight * (effects.pumpsRight / 4);
    this.flowLeft = approach(this.flowLeft, leftFlowTarget, 0.9, dt);
    this.flowRight = approach(this.flowRight, rightFlowTarget, 0.9, dt);
    const averageFlow = (this.flowLeft + this.flowRight) / 2;

    const voidTarget = clamp(
      0.035 +
        this.power * 0.00085 +
        Math.max(0, 100 - averageFlow) * 0.0045 +
        effects.leak * 0.08,
      0.02,
      0.82,
    );
    this.voidFraction = approach(this.voidFraction, voidTarget, 0.45, dt);

    const iodineTarget = clamp(this.power / 100, 0, 1.35);
    this.iodine = approach(this.iodine, iodineTarget, 0.008, dt);
    const xenonTarget = clamp(
      this.iodine + Math.max(0, 100 - this.power) / 130,
      0,
      1.8,
    );
    this.xenon = approach(
      this.xenon,
      xenonTarget,
      xenonTarget > this.xenon ? 0.015 : 0.005,
      dt,
    );

    const weightedInsertion =
      c.manualRodInsertion * 0.55 +
      c.automaticRodInsertion * 0.3 +
      c.shortenedRodInsertion * 0.15;
    this.orm = clamp(48 - weightedInsertion * 0.42 - this.xenon * 8, 0, 55);
    const rodEffect =
      (45 - c.manualRodInsertion) * 0.036 +
      (45 - c.automaticRodInsertion) * 0.012 +
      (20 - c.shortenedRodInsertion) * 0.008;
    const voidEffect = (this.voidFraction - 0.12) * 1.35;
    const xenonEffect = -this.xenon * 0.38;
    const regulatorEffect = (c.targetPower - this.power) * 0.004;
    this.reactivity = this.scrammed
      ? -5
      : clamp(
          rodEffect + voidEffect + xenonEffect + regulatorEffect,
          -2.5,
          2.5,
        );

    const demandedPower = this.scrammed
      ? 0.2
      : clamp(
          c.targetPower + rodEffect * 30 + voidEffect * 22 + xenonEffect * 18,
          0.2,
          140,
        );
    this.power = approach(
      this.power,
      demandedPower,
      this.scrammed ? 1.8 : 0.16 + Math.max(0, this.reactivity) * 0.2,
      dt,
    );

    const injection = c.eccsAvailable && c.emergencyInjection ? 1 : 0;
    this.coolantInventory = clamp(
      this.coolantInventory + (injection * 0.42 - effects.leak * 0.2) * dt,
      0,
      110,
    );
    const steamDemand = effects.turbineAvailable
      ? (c.generatorBreaker1 ? c.turbineLoad1 : 0) / 10 +
        (c.generatorBreaker2 ? c.turbineLoad2 : 0) / 10 +
        c.steamDump * 0.55
      : c.steamDump * 0.55;
    const pressureTarget = clamp(
      7 +
        (this.power - steamDemand) * 0.017 -
        effects.leak * 1.8 -
        injection * 0.2,
      2.5,
      9.5,
    );
    this.pressure = approach(this.pressure, pressureTarget, 0.35, dt);
    this.steamFlow = approach(
      this.steamFlow,
      clamp(this.power * (0.88 + this.voidFraction), 0, 150),
      0.4,
      dt,
    );

    const inventoryPenalty = Math.max(0, 100 - this.coolantInventory) * 0.7;
    this.drumLevelLeft = clamp(
      this.drumLevelLeft +
        (effects.feedwaterLeft - this.power - inventoryPenalty) * 0.72 * dt,
      -1400,
      500,
    );
    this.drumLevelRight = clamp(
      this.drumLevelRight +
        (effects.feedwaterRight - this.power - inventoryPenalty) * 0.72 * dt,
      -1400,
      500,
    );

    const coolantTarget =
      270 +
      this.power * 0.14 +
      Math.max(0, 85 - averageFlow) * 0.32 -
      injection * 18;
    this.coolantTemperature = approach(
      this.coolantTemperature,
      coolantTarget,
      0.25,
      dt,
    );
    const fuelTarget =
      470 +
      this.power * 2.25 +
      Math.max(0, 85 - averageFlow) * 4.1 -
      injection * 80;
    this.fuelTemperature = approach(this.fuelTemperature, fuelTarget, 0.16, dt);
    const graphiteTarget = 560 + this.power * 0.8;
    this.graphiteTemperature = approach(
      this.graphiteTemperature,
      graphiteTarget,
      0.035,
      dt,
    );

    const turbinePowerTarget = effects.turbineAvailable
      ? (c.generatorBreaker1 ? c.turbineLoad1 : 0) +
        (c.generatorBreaker2 ? c.turbineLoad2 : 0)
      : 0;
    this.electricalPower = approach(
      this.electricalPower,
      turbinePowerTarget,
      0.7,
      dt,
    );
    this.frequency = approach(
      this.frequency,
      turbinePowerTarget
        ? clamp(50 + (this.power * 10 - turbinePowerTarget) * 0.0015, 47, 53)
        : 0,
      0.8,
      dt,
    );

    this.measuredFlowLeft = approach(
      this.measuredFlowLeft,
      this.flowLeft * effects.flowSensorBias,
      1.2,
      dt,
    );
    this.measuredFlowRight = approach(
      this.measuredFlowRight,
      this.flowRight,
      1.2,
      dt,
    );

    const averageDrum = (this.drumLevelLeft + this.drumLevelRight) / 2;
    const automaticTrip =
      c.scenario === 'loss-offsite-power'
        ? 'Потеря внешнего электроснабжения'
        : this.power > 120
          ? 'Превышение мощности 120%'
          : this.pressure > 8.2
            ? 'Давление КМПЦ выше 8,2 МПа'
            : averageDrum <= -1100
              ? 'Уровень БС ниже −1100 мм'
              : averageFlow < 42
                ? 'Недостаточный расход КМПЦ'
                : this.fuelTemperature > 1050
                  ? 'Температура топлива выше диапазона модели'
                  : this.coolantInventory < 60
                    ? 'Запас теплоносителя ниже 60%'
                    : '';
    if (automaticTrip && !this.scrammed) this.scram(automaticTrip);

    this.alarms = [];
    if (this.power > 110) this.alarms.push('МОЩНОСТЬ > 110%');
    if (this.pressure > 7.6) this.alarms.push('ДАВЛЕНИЕ КМПЦ ВЫСОКОЕ');
    if (this.pressure < 5.5) this.alarms.push('ДАВЛЕНИЕ КМПЦ НИЗКОЕ');
    if (this.drumLevelLeft < -600) this.alarms.push('УРОВЕНЬ БС-Л < −600 мм');
    if (this.drumLevelRight < -600) this.alarms.push('УРОВЕНЬ БС-П < −600 мм');
    if (this.measuredFlowLeft < 75) this.alarms.push('РАСХОД КМПЦ-Л НИЗКИЙ');
    if (this.measuredFlowRight < 75) this.alarms.push('РАСХОД КМПЦ-П НИЗКИЙ');
    if (Math.abs(this.measuredFlowLeft - this.measuredFlowRight) > 25)
      this.alarms.push('НЕСООТВЕТСТВИЕ РАСХОДОВ КМПЦ');
    if (this.orm < 15) this.alarms.push('ОЗР < 15 стержней');
    if (!c.eccsAvailable) this.alarms.push('САОР НЕДОСТУПНА');
    if (effects.leak) this.alarms.push('ПОТЕРЯ ТЕПЛОНОСИТЕЛЯ');
    if (effects.leak && !injection)
      this.alarms.push('АВАРИЙНЫЙ ВПРЫСК НЕ ПОДАЁТСЯ');
    if (c.scenario === 'flow-sensor-failure')
      this.alarms.push('ДИАГНОСТИКА: РАСХОДОМЕР ЛЕВОЙ ПЕТЛИ');
    if (!effects.turbineAvailable)
      this.alarms.push('ТУРБОГЕНЕРАТОРЫ ОТКЛЮЧЕНЫ');
    if (this.scrammed) this.alarms.push(`АЗ-5 · ${this.scramReason}`);
    return this.snapshot();
  }

  restore(raw) {
    if (!raw || raw.modelVersion !== RBMK_MODEL_VERSION || !raw.controls)
      return false;
    for (const name of Object.keys(RBMK_CONTROLS)) {
      const schema = RBMK_CONTROLS[name];
      if (raw.controls[name] === undefined) return false;
      if (this.setControl(name, raw.controls[name]) === undefined) return false;
      if (schema.type === 'range') {
        const value = Number(raw.controls[name]);
        if (!Number.isFinite(value) || value < schema.min || value > schema.max)
          return false;
        this.controls[name] = value;
      }
    }
    const ranges = {
      power: [0, 150],
      pressure: [0, 10],
      drumLevelLeft: [-1500, 600],
      drumLevelRight: [-1500, 600],
      coolantInventory: [0, 120],
      flowLeft: [0, 150],
      flowRight: [0, 150],
      measuredFlowLeft: [0, 150],
      measuredFlowRight: [0, 150],
      voidFraction: [0, 1],
      coolantTemperature: [0, 500],
      fuelTemperature: [0, 1400],
      graphiteTemperature: [0, 1000],
      iodine: [0, 2],
      xenon: [0, 2],
      orm: [0, 60],
      reactivity: [-6, 3],
      steamFlow: [0, 160],
      electricalPower: [0, 1100],
      frequency: [0, 55],
      elapsed: [0, 1e9],
    };
    for (const [name, [min, max]] of Object.entries(ranges)) {
      if (!Number.isFinite(raw[name]) || raw[name] < min || raw[name] > max)
        return false;
    }
    for (const name of Object.keys(ranges)) this[name] = raw[name];
    this.scrammed = Boolean(raw.scrammed);
    this.scramReason = String(raw.scramReason || '').slice(0, 160);
    this.alarms = Array.isArray(raw.alarms)
      ? raw.alarms.slice(0, 32).map((value) => String(value).slice(0, 160))
      : [];
    return true;
  }

  snapshot() {
    return {
      modelVersion: RBMK_MODEL_VERSION,
      controls: { ...this.controls },
      scenario: RBMK_SCENARIOS[this.controls.scenario],
      power: this.power,
      pressure: this.pressure,
      drumLevelLeft: this.drumLevelLeft,
      drumLevelRight: this.drumLevelRight,
      coolantInventory: this.coolantInventory,
      flowLeft: this.flowLeft,
      flowRight: this.flowRight,
      measuredFlowLeft: this.measuredFlowLeft,
      measuredFlowRight: this.measuredFlowRight,
      voidFraction: this.voidFraction,
      coolantTemperature: this.coolantTemperature,
      fuelTemperature: this.fuelTemperature,
      graphiteTemperature: this.graphiteTemperature,
      iodine: this.iodine,
      xenon: this.xenon,
      orm: this.orm,
      reactivity: this.reactivity,
      steamFlow: this.steamFlow,
      electricalPower: this.electricalPower,
      frequency: this.frequency,
      scrammed: this.scrammed,
      scramReason: this.scramReason,
      elapsed: this.elapsed,
      alarms: [...this.alarms],
    };
  }
}
