// Equipment topology follows MIFI-2021 chapters 1–5 and 8–13. Addresses are
// educational identifiers, not unverified plant panel addresses.
const toggle = (id, label, shortLabel, defaultValue = true) => ({
  id,
  type: 'checkbox',
  label,
  shortLabel,
  defaultValue,
});
const pumps = (prefix, label, count, operating) =>
  Array.from({ length: count }, (_, index) =>
    toggle(
      `${prefix}${index + 1}`,
      `${label} №${index + 1}`,
      `${label} ${index + 1}`,
      index < operating,
    ),
  );

export const EQUIPMENT_BANKS = Object.freeze([
  {
    kind: 'channels',
    title: 'ОХЛАЖДЕНИЕ СУЗ · ГАЗ',
    part: 'suz-cooling-gas',
    controls: [
      ...pumps('suzPump', 'НАСОС СУЗ', 4, 2),
      toggle('suzCoolingValve', 'Подача воды в контур СУЗ', 'ВОДА СУЗ'),
      toggle('suzHeatExchanger1', 'Теплообменник СУЗ №1', 'ТО СУЗ-1'),
      toggle('suzHeatExchanger2', 'Теплообменник СУЗ №2', 'ТО СУЗ-2', false),
      ...pumps('gasBlower', 'ГАЗОДУВКА', 2, 1),
      toggle('gasInletValve', 'Подача газа в кладку', 'ГАЗ ВХОД'),
      toggle('gasOutletValve', 'Отвод газа из кладки', 'ГАЗ ВЫХОД'),
    ],
  },
  {
    kind: 'thermal',
    title: 'ГЦН · ПЭН · АРМАТУРА',
    part: 'drum-feedwater',
    controls: [
      ...pumps('mcpLeft', 'ГЦН-Л', 4, 3),
      ...pumps('mcpRight', 'ГЦН-П', 4, 3),
      ...pumps('mcpValveLeft', 'ЗАДВ. ГЦН-Л', 4, 4),
      ...pumps('mcpValveRight', 'ЗАДВ. ГЦН-П', 4, 4),
      ...pumps('feedPumpLeft', 'ПЭН-Л', 3, 2),
      ...pumps('feedPumpRight', 'ПЭН-П', 3, 2),
      toggle(
        'feedIsolationLeft',
        'Питательная линия левой петли',
        'ПВ-Л ЛИНИЯ',
      ),
      toggle(
        'feedIsolationRight',
        'Питательная линия правой петли',
        'ПВ-П ЛИНИЯ',
      ),
    ],
  },
  {
    kind: 'turbines',
    title: 'АРМАТУРА ТГ · КОНДЕНСАТОРЫ',
    part: 'turbines',
    controls: [
      toggle('steamAdmission1', 'Стопорный клапан ТГ-1', 'СТОП ТГ-1'),
      toggle('steamAdmission2', 'Стопорный клапан ТГ-2', 'СТОП ТГ-2'),
      toggle('condenserCooling1', 'Охлаждение конденсатора ТГ-1', 'КОНДЕНС.-1'),
      toggle('condenserCooling2', 'Охлаждение конденсатора ТГ-2', 'КОНДЕНС.-2'),
      toggle(
        'generatorExcitation1',
        'Возбуждение генератора ТГ-1',
        'ВОЗБУЖД.-1',
      ),
      toggle(
        'generatorExcitation2',
        'Возбуждение генератора ТГ-2',
        'ВОЗБУЖД.-2',
      ),
      toggle('serviceWaterPump1', 'Насос технической воды №1', 'ТЕХВОДА-1'),
      toggle('serviceWaterPump2', 'Насос технической воды №2', 'ТЕХВОДА-2'),
    ],
  },
  {
    kind: 'alarms',
    title: 'САОР · СПиР · СИГНАЛЫ',
    part: 'eccs',
    controls: [
      ...pumps('eccsChannel', 'КАНАЛ САОР', 3, 3),
      ...pumps('eccsValve', 'ЗАДВ. САОР', 3, 3),
      ...pumps('cooldownPump', 'НАСОС СПиР', 2, 1),
      toggle('cooldownValve', 'Отвод тепла через СПиР', 'ОТВОД СПиР', false),
      toggle('blowdownValve', 'Продувка КМПЦ', 'ПРОДУВКА', false),
    ],
    actions: ['acknowledge', 'lamp-test'],
  },
]);

export const EQUIPMENT_CONTROLS = Object.freeze(
  Object.fromEntries(
    EQUIPMENT_BANKS.flatMap((bank) =>
      bank.controls.map(({ id, ...schema }) => [id, schema]),
    ),
  ),
);
export const equipmentDefaults = () =>
  Object.fromEntries(
    Object.entries(EQUIPMENT_CONTROLS).map(([name, schema]) => [
      name,
      schema.defaultValue,
    ]),
  );

export function initialEquipment() {
  return {
    suzFlow: 100,
    suzTemperature: 40,
    suzTank: 100,
    gasFlow: 100,
    gasPressure: 1,
    gasHumidity: 0.1,
    condenserPressure1: 5,
    condenserPressure2: 5,
    turbineValve1: 1,
    turbineValve2: 1,
    generatorVoltage1: 21,
    generatorVoltage2: 21,
    feedCapacityLeft: 1,
    feedCapacityRight: 1,
    eccsCapacity: 1,
    cooldownMW: 0,
    blowdownKgS: 0,
    acknowledged: false,
    lampTestUntil: 0,
    ...Object.fromEntries(
      ['Left', 'Right'].flatMap((side) =>
        Array.from({ length: 4 }, (_, i) => [
          `pumpSpeed${side}${i + 1}`,
          i < 3 ? 1 : 0,
        ]),
      ),
    ),
  };
}

export function updateEquipment(state, controls, power, graphite, elapsed, dt) {
  const approach = (value, target, rate) =>
    value + (target - value) * -Math.expm1(-rate * dt);
  const count = (prefix, maximum) =>
    Array.from({ length: maximum }, (_, i) =>
      Number(controls[`${prefix}${i + 1}`]),
    ).reduce((a, b) => a + b, 0);
  const lostPower = controls.scenario === 'loss-offsite-power';
  const result = {};
  for (const side of ['Left', 'Right']) {
    let operating = 0;
    for (let i = 1; i <= 4; i++) {
      const target =
        !lostPower &&
        !(side === 'Left' && controls.scenario === 'mcp-left-trip' && i > 1) &&
        controls[`mcp${side}${i}`] &&
        controls[`mcpValve${side}${i}`]
          ? 1
          : 0;
      const key = `pumpSpeed${side}${i}`;
      state[key] = approach(state[key], target, 0.3);
      operating += state[key];
    }
    result[`pumps${side}`] = operating;
    const capacity =
      !lostPower && controls[`feedIsolation${side}`]
        ? Math.min(1.5, count(`feedPump${side}`, 3) / 2)
        : 0;
    state[`feedCapacity${side}`] = approach(
      state[`feedCapacity${side}`],
      capacity,
      0.4,
    );
  }
  const technicalWater = !lostPower ? count('serviceWaterPump', 2) / 2 : 0;
  const suzPumps = lostPower ? 0 : count('suzPump', 4);
  const suzFlow = controls.suzCoolingValve
    ? suzPumps
      ? Math.min(150, suzPumps * 50)
      : state.suzTank > 0
        ? 100
        : 0
    : 0;
  state.suzFlow = approach(state.suzFlow, suzFlow, 0.3);
  if (!suzPumps && suzFlow > 0)
    state.suzTank = Math.max(0, state.suzTank - (100 / 180) * dt);
  else if (suzPumps) state.suzTank = Math.min(100, state.suzTank + 0.5 * dt);
  const suzHeat = (power / 100) * 2;
  const suzRemoval =
    Number(controls.suzHeatExchanger1 || controls.suzHeatExchanger2) *
    technicalWater *
    Math.max(0, state.suzTemperature - 30) *
    0.2;
  state.suzTemperature += ((suzHeat - suzRemoval) / 20) * dt;
  const gasFlow =
    controls.gasInletValve && controls.gasOutletValve && !lostPower
      ? count('gasBlower', 2) * 100
      : 0;
  state.gasFlow = approach(state.gasFlow, gasFlow, 0.25);
  state.gasPressure = approach(
    state.gasPressure,
    controls.gasOutletValve
      ? Math.max(0.1, gasFlow / 100)
      : controls.gasInletValve
        ? 1.8
        : 1,
    0.1,
  );
  const humidityInput = controls.scenario === 'small-loca' ? 0.006 : 0;
  state.gasHumidity = Math.max(
    0,
    state.gasHumidity +
      (humidityInput -
        (((state.gasHumidity - 0.1) * state.gasFlow) / 100) * 0.02) *
        dt,
  );
  for (let i = 1; i <= 2; i++) {
    const cooling = controls[`condenserCooling${i}`] && technicalWater > 0;
    state[`condenserPressure${i}`] = approach(
      state[`condenserPressure${i}`],
      cooling ? 5 : 30,
      0.07,
    );
    const available =
      !lostPower &&
      controls.scenario !== 'turbine-trip' &&
      controls[`steamAdmission${i}`] &&
      state[`condenserPressure${i}`] < 18;
    state[`turbineValve${i}`] = approach(
      state[`turbineValve${i}`],
      available ? 1 : 0,
      0.9,
    );
    state[`generatorVoltage${i}`] = approach(
      state[`generatorVoltage${i}`],
      controls[`generatorExcitation${i}`] && !lostPower ? 21 : 0,
      0.6,
    );
  }
  state.eccsCapacity = Array.from(
    { length: 3 },
    (_, i) =>
      Number(controls[`eccsChannel${i + 1}`] && controls[`eccsValve${i + 1}`]) *
      0.5,
  ).reduce((a, b) => a + b, 0);
  state.cooldownMW =
    controls.cooldownValve &&
    !lostPower &&
    technicalWater > 0 &&
    count('cooldownPump', 2)
      ? Math.min(60, Math.max(0, graphite - 40) * 0.1)
      : 0;
  state.blowdownKgS = controls.blowdownValve ? 15 : 0;
  if (elapsed >= state.lampTestUntil) state.lampTestUntil = 0;
  return result;
}
