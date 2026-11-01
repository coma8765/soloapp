// Published constants and explicit teaching estimates are distinguished in
// docs/RBMK_PHYSICS.md. This is a reduced modernised profile, not a plant model.
export const PHYSICS = Object.freeze({
  thermalMW: 3200,
  nominalPressure: 6.87,
  beta: 0.006,
  generationSeconds: 0.001, // lumped estimate
  manualTravelSeconds: 17.5,
  scramTravelSeconds: 12,
  iodineHalfLife: 6.57 * 3600,
  xenonHalfLife: 9.1 * 3600,
  xenonBurnout: 0.00004, // effective cross-section × nominal flux, estimate
});

// DOE-HDBK-1019/1-93, NP-02 p.30, table 3 (thermal U-235).
const halfLives = [55.7, 22.7, 6.2, 2.3, 0.61, 0.23];
const fractions = [0.00021, 0.00142, 0.00127, 0.00257, 0.00075, 0.00027];
const total = fractions.reduce((sum, value) => sum + value, 0);
export const NEUTRON_GROUPS = Object.freeze(
  halfLives.map((halfLife, index) =>
    Object.freeze({
      decay: Math.LN2 / halfLife,
      beta: (fractions[index] / total) * PHYSICS.beta,
    }),
  ),
);

export function equilibriumPrecursors(power = 1) {
  return NEUTRON_GROUPS.map(
    ({ beta, decay }) => (beta * power) / (PHYSICS.generationSeconds * decay),
  );
}

// Implicit solution of the seven point-kinetics equations. Precursor memory is
// retained; changing a setpoint does not directly change neutron power.
export function neutronStep(power, precursors, rho, dt) {
  let numerator = power;
  let denominator = 1 - (dt * (rho - PHYSICS.beta)) / PHYSICS.generationSeconds;
  NEUTRON_GROUPS.forEach(({ beta, decay }, index) => {
    const divisor = 1 + dt * decay;
    numerator += (dt * decay * precursors[index]) / divisor;
    denominator -=
      (dt * dt * decay * beta) / (PHYSICS.generationSeconds * divisor);
  });
  if (!(denominator > 0)) throw new RangeError('Point kinetics step diverged');
  const next = numerator / denominator;
  return {
    power: next,
    precursors: NEUTRON_GROUPS.map(
      ({ beta, decay }, index) =>
        (precursors[index] + (dt * beta * next) / PHYSICS.generationSeconds) /
        (1 + dt * decay),
    ),
  };
}

// Analytic production/decay/burnout at constant power during dt, including the
// coupled iodine transient. DOE-HDBK-1019/2-93, NP-03 pp.35–36.
export function poisonStep(iodine, xenon, power, dt) {
  const a = Math.LN2 / PHYSICS.iodineHalfLife;
  const lambdaX = Math.LN2 / PHYSICS.xenonHalfLife;
  const b = lambdaX + PHYSICS.xenonBurnout * power;
  const production = lambdaX + PHYSICS.xenonBurnout;
  const integral =
    Math.abs(b - a) < 1e-12
      ? dt * Math.exp(-b * dt)
      : (Math.exp(-a * dt) - Math.exp(-b * dt)) / (b - a);
  return {
    iodine: power + (iodine - power) * Math.exp(-a * dt),
    xenon:
      xenon * Math.exp(-b * dt) +
      (production * power * -Math.expm1(-b * dt)) / b +
      production * 0.95 * (iodine - power) * integral,
  };
}
