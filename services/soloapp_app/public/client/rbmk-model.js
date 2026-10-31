const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const approach = (value, target, rate, dt) =>
  value + (target - value) * (1 - Math.exp(-rate * dt));

export const RBMK_CONTROLS = Object.freeze({
  targetPower: { min: 0, max: 110, step: 1, unit: '% Nном' },
  rodInsertion: { min: 0, max: 100, step: 1, unit: '%' },
  coolantFlow: { min: 40, max: 120, step: 1, unit: '%' },
  feedwaterFlow: { min: 0, max: 120, step: 1, unit: '%' },
  turbineLoad: { min: 0, max: 1000, step: 10, unit: 'МВт' },
  pumpsPerLoop: { min: 0, max: 4, step: 1, unit: 'ГЦН/петлю' },
});

export class RbmkModel {
  constructor() {
    this.reset();
  }

  reset() {
    this.controls = {
      targetPower: 100,
      rodInsertion: 45,
      coolantFlow: 100,
      feedwaterFlow: 100,
      turbineLoad: 1000,
      pumpsPerLoop: 4,
      eccsEnabled: true,
    };
    this.power = 100;
    this.pressure = 7;
    this.drumLevel = 0;
    this.voidFraction = 0.12;
    this.coreTemperature = 285;
    this.xenon = 0;
    this.orm = 33;
    this.reactivity = 0;
    this.scrammed = false;
    this.scramReason = '';
    this.elapsed = 0;
    this.alarms = [];
  }

  setControl(name, rawValue) {
    if (name === 'eccsEnabled') {
      this.controls.eccsEnabled = Boolean(rawValue);
      return this.controls.eccsEnabled;
    }
    const schema = RBMK_CONTROLS[name];
    if (!schema || !Number.isFinite(Number(rawValue))) return undefined;
    let value = clamp(Number(rawValue), schema.min, schema.max);
    if (schema.step >= 1) value = Math.round(value / schema.step) * schema.step;
    this.controls[name] = value;
    return value;
  }

  scram(reason = 'АЗ-5 нажата оператором') {
    this.scrammed = true;
    this.scramReason = reason;
    this.controls.rodInsertion = 100;
    this.controls.targetPower = 0;
  }

  clearScram() {
    if (this.power > 3) return false;
    this.scrammed = false;
    this.scramReason = '';
    this.controls.targetPower = 5;
    this.controls.rodInsertion = 75;
    return true;
  }

  step(rawDt) {
    const dt = clamp(Number(rawDt) || 0, 0, 0.25);
    if (!dt) return this.snapshot();
    this.elapsed += dt;
    const c = this.controls;
    const pumpFactor = c.pumpsPerLoop / 4;
    const effectiveFlow = c.coolantFlow * pumpFactor;
    const voidTarget = clamp(
      0.035 + this.power * 0.00085 + Math.max(0, 100 - effectiveFlow) * 0.004,
      0.02,
      0.78,
    );
    this.voidFraction = approach(this.voidFraction, voidTarget, 0.45, dt);

    const xenonTarget = clamp((100 - this.power) / 100, 0, 1);
    this.xenon = approach(
      this.xenon,
      xenonTarget,
      xenonTarget > this.xenon ? 0.018 : 0.006,
      dt,
    );
    this.orm = clamp(15 + c.rodInsertion * 0.4 - this.xenon * 9, 0, 55);

    const rodEffect = (45 - c.rodInsertion) * 0.033;
    const voidEffect = (this.voidFraction - 0.12) * 1.35;
    const xenonEffect = -this.xenon * 0.42;
    const regulatorEffect = (c.targetPower - this.power) * 0.004;
    this.reactivity = this.scrammed
      ? -5
      : clamp(rodEffect + voidEffect + xenonEffect + regulatorEffect, -2, 2);

    const demandedPower = this.scrammed
      ? 0.25
      : clamp(
          c.targetPower + rodEffect * 28 + voidEffect * 24 + xenonEffect * 20,
          0.25,
          135,
        );
    this.power = approach(
      this.power,
      demandedPower,
      this.scrammed ? 1.8 : 0.18 + Math.max(0, this.reactivity) * 0.18,
      dt,
    );

    const steamDemand = c.turbineLoad / 10;
    const pressureTarget = clamp(
      7 + (this.power - steamDemand) * 0.016,
      4.2,
      9.2,
    );
    this.pressure = approach(this.pressure, pressureTarget, 0.35, dt);
    const feedwaterImbalance = c.feedwaterFlow - this.power;
    this.drumLevel = clamp(
      this.drumLevel + feedwaterImbalance * 0.8 * dt,
      -1200,
      400,
    );
    const temperatureTarget =
      270 +
      this.power * 0.15 +
      Math.max(0, 90 - effectiveFlow) * 0.42 +
      Math.max(0, this.voidFraction - 0.3) * 55;
    this.coreTemperature = approach(
      this.coreTemperature,
      temperatureTarget,
      0.22,
      dt,
    );

    const automaticTrip =
      this.power > 120
        ? 'Превышение мощности 120%'
        : this.drumLevel <= -1100
          ? 'Уровень БС ниже −1100 мм'
          : c.pumpsPerLoop < 2
            ? 'Менее двух ГЦН в петле'
            : this.coreTemperature > 330
              ? 'Перегрев активной зоны'
              : '';
    if (automaticTrip && !this.scrammed) this.scram(automaticTrip);

    this.alarms = [];
    if (this.power > 110) this.alarms.push('МОЩНОСТЬ > 110%');
    if (this.pressure > 7.6) this.alarms.push('ДАВЛЕНИЕ КМПЦ ВЫСОКОЕ');
    if (this.drumLevel < -600) this.alarms.push('УРОВЕНЬ БС < −600 мм');
    if (effectiveFlow < 75) this.alarms.push('РАСХОД КМПЦ НИЗКИЙ');
    if (this.orm < 15) this.alarms.push('ОЗР < 15 стержней');
    if (!c.eccsEnabled) this.alarms.push('САОР ВЫВЕДЕНА');
    if (this.scrammed) this.alarms.push(`АЗ-5 · ${this.scramReason}`);
    return this.snapshot();
  }

  snapshot() {
    return {
      controls: { ...this.controls },
      power: this.power,
      pressure: this.pressure,
      drumLevel: this.drumLevel,
      voidFraction: this.voidFraction,
      coreTemperature: this.coreTemperature,
      xenon: this.xenon,
      orm: this.orm,
      reactivity: this.reactivity,
      scrammed: this.scrammed,
      scramReason: this.scramReason,
      elapsed: this.elapsed,
      alarms: [...this.alarms],
    };
  }
}
