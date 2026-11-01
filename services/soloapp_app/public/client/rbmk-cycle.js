// Closed reduced steam/condensate cycle. kg, MJ, seconds, MPa.
// Volumes, head curves and thermal coefficients are teaching estimates.
export const FEED_ENTHALPY = 2.8 - 3200 / 1500;
export const RETURN_MASS = 200000;
export const INJECTION_MASS = 60000;

export function initialCycle() {
  return {
    returnMass: [RETURN_MASS, RETURN_MASS],
    returnEnergy: [RETURN_MASS * FEED_ENTHALPY, RETURN_MASS * FEED_ENTHALPY],
    injectionMass: [INJECTION_MASS, INJECTION_MASS],
    escapedMass: 0,
    escapedEnergy: 0,
    rejectedEnergy: 0,
    generatedEnergy: 0,
    producedEnergy: 0,
    massError: 0,
    energyError: 0,
    feed: [750, 750],
    steam: [750, 750],
    dump: [0, 0],
    injection: [0, 0],
    leak: [0, 0],
    coolingMW: [1100, 1100],
  };
}

export function cycleIsValid(cycle) {
  if (!cycle || typeof cycle !== 'object') return false;
  return Object.entries(initialCycle()).every(([key, initial]) => {
    const values = Array.isArray(initial) ? cycle[key] : [cycle[key]];
    return (
      Array.isArray(values) &&
      values.length === (Array.isArray(initial) ? 2 : 1) &&
      values.every((v) => Number.isFinite(v) && Math.abs(v) < 1e12) &&
      (!['returnMass', 'injectionMass'].includes(key) ||
        values.every((v) => v >= 0))
    );
  });
}

// Parallel pump head curves intersect the shared quadratic network loss.
// No linear multiplication of requested flow by the pump count.
export function hydraulicFlow(speeds, opening, heatFraction) {
  const resistance = 1 / Math.max(0.05, opening) ** 2;
  const naturalHead = 0.01 * Math.cbrt(Math.max(0, heatFraction)) ** 2;
  let low = 0,
    high = 3;
  for (let i = 0; i < 32; i++) {
    const q = (low + high) / 2;
    const head = resistance * q * q;
    const pumps = speeds.reduce(
      (sum, speed) =>
        sum +
        Math.sqrt(Math.max(0, 1.99 * speed * speed + naturalHead - head) / 9),
      0,
    );
    const bypass = Math.sqrt(naturalHead / resistance);
    if (Math.max(pumps, bypass) > q) low = q;
    else high = q;
  }
  return (low + high) * 50;
}

export function storedMass(model) {
  return [
    ...model.loopMasses,
    ...model.cycle.returnMass,
    ...model.cycle.injectionMass,
  ].reduce((a, b) => a + b, 0);
}

export function storedEnergy(model) {
  return (
    model.loopEnergies.reduce((a, b) => a + b, 0) +
    model.cycle.returnEnergy.reduce((a, b) => a + b, 0) +
    model.cycle.injectionMass.reduce((a, b) => a + b, 0) * 0.17 +
    model.fuelTemperatures.reduce((a, b) => a + b, 0) * 30 +
    model.graphiteTemperature * 2890
  );
}

export const INITIAL_MASS = 1400000 + 2 * RETURN_MASS + 2 * INJECTION_MASS;
export const INITIAL_ENERGY =
  1764000 +
  2 * RETURN_MASS * FEED_ENTHALPY +
  2 * INJECTION_MASS * 0.17 +
  60 * 700 +
  2890 * 640;

export function updateCycle(model, flows, dt) {
  const c = model.cycle;
  const controls = model.controls;
  const powered = controls.scenario !== 'loss-offsite-power';
  const technicalWater = powered
    ? (Number(controls.serviceWaterPump1) +
        Number(controls.serviceWaterPump2)) /
      2
    : 0;
  let electric = 0;
  flows.forEach((f, i) => {
    const specific = c.returnEnergy[i] / Math.max(1, c.returnMass[i]);
    const cooling = controls[`condenserCooling${i + 1}`] ? technicalWater : 0;
    const rejected = Math.max(
      0,
      (1100 * cooling * (specific - 0.1)) / (FEED_ENTHALPY - 0.1),
    );
    const generated =
      f.steam *
      (2 / 3) *
      Math.min(1, model.equipment[`generatorVoltage${i + 1}`] / 21);
    // The return vessel aggregates condenser, condensate train and deaerator.
    // Feed enthalpy is withdrawn from the same finite reservoir that receives steam.
    c.returnMass[i] += (f.steam + f.dump - f.feed) * dt;
    c.returnEnergy[i] +=
      ((f.steam + f.dump) * 2.8 - f.feed * specific - rejected - generated) *
      dt;
    c.injectionMass[i] = Math.max(0, c.injectionMass[i] - f.injection * dt);
    c.escapedMass += (f.leak + f.blowdown) * dt;
    c.escapedEnergy += (f.leak + f.blowdown) * f.loopSpecific * dt;
    c.rejectedEnergy += (rejected + f.cooldown) * dt;
    c.generatedEnergy += generated * dt;
    electric += generated;
    c.coolingMW[i] = rejected;
    for (const key of ['feed', 'steam', 'dump', 'injection', 'leak'])
      c[key][i] = f[key];
    const temperatureRise =
      (c.returnEnergy[i] / Math.max(1, c.returnMass[i]) - FEED_ENTHALPY) /
      0.0042;
    // Estimated condenser response to actual return heat, not an on/off animation.
    model.equipment[`condenserPressure${i + 1}`] = Math.max(
      1,
      5 + 0.5 * temperatureRise,
    );
  });
  c.producedEnergy += model.thermalPowerMW * dt;
  c.massError = storedMass(model) + c.escapedMass - INITIAL_MASS;
  c.energyError =
    storedEnergy(model) +
    c.escapedEnergy +
    c.rejectedEnergy +
    c.generatedEnergy -
    c.producedEnergy -
    INITIAL_ENERGY;
  return electric;
}
