import { RBMK_CONTROLS } from './rbmk-data.js';

const B = window.BABYLON;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const point = (p) => new B.Vector3(...p);

// A separate explorable teaching room. Every animated value comes from the
// same model used by the control room; no second simulation or visual timers.
export class PhysicalSystemRoom {
  constructor(room) {
    this.room = room;
    this.scene = room.scene;
    this.root = new B.TransformNode('Physical system laboratory', this.scene);
    this.root.setEnabled(false);
    this.colliders = [];
    this.labels = [];
    this.routes = [];
    this.rotors = [];
    this.absorbers = [];
    this.bubbles = [];
    this.controls = [];
    this.materials = new Map();
    this.build();
  }

  material(color, alpha = 1) {
    const key = color + alpha;
    if (this.materials.has(key)) return this.materials.get(key);
    const m = this.room.material('Physical ' + key, color, true, alpha);
    this.materials.set(key, m);
    return m;
  }

  mesh(kind, name, options, position, color, alpha = 1) {
    const mesh = B.MeshBuilder[kind](name, options, this.scene);
    mesh.parent = this.root;
    mesh.position.copyFromFloats(...position);
    mesh.material = this.material(color, alpha);
    mesh.isPickable = false;
    return mesh;
  }

  box(name, position, size, color) {
    return this.mesh(
      'CreateBox',
      name,
      { width: size[0], height: size[1], depth: size[2] },
      position,
      color,
    );
  }

  label(name, position, width, height, content, accent = '#68d9d4') {
    const mesh = this.mesh(
      'CreatePlane',
      name,
      { width, height },
      position,
      '#ffffff',
    );
    const texture = new B.DynamicTexture(
      name,
      { width: 1024, height: Math.round((1024 * height) / width) },
      this.scene,
      false,
    );
    const material = new B.StandardMaterial(name + ' text', this.scene);
    material.diffuseTexture = texture;
    material.emissiveColor = B.Color3.White();
    material.disableLighting = true;
    material.backFaceCulling = false;
    mesh.material = material;
    const entry = { mesh, texture, content, accent, last: '' };
    this.labels.push(entry);
    return entry;
  }

  button(label, position, data, width = 0.72) {
    const mesh = this.box(
      'Physical button ' + label,
      position,
      [width, 0.34, 0.18],
      '#216b73',
    );
    mesh.isPickable = true;
    mesh.metadata = { physicalSystem: data };
    const caption = this.label(
      label,
      [position[0], position[1], position[2] + 0.1],
      width,
      0.3,
      () => [label],
    );
    caption.mesh.isPickable = false;
    this.controls.push(mesh);
    return mesh;
  }

  control(name, position, width = 2.4) {
    const schema = RBMK_CONTROLS[name];
    const [x, y, z] = position;
    const label = this.label(
      'Control ' + name,
      [x, y + 0.37, z],
      width,
      0.54,
      (s) => [
        schema.label,
        schema.type === 'checkbox'
          ? s.controls[name]
            ? 'Команда: ВКЛ'
            : 'Команда: ВЫКЛ'
          : schema.type === 'select'
            ? schema.options[s.controls[name]]
            : `Задание: ${s.controls[name]} ${schema.unit || ''}`,
      ],
    );
    if (schema.type === 'checkbox')
      this.button('ВКЛ / ВЫКЛ', [x, y, z], { control: name }, width);
    else {
      this.button('−', [x - width / 3, y, z], { control: name, delta: -1 });
      this.button('+', [x + width / 3, y, z], { control: name, delta: 1 });
    }
    return label;
  }

  route(name, points, color, flow) {
    const path = points.map(point);
    const tube = B.MeshBuilder.CreateTube(
      name,
      { path, radius: 0.055, tessellation: 6 },
      this.scene,
    );
    tube.parent = this.root;
    tube.material = this.material(color, 0.55);
    tube.isPickable = false;
    const distances = [0];
    for (let i = 1; i < path.length; i++)
      distances.push(
        distances[i - 1] + B.Vector3.Distance(path[i - 1], path[i]),
      );
    const markers = Array.from({ length: 6 }, (_, i) =>
      this.mesh(
        'CreateSphere',
        name + ' flow ' + i,
        { diameter: 0.13, segments: 4 },
        points[0],
        color,
      ),
    );
    this.routes.push({ path, distances, markers, flow, phase: 0 });
  }

  build() {
    this.box('Laboratory floor', [0, -0.12, 0], [24, 0.24, 24], '#12252e');
    this.box('Laboratory ceiling', [0, 6.1, 0], [24, 0.2, 24], '#172b35');
    this.box('Laboratory back', [0, 3, -12], [24, 6, 0.2], '#12212a');
    for (const x of [-12, 12])
      this.box('Laboratory side', [x, 3, 0], [0.2, 6, 24], '#172b35');
    for (let i = -11; i <= 11; i += 2) {
      this.box('Floor grid', [i, 0.012, 0], [0.014, 0.012, 24], '#294652');
      this.box('Floor grid', [0, 0.012, i], [24, 0.012, 0.014], '#294652');
    }
    this.label('Physical laboratory title', [0, 5.2, -3.8], 8.3, 1, () => [
      'РБМК / ФИЗИЧЕСКАЯ СИСТЕМА',
      'Топливо → теплоноситель → пар → электричество',
      'P · БЩУ ↔ разрез   |   L1 + R1   |   VR: оба grip',
    ]);
    this.label(
      'Limits',
      [0, 0.4, -1.3],
      5.3,
      0.62,
      () => [
        'Учебный разрез · геометрия и цвета условные',
        '2 тепловые зоны · точечная нейтроника · без расчёта повреждений',
      ],
      '#d8b579',
    );

    this.box('Core plinth', [0, 0.25, -4.4], [3.7, 0.5, 3.2], '#30434d');
    this.mesh(
      'CreateCylinder',
      'Core cutaway outline',
      {
        diameter: 3.5,
        height: 3.3,
        tessellation: 32,
        arc: 0.65,
        enclose: false,
      },
      [0, 2.1, -4.4],
      '#6c8792',
      0.17,
    );
    this.fuelMaterials = [0, 1].map((i) => {
      const m = new B.StandardMaterial('Thermal zone ' + i, this.scene);
      m.disableLighting = true;
      return m;
    });
    for (let x = -1; x <= 1; x += 0.5) {
      for (let z = -5.25; z <= -3.65; z += 0.8) {
        const side = x < 0 ? 0 : 1;
        const fuel = this.mesh(
          'CreateCylinder',
          'Fuel channel',
          { diameter: 0.13, height: 2.55, tessellation: 8 },
          [x, 2, z],
          '#ce8145',
        );
        fuel.material = this.fuelMaterials[side];
        for (let b = 0; b < 2; b++) {
          const bubble = this.mesh(
            'CreateSphere',
            'Illustrated steam bubble',
            { diameter: 0.1, segments: 4 },
            [x + 0.06, 3, z + 0.06],
            '#f6d5a4',
          );
          this.bubbles.push({ mesh: bubble, side, phase: b / 2 + z });
        }
        this.box(
          'Graphite column',
          [x + 0.18, 1.9, z - 0.15],
          [0.16, 2.8, 0.24],
          '#4c5c60',
        );
        this.route(
          'Channel coolant',
          [
            [x - 0.12, 0.65, z],
            [x - 0.12, 3.3, z],
          ],
          '#61d5d2',
          (s) => (side ? s.flowRight : s.flowLeft) / 100,
        );
      }
    }
    for (const [i, name] of [
      'manualRodInsertion',
      'automaticRodInsertion',
      'shortenedRodInsertion',
    ].entries()) {
      const rod = this.mesh(
        'CreateCylinder',
        'Absorber ' + name,
        { diameter: 0.18, height: 2.2, tessellation: 8 },
        [-0.7 + i * 0.7, 3.5, -3.4],
        '#86a6ee',
      );
      this.absorbers.push({ rod, name });
    }
    this.label(
      'Core state',
      [0, 3.75, -3.3],
      3.8,
      0.9,
      (s) => [
        `Деления ${s.power.toFixed(1)}% · тепло ${s.thermalPowerMW.toFixed(0)} МВт`,
        `Топливо Л/П ${s.fuelTemperatures.map((v) => v.toFixed(0)).join(' / ')} °C`,
        `Остаточное тепло ${s.decayHeatMW.toFixed(1)} МВт`,
      ],
      '#f2bc79',
    );

    for (const i of [0, 1]) {
      const sign = i ? 1 : -1;
      const side = i ? 'Right' : 'Left';
      const sideText = i ? 'П' : 'Л';
      const x = sign * 4;
      this.mesh(
        'CreateCylinder',
        'Separator ' + side,
        { diameter: 1.1, height: 2.2, tessellation: 16 },
        [x, 3, -5.8],
        '#467581',
        0.8,
      ).rotation.z = Math.PI / 2;
      const rotor = this.mesh(
        'CreateTorus',
        'MCP rotor ' + side,
        { diameter: 0.9, thickness: 0.2, tessellation: 12 },
        [x, 1, -1.7],
        '#60c6ce',
      );
      this.rotors.push({ mesh: rotor, side });
      this.box('Pump pedestal', [x, 0.35, -1.7], [1.5, 0.7, 1.2], '#29424d');
      this.mesh(
        'CreateCylinder',
        'Turbine ' + side,
        { diameter: 1.1, height: 2, tessellation: 12 },
        [sign * 7.5, 1.7, -7.5],
        '#bc915c',
      ).rotation.z = Math.PI / 2;
      this.box(
        'Condenser ' + side,
        [sign * 8.4, 0.7, -3.8],
        [1.9, 1.4, 1.8],
        '#31546b',
      );
      this.mesh(
        'CreateCylinder',
        'Feed return ' + side,
        { diameter: 1.25, height: 1.8, tessellation: 16 },
        [sign * 8.4, 1.1, 0],
        '#376777',
      );
      this.route(
        'Hot mix ' + side,
        [
          [sign * 1.2, 3.25, -4.6],
          [x, 3.25, -4.6],
          [x, 3.25, -5.8],
        ],
        '#f0bb75',
        (s) => (i ? s.flowRight : s.flowLeft) / 100,
      );
      this.route(
        'Recirculation ' + side,
        [
          [x, 2.5, -5.8],
          [x, 0.8, -5.8],
          [x, 0.8, -1.7],
          [sign * 1.3, 0.8, -1.7],
          [sign * 1.3, 0.8, -4.4],
        ],
        '#61d5d2',
        (s) => (i ? s.flowRight : s.flowLeft) / 100,
      );
      this.route(
        'Steam ' + side,
        [
          [x, 3.3, -5.8],
          [x, 3.3, -7.5],
          [sign * 7.5, 3.3, -7.5],
          [sign * 7.5, 1.7, -7.5],
        ],
        '#efba77',
        (s) => s.cycle.steam[i] / 750,
      );
      this.route(
        'Exhaust ' + side,
        [
          [sign * 7.5, 1.7, -7.5],
          [sign * 8.4, 1.7, -7.5],
          [sign * 8.4, 0.9, -3.8],
        ],
        '#e6d1a8',
        (s) => s.cycle.steam[i] / 750,
      );
      this.route(
        'Condensate ' + side,
        [
          [sign * 8.4, 0.8, -3.8],
          [sign * 8.4, 0.8, 0],
        ],
        '#82b5ed',
        (s) => (s.cycle.steam[i] + s.cycle.dump[i]) / 750,
      );
      this.route(
        'Feed ' + side,
        [
          [sign * 8.4, 1.5, 0],
          [sign * 6, 1.5, 0],
          [sign * 6, 2.7, -5.8],
          [x, 2.7, -5.8],
        ],
        '#82b5ed',
        (s) => s.cycle.feed[i] / 750,
      );
      this.route(
        'Steam dump ' + side,
        [
          [x, 3.6, -5.8],
          [sign * 9.6, 3.6, -5.8],
          [sign * 9.6, 0.7, -3.8],
        ],
        '#d795ca',
        (s) => s.cycle.dump[i] / 750,
      );
      this.label('Loop state ' + side, [x, 2.55, -0.8], 3, 1.1, (s) => [
        `ПЕТЛЯ ${sideText} · ${s.loopPressures[i].toFixed(2)} МПа`,
        `Расход / прибор ${(i ? s.flowRight : s.flowLeft).toFixed(0)} / ${(i ? s.measuredFlowRight : s.measuredFlowLeft).toFixed(0)} %`,
        `Доля пара ${(s.voidFractions[i] * 100).toFixed(1)}% (оценка)`,
        `Вода ${(s.loopMasses[i] / 1000).toFixed(1)} т`,
      ]);
      this.label(
        'Turbine label ' + side,
        [sign * 7.5, 2.65, -6.7],
        3.1,
        0.7,
        (s) => [
          `ТУРБИНА ${i + 1} · пар ${s.cycle.steam[i].toFixed(0)} кг/с`,
          `Клапан ${(s.equipment['turbineValve' + (i + 1)] * 100).toFixed(0)}%`,
        ],
        '#f2bc79',
      );
      this.label(
        'Return label ' + side,
        [sign * 8.4, 2.55, 0.6],
        3,
        1.0,
        (s) => [
          'КОНДЕНСАТ → ПИТАНИЕ',
          `Возврат ${(s.cycle.returnMass[i] / 1000).toFixed(1)} т`,
          `Конденсатор ${s.equipment['condenserPressure' + (i + 1)].toFixed(1)} кПа`,
          `Теплоотвод ${s.cycle.coolingMW[i].toFixed(0)} МВт`,
        ],
        '#96bcec',
      );
    }

    // Three reachable control stations, with large ray targets for VR.
    const stations = [
      {
        x: -6.5,
        title: '01 / ВОДА И ЦИРКУЛЯЦИЯ',
        controls: [
          'pumpsLeft',
          'pumpsRight',
          'feedwaterLeft',
          'feedwaterRight',
          'emergencyInjection',
          'eccsAvailable',
        ],
      },
      {
        x: 0,
        title: '02 / НЕЙТРОНЫ И ТЕПЛО',
        controls: [
          'manualRodInsertion',
          'automaticRodInsertion',
          'targetPower',
          'automaticRegulator',
          'steamDump',
          'scenario',
        ],
      },
      {
        x: 6.5,
        title: '03 / ПАР И ЭЛЕКТРИЧЕСТВО',
        controls: [
          'turbineLoad1',
          'turbineLoad2',
          'condenserCooling1',
          'condenserCooling2',
          'serviceWaterPump1',
          'serviceWaterPump2',
        ],
      },
    ];
    for (const station of stations) {
      const z = station.x === 0 ? -9.3 : 3.4;
      this.box(station.title, [station.x, 1.3, z], [5.8, 2.6, 0.35], '#203945');
      this.label(station.title, [station.x, 2.95, z + 0.25], 5.8, 0.6, () => [
        station.title,
      ]);
      station.controls.forEach((name, i) =>
        this.control(name, [
          station.x + (i % 2 ? 1.45 : -1.45),
          2.1 - Math.floor(i / 2) * 0.73,
          z + 0.25,
        ]),
      );
    }
    this.button('АЗ-5', [-1.7, 0.35, 4], { action: 'scram' }, 1.4);
    this.button('СНЯТЬ АЗ', [0, 0.35, 4], { action: 'clear' }, 1.6);
    this.button('СБРОС УРОКА', [2, 0.35, 4], { action: 'reset' }, 2);
    this.button('P · В БЩУ', [-9.3, 1.5, 6.7], { view: true }, 2.5);
    this.label('Balance monitor', [0, 4.7, -10.9], 8, 1.6, (s) => [
      'БАЛАНСЫ / ВСПОМОГАТЕЛЬНЫЕ СИСТЕМЫ',
      `Невязка массы ${s.cycle.massError.toExponential(2)} кг · энергии ${s.cycle.energyError.toExponential(2)} МДж`,
      `САОР запас ${s.cycle.injectionMass.map((v) => (v / 1000).toFixed(1)).join(' / ')} т · утечки ${(s.cycle.escapedMass / 1000).toFixed(2)} т`,
      `СУЗ ${s.equipment.suzFlow.toFixed(0)}% / ${s.equipment.suzTemperature.toFixed(1)}°C · газ ${s.equipment.gasFlow.toFixed(0)}%`,
      `Иод ${s.iodine.toFixed(3)} · ксенон ${s.xenon.toFixed(3)} · время ${s.elapsed.toFixed(1)} с`,
      s.validity === 'outside-domain'
        ? 'ВНЕ ОБЛАСТИ МОДЕЛИ · сбросьте упражнение'
        : 'Сокращённая модель · коэффициенты требуют валидации',
    ]);
    this.update(0, true);
  }

  activate(mesh) {
    const data = mesh?.metadata?.physicalSystem;
    if (!data || !this.root.isEnabled()) return false;
    const now = performance.now();
    if (this.lastActivation && now - this.lastActivation < 180) return true;
    this.lastActivation = now;
    if (data.view) this.room.togglePhysical();
    else if (data.action) this.room.commitAction(data.action);
    else {
      const schema = RBMK_CONTROLS[data.control];
      const current = this.room.model.controls[data.control];
      let value;
      let operation;
      if (schema.type === 'checkbox') {
        value = !current;
        operation = { mode: 'toggle' };
      } else if (schema.type === 'select') {
        operation = { delta: data.delta };
        const keys = Object.keys(schema.options);
        value =
          keys[
            (keys.indexOf(current) + data.delta + keys.length) % keys.length
          ];
      } else {
        const step = data.control.startsWith('pumps')
          ? 1
          : data.control.startsWith('turbine')
            ? 50
            : 5;
        value = clamp(current + data.delta * step, schema.min, schema.max);
        operation = { delta: data.delta * step };
      }
      this.room.commitControl(data.control, value, operation);
    }
    this.update(0, true);
    return true;
  }

  update(dt, force = false) {
    if (!force && !this.root.isEnabled()) return;
    const s = this.room.model.snapshot();
    this.bubbles.forEach(({ mesh, side, phase }) => {
      const amount = s.voidFractions[side];
      mesh.setEnabled(amount > 0.025 && s.thermalPowerMW > 1);
      const travel =
        ((((s.elapsed * (side ? s.flowRight : s.flowLeft)) / 150 + phase) % 1) +
          1) %
        1;
      mesh.position.y = 3.3 - Math.min(2.5, amount * 5) * (1 - travel);
      mesh.scaling.setAll(0.5 + amount * 2);
    });
    this.absorbers.forEach(({ rod, name }) => {
      rod.position.y = 4.1 - (s.rods[name] / 100) * 2;
    });
    this.fuelMaterials.forEach((material, i) => {
      const t = clamp((s.fuelTemperatures[i] - 280) / 800, 0, 1);
      material.emissiveColor = new B.Color3(
        0.28 + 0.7 * t,
        0.32 - 0.14 * t,
        0.28 - 0.18 * t,
      );
    });
    this.rotors.forEach(({ mesh, side }) => {
      const speed =
        [1, 2, 3, 4].reduce(
          (sum, n) => sum + s.equipment[`pumpSpeed${side}${n}`],
          0,
        ) / 3;
      mesh.rotation.z += speed * dt * 3;
    });
    for (const route of this.routes) {
      const flow = route.flow(s);
      const length = route.distances.at(-1);
      route.phase =
        (route.phase + dt * Math.min(3, Math.abs(flow)) * 1.4) % length;
      route.markers.forEach((marker, i) => {
        marker.setEnabled(Math.abs(flow) > 0.001);
        const d = (route.phase + (i * length) / route.markers.length) % length;
        let segment = 1;
        while (
          segment < route.distances.length - 1 &&
          route.distances[segment] < d
        )
          segment++;
        const fraction =
          (d - route.distances[segment - 1]) /
          (route.distances[segment] - route.distances[segment - 1]);
        marker.position.copyFrom(
          B.Vector3.Lerp(
            route.path[segment - 1],
            route.path[segment],
            fraction,
          ),
        );
      });
    }
    if (!force && s.elapsed - (this.lastDraw || 0) < 0.2) return;
    this.lastDraw = s.elapsed;
    for (const entry of this.labels) {
      const lines = entry.content(s);
      const text = lines.join('\n');
      if (text === entry.last && !force) continue;
      entry.last = text;
      const context = entry.texture.getContext();
      const { width, height } = entry.texture.getSize();
      context.fillStyle = '#142b36';
      context.fillRect(0, 0, width, height);
      context.fillStyle = entry.accent;
      context.fillRect(0, 0, width, 6);
      const size = Math.min(
        62,
        (height - 18) / (lines.length * 1.3),
        1550 / Math.max(...lines.map((v) => v.length), 1),
      );
      context.font = `500 ${size}px sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      lines.forEach((line, i) => {
        context.fillStyle = i ? '#dce9ea' : entry.accent;
        context.fillText(
          line,
          width / 2,
          ((i + 0.5) * height) / lines.length,
          width - 28,
        );
      });
      entry.texture.update();
    }
  }
}
