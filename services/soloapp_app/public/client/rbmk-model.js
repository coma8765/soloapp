import { RBMK_CONTROLS, RBMK_SCENARIOS } from './rbmk-data.js';
import {
  initialCycle,
  cycleIsValid,
  hydraulicFlow,
  updateCycle,
} from './rbmk-cycle.js';
import {
  PHYSICS,
  equilibriumPrecursors,
  neutronStep,
  poisonStep,
} from './rbmk-physics.js';
import {
  equipmentDefaults,
  initialEquipment,
  updateEquipment,
} from './rbmk-equipment.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const approach = (value, target, rate, dt) =>
  value + (target - value) * (1 - Math.exp(-rate * dt));
const finite = (value, fallback) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

export { RBMK_CONTROLS, RBMK_SCENARIOS } from './rbmk-data.js';
export const RBMK_MODEL_VERSION = 4;

export class RbmkModel {
  constructor() {
    this.reset();
  }

  reset() {
    this.controls = {
      ...equipmentDefaults(),
      targetPower: 100,
      manualRodInsertion: 45,
      shortenedRodInsertion: 20,
      automaticRodInsertion: 45,
      automaticRegulator: true,
      coolantFlowLeft: 100,
      coolantFlowRight: 100,
      pumpsLeft: 3,
      pumpsRight: 3,
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
    this.pressure = PHYSICS.nominalPressure;
    this.drumLevelLeft = 0;
    this.drumLevelRight = 0;
    this.coolantInventory = 100;
    this.flowLeft = 100;
    this.flowRight = 100;
    this.measuredFlowLeft = 100;
    this.measuredFlowRight = 100;
    this.voidFraction = 0.12;
    this.coolantTemperature = 284.5;
    this.fuelTemperature = 700;
    this.fuelTemperatures = [700, 700];
    this.voidFractions = [0.12, 0.12];
    this.geometricLevels = [0, 0];
    this.cycle = initialCycle();
    this.graphiteTemperature = 640;
    this.iodine = 1;
    this.xenon = 1;
    this.rods = {
      manualRodInsertion: 45,
      automaticRodInsertion: 45,
      shortenedRodInsertion: 20,
    };
    this.precursors = equilibriumPrecursors();
    this.fastProtectionInsertion = 0;
    this.equipment = initialEquipment();
    this.loopMasses = [700000, 700000];
    this.loopEnergies = [882000, 882000];
    this.loopPressures = [PHYSICS.nominalPressure, PHYSICS.nominalPressure];
    this.massResiduals = [0, 0];
    this.energyResiduals = [0, 0];
    this.decayHeatGroups = [0.004, 0.008, 0.015, 0.018, 0.012, 0.008].map(
      (fraction) => PHYSICS.thermalMW * fraction,
    );
    this.decayHeatMW = this.decayHeatGroups.reduce((a, b) => a + b, 0);
    this.thermalPowerMW = PHYSICS.thermalMW;
    this.validity = 'reduced-model';
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
      for (const side of ['Left', 'Right']) {
        if (
          Array.from({ length: 4 }, (_, i) => `mcp${side}${i + 1}`).includes(
            name,
          )
        )
          this.controls[`pumps${side}`] = Array.from({ length: 4 }, (_, i) =>
            Number(this.controls[`mcp${side}${i + 1}`]),
          ).reduce((a, b) => a + b, 0);
      }
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
    if (name === 'pumpsLeft' || name === 'pumpsRight') {
      const side = name === 'pumpsLeft' ? 'Left' : 'Right';
      for (let i = 1; i <= 4; i++) this.controls[`mcp${side}${i}`] = i <= value;
    }
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
    return true;
  }

  acknowledgeAlarms() {
    this.equipment.acknowledged = true;
  }

  testLamps() {
    this.equipment.lampTestUntil = this.elapsed + 3;
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
    const count = Math.ceil(dt / 0.025);
    for (let index = 0; index < count; index++) this.integrate(dt / count);
    return this.snapshot();
  }

  integrate(dt) {
    // A teaching-domain exit is a stopped calculation, never a fabricated
    // continuation through negative inventory or unsupported damage physics.
    if (this.validity === 'outside-domain') return;
    const previousAlarms = this.alarms;
    this.elapsed += dt;
    const c = this.controls;
    const effects = this.scenarioEffects();
    updateEquipment(
      this.equipment,
      c,
      this.power,
      this.graphiteTemperature,
      this.elapsed,
      dt,
      true,
    );

    if (c.automaticRegulator && !this.scrammed) {
      c.automaticRodInsertion = clamp(
        c.automaticRodInsertion + (this.power - c.targetPower) * 0.045 * dt,
        0,
        100,
      );
    }

    for (const name of [
      'manualRodInsertion',
      'automaticRodInsertion',
      'shortenedRodInsertion',
    ]) {
      const target = this.scrammed ? 100 : c[name];
      this.rods[name] += clamp(
        target - this.rods[name],
        (-100 * dt) / PHYSICS.manualTravelSeconds,
        (100 * dt) /
          (this.scrammed
            ? PHYSICS.scramTravelSeconds
            : PHYSICS.manualTravelSeconds),
      );
    }
    this.fastProtectionInsertion = clamp(
      this.fastProtectionInsertion +
        (((this.scrammed ? 1 : -1) * 100) / 2.5) * dt,
      0,
      100,
    );
    const flowTarget = (side) =>
      hydraulicFlow(
        Array.from(
          { length: 4 },
          (_, i) => this.equipment[`pumpSpeed${side}${i + 1}`],
        ),
        c[`coolantFlow${side}`] / 100,
        this.thermalPowerMW / PHYSICS.thermalMW,
      );
    const leftFlowTarget = flowTarget('Left');
    const rightFlowTarget = flowTarget('Right');
    this.flowLeft = approach(this.flowLeft, leftFlowTarget, 0.9, dt);
    this.flowRight = approach(this.flowRight, rightFlowTarget, 0.9, dt);
    const averageFlow = (this.flowLeft + this.flowRight) / 2;

    this.voidFractions = this.voidFractions.map((value, i) =>
      approach(
        value,
        clamp(
          0.035 +
            this.power * 0.00085 +
            Math.max(0, 100 - (i ? this.flowRight : this.flowLeft)) * 0.0045 -
            (this.loopPressures[i] - PHYSICS.nominalPressure) * 0.04 +
            (!i ? effects.leak * 0.08 : 0),
          0.02,
          0.82,
        ),
        0.45,
        dt,
      ),
    );
    this.voidFraction = (this.voidFractions[0] + this.voidFractions[1]) / 2;

    const poison = poisonStep(this.iodine, this.xenon, this.power / 100, dt);
    this.iodine = poison.iodine;
    this.xenon = poison.xenon;

    const weightedInsertion =
      this.rods.manualRodInsertion * 0.55 +
      this.rods.automaticRodInsertion * 0.3 +
      this.rods.shortenedRodInsertion * 0.15;
    this.orm = clamp(30 + (weightedInsertion - 41.25) * 0.42, 0, 100);
    const rodEffect =
      (45 - this.rods.manualRodInsertion) * 0.036 +
      (45 - this.rods.automaticRodInsertion) * 0.012 +
      (20 - this.rods.shortenedRodInsertion) * 0.008;
    const voidEffect = (this.voidFraction - 0.12) * 1.35;
    const xenonEffect = -(this.xenon - 1) * 0.38;
    const thermalEffect =
      -(this.fuelTemperature - 700) * 0.0013 +
      (this.graphiteTemperature - 640) * 0.0003;
    this.reactivity =
      rodEffect +
      voidEffect +
      xenonEffect +
      thermalEffect -
      (2 * this.fastProtectionInsertion) / 100;
    const neutrons = neutronStep(
      this.power / 100,
      this.precursors,
      this.reactivity * PHYSICS.beta,
      dt,
    );
    this.power = neutrons.power * 100;
    this.precursors = neutrons.precursors;
    if (this.power > 500) {
      this.validity = 'outside-domain';
      this.power = 500;
      this.scram('Выход за область точечной модели');
    }

    const injection =
      c.eccsAvailable && c.emergencyInjection
        ? Math.min(1, this.equipment.eccsCapacity)
        : 0;
    const heatWeights = [0.004, 0.008, 0.015, 0.018, 0.012, 0.008];
    const heatTimes = [1, 10, 100, 1000, 10000, 100000];
    this.decayHeatGroups = this.decayHeatGroups.map((heat, index) =>
      approach(
        heat,
        ((PHYSICS.thermalMW * this.power) / 100) * heatWeights[index],
        1 / heatTimes[index],
        dt,
      ),
    );
    this.decayHeatMW = this.decayHeatGroups.reduce((a, b) => a + b, 0);
    this.thermalPowerMW =
      (PHYSICS.thermalMW * 0.935 * this.power) / 100 + this.decayHeatMW;
    const fuelHeats = this.fuelTemperatures.map(
      (temperature, i) =>
        ((PHYSICS.thermalMW * 0.95) / 2 / (700 - 284.5)) *
        Math.max(0.05, ((i ? this.flowRight : this.flowLeft) / 100) ** 0.8) *
        (temperature -
          (284.5 + (this.loopPressures[i] - PHYSICS.nominalPressure) * 8)),
    );
    const graphiteHeat =
      ((PHYSICS.thermalMW * 0.05) / (640 - 284.5)) *
      (this.graphiteTemperature - this.coolantTemperature);
    this.fuelTemperatures = this.fuelTemperatures.map(
      (temperature, i) =>
        temperature +
        (((this.thermalPowerMW * 0.95) / 2 - fuelHeats[i]) / 30) * dt,
    );
    this.fuelTemperature =
      (this.fuelTemperatures[0] + this.fuelTemperatures[1]) / 2;
    this.graphiteTemperature +=
      ((this.thermalPowerMW * 0.05 - graphiteHeat) / 2890) * dt;
    const steamFlows = [];
    const cycleFlows = [];
    for (let index = 0; index < 2; index++) {
      const side = index ? 'Right' : 'Left';
      const oldMass = this.loopMasses[index];
      const oldEnergy = this.loopEnergies[index];
      const internal = oldEnergy / oldMass;
      const pressure = Math.max(0.1, this.loopPressures[index]);
      const turbine = index + 1;
      const load = index ? c.turbineLoad2 : c.turbineLoad1;
      const breaker = index ? c.generatorBreaker2 : c.generatorBreaker1;
      const turbineSteam =
        (breaker
          ? (load / 500) * this.equipment[`turbineValve${turbine}`]
          : 0) *
        750 *
        Math.sqrt(pressure / PHYSICS.nominalPressure);
      const dump = (c.steamDump / 100) * 750;
      const steam = turbineSteam + dump;
      const feed = Math.min(
        this.cycle.returnMass[index] / dt,
        ((index ? effects.feedwaterRight : effects.feedwaterLeft) / 100) *
          750 *
          this.equipment[`feedCapacity${side}`],
      );
      const leak = !index && effects.leak ? 150 : 0;
      const addedWater = Math.min(
        injection * 220,
        this.cycle.injectionMass[index] / dt,
      );
      const blowdown = this.equipment.blowdownKgS / 2;
      const heat =
        fuelHeats[index] + graphiteHeat / 2 - this.equipment.cooldownMW / 2;
      const massRate = feed + addedWater - steam - leak - blowdown;
      const energyRate =
        heat +
        (feed * this.cycle.returnEnergy[index]) /
          Math.max(1, this.cycle.returnMass[index]) +
        addedWater * 0.17 -
        steam * 2.8 -
        (leak + blowdown) * internal;
      this.loopMasses[index] += massRate * dt;
      this.loopEnergies[index] += energyRate * dt;
      this.massResiduals[index] +=
        this.loopMasses[index] - oldMass - massRate * dt;
      this.energyResiduals[index] +=
        this.loopEnergies[index] - oldEnergy - energyRate * dt;
      this.loopPressures[index] =
        PHYSICS.nominalPressure +
        (this.loopEnergies[index] / this.loopMasses[index] - 1.26) / 0.06;
      if (
        this.loopMasses[index] < 350000 ||
        this.loopPressures[index] < 0.1 ||
        this.loopPressures[index] > 12
      )
        this.validity = 'outside-domain';
      steamFlows.push(steam);
      cycleFlows.push({
        feed,
        steam: turbineSteam,
        dump,
        injection: addedWater,
        leak,
        blowdown,
        loopSpecific: internal,
        cooldown: this.equipment.cooldownMW / 2,
      });
    }
    this.coolantInventory = (this.loopMasses[0] + this.loopMasses[1]) / 14000;
    this.drumLevelLeft = (this.loopMasses[0] - 700000) / 100;
    this.drumLevelRight = (this.loopMasses[1] - 700000) / 100;
    this.geometricLevels = this.loopMasses.map(
      (mass, i) => (mass - 700000) / 100 + 700 * (this.voidFractions[i] - 0.12),
    );
    this.pressure = (this.loopPressures[0] + this.loopPressures[1]) / 2;
    this.coolantTemperature =
      284.5 + (this.pressure - PHYSICS.nominalPressure) * 8;
    this.steamFlow = (steamFlows[0] + steamFlows[1]) / 15;

    const turbinePowerTarget = updateCycle(this, cycleFlows, dt);
    if (
      this.cycle.returnEnergy.some((value) => value <= 0) ||
      this.fuelTemperatures.some((value) => value < 0 || value > 2000)
    )
      this.validity = 'outside-domain';
    this.electricalPower = approach(
      this.electricalPower,
      turbinePowerTarget,
      0.7,
      dt,
    );
    this.frequency = approach(
      this.frequency,
      turbinePowerTarget ? 50 : 0,
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

    const averageDrum = Math.min(this.drumLevelLeft, this.drumLevelRight);
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
                : Math.max(...this.fuelTemperatures) > 1050
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
    if (this.equipment.suzFlow < 75)
      this.alarms.push('РАСХОД ОХЛАЖДЕНИЯ СУЗ НИЗКИЙ');
    if (this.equipment.suzTemperature > 60)
      this.alarms.push('ТЕМПЕРАТУРА ОХЛАЖДЕНИЯ СУЗ');
    if (this.equipment.gasFlow < 50) this.alarms.push('РАСХОД ГАЗА НИЗКИЙ');
    if (this.equipment.gasPressure > 1.5)
      this.alarms.push('ДАВЛЕНИЕ ГАЗА ВЫСОКОЕ');
    if (
      this.equipment.condenserPressure1 > 18 ||
      this.equipment.condenserPressure2 > 18
    )
      this.alarms.push('ВАКУУМ КОНДЕНСАТОРА НИЗКИЙ');
    if (this.validity === 'outside-domain')
      this.alarms.push('ВНЕ ОБЛАСТИ МОДЕЛИ');
    if (this.scrammed) this.alarms.push(`АЗ-5 · ${this.scramReason}`);
    if (this.alarms.some((alarm) => !previousAlarms.includes(alarm)))
      this.equipment.acknowledged = false;
  }

  restore(raw) {
    const candidate = new RbmkModel();
    if (!candidate.restoreState(raw)) return false;
    Object.assign(this, candidate);
    return true;
  }

  restoreState(raw) {
    if (!raw || raw.modelVersion !== RBMK_MODEL_VERSION || !raw.controls)
      return false;
    for (const name of Object.keys(RBMK_CONTROLS)) {
      const schema = RBMK_CONTROLS[name];
      if (raw.controls[name] === undefined) return false;
      if (schema.type === 'checkbox' && typeof raw.controls[name] !== 'boolean')
        return false;
      if (
        schema.type === 'select' &&
        !Object.hasOwn(schema.options, raw.controls[name])
      )
        return false;
      if (schema.type === 'range') {
        const value = Number(raw.controls[name]);
        if (!Number.isFinite(value) || value < schema.min || value > schema.max)
          return false;
        this.controls[name] = value;
      } else this.controls[name] = raw.controls[name];
    }
    const ranges = {
      power: [0, 500],
      pressure: [0, 15],
      drumLevelLeft: [-10000, 10000],
      drumLevelRight: [-10000, 10000],
      coolantInventory: [0, 250],
      flowLeft: [0, 150],
      flowRight: [0, 150],
      measuredFlowLeft: [0, 150],
      measuredFlowRight: [0, 150],
      voidFraction: [0, 1],
      coolantTemperature: [0, 500],
      fuelTemperature: [0, 5000],
      graphiteTemperature: [0, 5000],
      iodine: [0, 10],
      xenon: [0, 20],
      orm: [0, 100],
      reactivity: [-10, 10],
      steamFlow: [0, 160],
      electricalPower: [0, 1100],
      frequency: [0, 55],
      elapsed: [0, 1e9],
      fastProtectionInsertion: [0, 100],
      thermalPowerMW: [0, 20000],
      decayHeatMW: [0, 2000],
    };
    for (const [name, [min, max]] of Object.entries(ranges)) {
      if (!Number.isFinite(raw[name]) || raw[name] < min || raw[name] > max)
        return false;
    }
    for (const name of Object.keys(ranges)) this[name] = raw[name];
    if (
      !raw.rods ||
      !Object.keys(this.rods).every(
        (name) =>
          Number.isFinite(raw.rods[name]) &&
          raw.rods[name] >= 0 &&
          raw.rods[name] <= 100,
      )
    )
      return false;
    this.rods = { ...raw.rods };
    for (const [name, length, minimum, maximum] of [
      ['fuelTemperatures', 2, 0, 5000],
      ['voidFractions', 2, 0, 1],
      ['geometricLevels', 2, -20000, 20000],
      ['precursors', 6, 0, 1e8],
      ['decayHeatGroups', 6, 0, 1e4],
      ['loopMasses', 2, 1, 2e6],
      ['loopEnergies', 2, 1, 1e7],
      ['loopPressures', 2, -10, 20],
      ['massResiduals', 2, -1000, 1000],
      ['energyResiduals', 2, -1000, 1000],
    ]) {
      if (
        !Array.isArray(raw[name]) ||
        raw[name].length !== length ||
        !raw[name].every(
          (value) =>
            Number.isFinite(value) && value >= minimum && value <= maximum,
        )
      )
        return false;
      this[name] = [...raw[name]];
    }
    if (
      !raw.equipment ||
      !Object.entries(initialEquipment()).every(([name, value]) =>
        typeof value === 'boolean'
          ? typeof raw.equipment[name] === 'boolean'
          : Number.isFinite(raw.equipment[name]) &&
            Math.abs(raw.equipment[name]) <= 1e9,
      )
    )
      return false;
    this.equipment = { ...raw.equipment };
    if (!cycleIsValid(raw.cycle)) return false;
    this.cycle = structuredClone(raw.cycle);
    if (!['reduced-model', 'outside-domain'].includes(raw.validity))
      return false;
    this.validity = raw.validity;
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
      fuelTemperatures: [...this.fuelTemperatures],
      voidFractions: [...this.voidFractions],
      geometricLevels: [...this.geometricLevels],
      cycle: structuredClone(this.cycle),
      graphiteTemperature: this.graphiteTemperature,
      iodine: this.iodine,
      xenon: this.xenon,
      rods: { ...this.rods },
      precursors: [...this.precursors],
      decayHeatGroups: [...this.decayHeatGroups],
      loopMasses: [...this.loopMasses],
      loopEnergies: [...this.loopEnergies],
      loopPressures: [...this.loopPressures],
      massResiduals: [...this.massResiduals],
      energyResiduals: [...this.energyResiduals],
      equipment: { ...this.equipment },
      fastProtectionInsertion: this.fastProtectionInsertion,
      thermalPowerMW: this.thermalPowerMW,
      decayHeatMW: this.decayHeatMW,
      validity: this.validity,
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
