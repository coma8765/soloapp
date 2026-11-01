import {
  RBMK_CONTROLS,
  RBMK_INSTRUMENT_PANELS,
  RBMK_PANEL_PARTS,
  RBMK_PHYSICAL_CONTROL_GROUPS,
} from './rbmk-data.js';
import { EQUIPMENT_BANKS, EQUIPMENT_CONTROLS } from './rbmk-equipment.js';

const B = window.BABYLON;

const PHYSICAL_STEPS = Object.freeze({
  targetPower: 5,
  manualRodInsertion: 5,
  shortenedRodInsertion: 5,
  automaticRodInsertion: 5,
  coolantFlowLeft: 5,
  coolantFlowRight: 5,
  pumpsLeft: 1,
  pumpsRight: 1,
  feedwaterLeft: 5,
  feedwaterRight: 5,
  turbineLoad1: 50,
  turbineLoad2: 50,
  steamDump: 5,
});

const CONTROL_SHORT_LABELS = Object.freeze({
  targetPower: 'ЗАДАНИЕ N',
  manualRodInsertion: 'РР · ВВОД',
  shortenedRodInsertion: 'УСП · ВВОД',
  automaticRodInsertion: 'АР · ВВОД',
  automaticRegulator: 'АР МОЩНОСТИ',
  coolantFlowLeft: 'G КМПЦ-Л',
  coolantFlowRight: 'G КМПЦ-П',
  pumpsLeft: 'ГЦН-Л',
  pumpsRight: 'ГЦН-П',
  feedwaterLeft: 'ПИТ. ВОДА Л',
  feedwaterRight: 'ПИТ. ВОДА П',
  turbineLoad1: 'ТГ-1 · N',
  turbineLoad2: 'ТГ-2 · N',
  generatorBreaker1: 'ВЫКЛ. ТГ-1',
  generatorBreaker2: 'ВЫКЛ. ТГ-2',
  steamDump: 'ПАРОСБРОС',
  eccsAvailable: 'САОР ГОТОВА',
  emergencyInjection: 'ВПРЫСК САОР',
  scenario: 'СЦЕНАРИЙ',
});

const ACTION_LABELS = Object.freeze({
  scram: 'АЗ-5',
  clear: 'СНЯТЬ АЗ',
  reset: 'ИСХОДНЫЙ',
  acknowledge: 'КВИТИР.',
  'lamp-test': 'ЛАМПЫ',
});

const PANEL_SYSTEMS = Object.freeze([
  'control-rods',
  'neutron-measurement',
  'automatic-regulator',
  'reactor-protection',
  'protection-interlocks',
  'core-distribution',
  'computer-and-recording',
  'coolant-loops',
  'drum-separators',
  'feedwater-and-condensate',
  'steam-and-relief',
  'eccs',
  'accident-localization',
  'cooldown-and-blowdown',
  'rod-cooling-and-gas',
  'turbine-generators',
  'condensers-and-service-water',
  'electrical-and-own-use',
  'radiation-monitoring',
]);

const COLORS = Object.freeze({
  cabinet: '#737b7d',
  cabinetDark: '#596164',
  trim: '#9aa1a0',
  bezel: '#252b2c',
  schematic: '#4c3830',
  cream: '#d8cfad',
  yellow: '#caa83c',
  green: '#477965',
  cyan: '#4b7778',
});

function partById(id) {
  return RBMK_PANEL_PARTS.find((part) => part.id === id);
}

export class RbmkPhysicalConsole {
  constructor(scene, root, handlers) {
    this.scene = scene;
    this.root = root;
    this.handlers = handlers;
    this.screens = [];
    this.readouts = [];
    this.buttons = [];
    this.hintMeshes = [];
    this.signalPanels = [];
    this.mimicPanels = [];
    this.channelIndicators = [];
    this.coreCells = [];
    this.recorders = [];
    this.auxiliaryPanels = [];
    this.history = [];
    this.lastDraw = 0;
    this.lastActivation = 0;
    this.onActivation = null;
    this.hintsEnabled = false;
    this.hoveredButton = null;
    this.build();
  }

  material(name, color, emissive = false, alpha = 1) {
    const material = new B.StandardMaterial(name, this.scene);
    material.diffuseColor = B.Color3.FromHexString(color);
    material.specularColor.set(0.16, 0.16, 0.16);
    material.alpha = alpha;
    if (emissive) {
      material.emissiveColor = material.diffuseColor.scale(0.55);
      material.disableLighting = true;
    }
    return material;
  }

  box(name, size, position, material, parent = this.root) {
    const mesh = B.MeshBuilder.CreateBox(
      name,
      { width: size[0], height: size[1], depth: size[2] },
      this.scene,
    );
    mesh.parent = parent;
    mesh.position.copyFromFloats(...position);
    mesh.material = material;
    mesh.isPickable = false;
    return mesh;
  }

  texturePlane(
    name,
    width,
    height,
    textureSize,
    position,
    parent = this.root,
    rotation = null,
  ) {
    const texture = new B.DynamicTexture(
      `${name} texture`,
      textureSize,
      this.scene,
      true,
    );
    texture.hasAlpha = false;
    const material = this.material(`${name} material`, '#ffffff', true);
    material.diffuseTexture = texture;
    material.emissiveTexture = texture;
    material.backFaceCulling = false;
    const plane = B.MeshBuilder.CreatePlane(
      name,
      { width, height },
      this.scene,
    );
    plane.parent = parent;
    plane.position.copyFromFloats(...position);
    if (rotation) plane.rotation.copyFromFloats(...rotation);
    plane.material = material;
    plane.isPickable = false;
    return { plane, texture };
  }

  build() {
    this.steel = this.material('RBMK console grey enamel', COLORS.cabinet);
    this.darkSteel = this.material(
      'RBMK console dark enamel',
      COLORS.cabinetDark,
    );
    this.trim = this.material('RBMK console aluminium trim', COLORS.trim);
    this.bezel = this.material('RBMK console black bezels', COLORS.bezel);
    this.cream = this.material('RBMK console ivory keys', COLORS.cream);
    this.yellow = this.material('RBMK console yellow keys', COLORS.yellow);
    this.green = this.material('RBMK console green keys', COLORS.green);
    this.red = this.material('RBMK console red signal keys', '#a9473c');
    this.buildWallBank();
    this.buildDeskBank();
    this.buildClock();
  }

  buildClock() {
    this.clock = this.texturePlane(
      'RBMK exercise clock',
      2.2,
      0.34,
      { width: 880, height: 136 },
      [0, 5.65, -10.3],
    );
    this.clock.plane.metadata = { rbmkPart: partById('workstations') };
    this.hintMeshes.push(this.clock.plane);
  }

  arcNode(name, index, count, radius, step, y = 0) {
    const angle = (index - (count - 1) / 2) * step;
    const node = new B.TransformNode(name, this.scene);
    node.parent = this.root;
    node.position.set(Math.sin(angle) * radius, y, -Math.cos(angle) * radius);
    node.rotation.y = -angle;
    return node;
  }

  buildWallBank() {
    for (let index = 0; index < 9; index++) {
      const bay = this.arcNode(
        `RBMK wall bay ${index + 1}`,
        index,
        9,
        10.55,
        0.18,
      );
      this.box(
        `RBMK wall cabinet ${index + 1}`,
        [2.2, 5.25, 0.34],
        [0, 3.02, 0],
        this.steel,
        bay,
      );
      this.box(
        `RBMK wall header ${index + 1}`,
        [2.1, 0.24, 0.09],
        [0, 5.55, 0.22],
        this.darkSteel,
        bay,
      );
      this.makeTextPlate(
        `RBMK bay code ${index + 1}`,
        `2H20Z2${25 + index}`,
        1.7,
        0.19,
        [0, 5.55, 0.275],
        bay,
        '#5b6263',
        '#d0ad43',
        30,
      );
      this.buildAnnunciators(bay, index);
      this.buildSchematic(bay, index);
      if (index < RBMK_INSTRUMENT_PANELS.length)
        this.buildLiveScreen(bay, RBMK_INSTRUMENT_PANELS[index]);
      else this.buildRecorderCluster(bay);
    }
  }

  buildAnnunciators(parent, seed) {
    const panel = this.texturePlane(
      `RBMK live annunciator field ${seed}`,
      1.86,
      0.53,
      { width: 744, height: 212 },
      [0, 5.08, 0.29],
      parent,
    );
    panel.seed = seed;
    panel.plane.metadata = { rbmkPart: partById('annunciators') };
    this.signalPanels.push(panel);
    this.hintMeshes.push(panel.plane);
  }

  buildChannelMatrix(parent, seed) {
    const board = this.box(
      `RBMK channel matrix board ${seed}`,
      [2.0, 1.34, 0.12],
      [0, 4.18, 0.22],
      this.darkSteel,
      parent,
    );
    board.metadata = { rbmkPart: partById('core-map') };
    this.hintMeshes.push(board);
    this.makeTextPlate(
      'RBMK channel matrix title',
      'КАНАЛЬНЫЙ КОНТРОЛЬ',
      1.72,
      0.12,
      [0, 4.78, 0.32],
      parent,
      '#4f5759',
      '#eee6c9',
      24,
    );
    const colors = [this.cream, this.cream, this.yellow, this.green, this.red];
    for (let row = 0; row < 8; row++) {
      for (let column = 0; column < 12; column++) {
        const indicator = B.MeshBuilder.CreateCylinder(
          `RBMK channel indicator ${row}-${column}`,
          { diameter: 0.105, height: 0.055, tessellation: 16 },
          this.scene,
        );
        indicator.parent = parent;
        indicator.position.set(-0.82 + column * 0.15, 4.67 - row * 0.14, 0.31);
        indicator.rotation.x = Math.PI / 2;
        indicator.material = colors[(row * 5 + column + seed) % colors.length];
        indicator.isPickable = false;
        this.channelIndicators.push({ mesh: indicator, row, column });
      }
    }
  }

  buildCoreMapBoard(parent, seed) {
    const board = this.box(
      `RBMK core map board ${seed}`,
      [2.0, 1.34, 0.12],
      [0, 4.18, 0.22],
      this.darkSteel,
      parent,
    );
    board.metadata = { rbmkPart: partById('core-map') };
    this.hintMeshes.push(board);
    this.makeTextPlate(
      'RBMK core map title',
      'КАРТОГРАММА ЭНЕРГОВЫДЕЛЕНИЯ',
      1.72,
      0.12,
      [0, 4.78, 0.32],
      parent,
      '#4f5759',
      '#eee6c9',
      20,
    );
    for (let row = -4; row <= 4; row++) {
      for (let column = -6; column <= 6; column++) {
        if ((column / 6) ** 2 + (row / 4.4) ** 2 > 1) continue;
        const edge = Math.abs(column) > 4 || Math.abs(row) > 2;
        const cell = this.box(
          `RBMK core cartogram cell ${row}-${column}`,
          [0.105, 0.09, 0.055],
          [column * 0.13, 4.18 + row * 0.12, 0.31],
          edge
            ? this.cream
            : (row + column + seed) % 9 === 0
              ? this.green
              : this.yellow,
          parent,
        );
        this.coreCells.push({ mesh: cell, row, column, edge });
      }
    }
  }

  buildSchematic(parent, seed) {
    if (seed === 0) {
      this.buildChannelMatrix(parent, seed);
      return;
    }
    if (seed === 1) {
      this.buildCoreMapBoard(parent, seed);
      return;
    }
    this.box(
      `RBMK schematic bezel ${seed}`,
      [2.0, 1.34, 0.12],
      [0, 4.18, 0.22],
      this.bezel,
      parent,
    );
    for (let row = 0; row < 2; row++) {
      for (let column = 0; column < 2; column++) {
        const board = this.texturePlane(
          `RBMK mnemonic diagram ${seed}-${row}-${column}`,
          0.89,
          0.55,
          { width: 360, height: 220 },
          [-0.47 + column * 0.94, 4.48 - row * 0.6, 0.29],
          parent,
        );
        board.seed = seed;
        board.row = row;
        board.column = column;
        this.mimicPanels.push(board);
        board.plane.metadata = {
          rbmkPart: partById(seed % 2 ? 'instrumentation' : 'annunciators'),
        };
        this.hintMeshes.push(board.plane);
      }
    }
  }

  buildLiveScreen(parent, panel) {
    this.box(
      `RBMK instrument rack ${panel.id}`,
      [1.76, 1.18, 0.16],
      [0, 2.35, 0.24],
      this.trim,
      parent,
    );
    const screen = this.texturePlane(
      `RBMK analog instrument panel ${panel.id}`,
      1.62,
      1.02,
      { width: 640, height: 430 },
      [0, 2.35, 0.35],
      parent,
    );
    screen.panel = panel;
    screen.plane.metadata = { rbmkPart: partById(panel.part) };
    this.screens.push(screen);
    this.hintMeshes.push(screen.plane);
  }

  buildRecorderCluster(parent) {
    for (let row = 0; row < 2; row++) {
      for (let column = 0; column < 2; column++) {
        const x = -0.43 + column * 0.86;
        const y = 2.57 - row * 0.69;
        this.box(
          `RBMK recorder ${row}-${column}`,
          [0.76, 0.58, 0.17],
          [x, y, 0.25],
          this.bezel,
          parent,
        );
        const chart = this.texturePlane(
          `RBMK recorder chart ${row}-${column}`,
          0.62,
          0.43,
          { width: 300, height: 210 },
          [x, y, 0.36],
          parent,
        );
        chart.key = ['power', 'pressure', 'drumLevelLeft', 'flowLeft'][
          row * 2 + column
        ];
        this.recorders.push(chart);
      }
    }
  }

  buildDeskBank() {
    RBMK_PHYSICAL_CONTROL_GROUPS.forEach((group, index) => {
      const desk = this.arcNode(
        `RBMK desk section ${group.id}`,
        index + 2,
        8,
        7.6,
        0.4,
      );
      this.box(
        `RBMK desk cabinet ${group.id}`,
        [3.05, 1.02, 1.78],
        [0, 0.51, 0],
        this.darkSteel,
        desk,
      );
      const deck = new B.TransformNode(
        `RBMK sloped deck ${group.id}`,
        this.scene,
      );
      deck.parent = desk;
      deck.position.set(0, 1.08, 0);
      deck.rotation.x = 0.24;
      this.box(
        `RBMK sloped console plate ${group.id}`,
        [3.02, 0.16, 2.05],
        [0, 0, 0],
        this.steel,
        deck,
      );
      this.makeTextPlate(
        `RBMK desk title ${group.id}`,
        group.title,
        2.72,
        0.18,
        [0, 0.115, -0.86],
        deck,
        '#5b6263',
        '#eee6c9',
        23,
        [-Math.PI / 2, 0, 0],
      );
      this.buildControlGroup(deck, group);
    });
    this.buildSideDesk(0, 'channels');
    this.buildSideDesk(1, 'thermal');
    this.buildSideDesk(6, 'turbines');
    this.buildSideDesk(7, 'alarms');
  }

  buildSideDesk(index, kind) {
    const desk = this.arcNode(
      `RBMK auxiliary desk ${kind}`,
      index,
      8,
      7.6,
      0.4,
    );
    this.box(
      `RBMK auxiliary cabinet ${kind}`,
      [3.05, 1.02, 1.78],
      [0, 0.51, 0],
      this.darkSteel,
      desk,
    );
    const deck = new B.TransformNode(
      `RBMK auxiliary sloped deck ${kind}`,
      this.scene,
    );
    deck.parent = desk;
    deck.position.set(0, 1.08, 0);
    deck.rotation.x = 0.24;
    this.box(
      `RBMK auxiliary console plate ${kind}`,
      [3.02, 0.16, 2.05],
      [0, 0, 0],
      this.steel,
      deck,
    );
    this.makeTextPlate(
      `RBMK auxiliary desk title ${kind}`,
      {
        channels: 'КОНТРОЛЬ КАНАЛОВ',
        thermal: 'ТЕПЛОВЫЕ ПАРАМЕТРЫ',
        turbines: 'ТУРБИНЫ И ЭЛЕКТРИКА',
        alarms: 'СИГНАЛИЗАЦИЯ И СВЯЗЬ',
      }[kind],
      2.72,
      0.18,
      [0, 0.115, -0.86],
      deck,
      '#5b6263',
      '#eee6c9',
      23,
      [-Math.PI / 2, 0, 0],
    );
    this.box(
      `RBMK auxiliary status bezel ${kind}`,
      [2.74, 0.62, 0.1],
      [0, 0.43, -0.83],
      this.bezel,
      deck,
    );
    const panel = this.texturePlane(
      `RBMK auxiliary live field ${kind}`,
      2.62,
      0.54,
      { width: 1048, height: 600 },
      [0, 0.43, -0.765],
      deck,
    );
    panel.kind = kind;
    panel.plane.metadata = {
      rbmkPart: partById(
        kind === 'channels'
          ? 'core-map'
          : kind === 'alarms'
            ? 'annunciators'
            : kind === 'thermal'
              ? 'thermal-state'
              : 'turbines',
      ),
    };
    this.auxiliaryPanels.push(panel);
    this.hintMeshes.push(panel.plane);
  }

  buildEquipmentBank(parent, bank, startIndex = 0) {
    const controls = bank.controls;
    const part = {
      id: `equipment-${bank.kind}`,
      title: bank.title,
      description:
        'Отдельные команды оборудования. ПУСК/ОТКЛ управляют насосами; ОТКР/ЗАКР — арматурой. На приборной надстройке показан фактический отклик. Это учебная адресация; точные адреса конкретного блока не установлены.',
      source: 'МИФИ-2021, главы 1–5, 8–13; docs/RBMK_PHYSICS.md.',
      controls: controls.map((schema) => schema.id),
      actions: bank.actions || [],
    };
    controls.forEach((schema, index) => {
      const column = (index + startIndex) % 4;
      const row = Math.floor((index + startIndex) / 4);
      const x = -1.02 + column * 0.68;
      const z = -0.66 + row * 0.205;
      this.box(
        `RBMK equipment cell ${schema.id}`,
        [0.64, 0.025, 0.192],
        [x, 0.105, z],
        this.trim,
        parent,
      );
      const readout = this.texturePlane(
        `RBMK equipment command ${schema.id}`,
        0.61,
        0.085,
        { width: 400, height: 72 },
        [x, 0.125, z - 0.06],
        parent,
        [-Math.PI / 2, 0, 0],
      );
      readout.name = schema.id;
      readout.plane.metadata = { rbmkPart: part };
      this.readouts.push(readout);
      this.hintMeshes.push(readout.plane);
      const valve = /Valve|Isolation|Admission/.test(schema.id);
      for (const [value, offset, color, legend] of [
        [true, -0.15, '#d5c9a5', valve ? 'ОТКР' : 'ПУСК'],
        [false, 0.15, '#9e5244', valve ? 'ЗАКР' : 'ОТКЛ'],
      ])
        this.createButton(
          parent,
          `RBMK equipment ${schema.id} ${value}`,
          [x + offset, 0.168, z + 0.047],
          [0.25, 0.08, 0.125],
          color,
          {
            rbmkControl: { name: schema.id, mode: 'set', value },
            rbmkPart: part,
            legend,
          },
        );
    });
    (bank.actions || []).forEach((action, index) => {
      const cell = controls.length + startIndex + index;
      this.createButton(
        parent,
        `RBMK equipment action ${action}`,
        [
          -1.02 + (cell % 4) * 0.68,
          0.145,
          -0.66 + Math.floor(cell / 4) * 0.205,
        ],
        [0.54, 0.06, 0.16],
        '#bfab6e',
        { rbmkAction: action, rbmkPart: part, legend: ACTION_LABELS[action] },
      );
    });
  }

  buildControlGroup(parent, group) {
    const items = [
      ...group.controls.map((name) => ({ type: 'control', name })),
      ...(group.actions || []).map((name) => ({ type: 'action', name })),
    ];
    items.forEach((item, index) => {
      const column = index % 4;
      const row = Math.floor(index / 4);
      const x = -1.02 + column * 0.68;
      const z = -0.66 + row * 0.205;
      const part =
        RBMK_PANEL_PARTS.find((candidate) =>
          candidate.controls?.includes(item.name),
        ) || partById(group.part);
      if (item.type === 'action') {
        this.createButton(
          parent,
          `RBMK physical action ${item.name}`,
          [x, 0.145, z],
          [0.52, 0.06, 0.17],
          item.name === 'scram' ? '#b9362f' : '#b7a36d',
          {
            rbmkAction: item.name,
            rbmkPart: part,
            legend: ACTION_LABELS[item.name],
          },
        );
        return;
      }
      const schema = RBMK_CONTROLS[item.name];
      this.box(
        `RBMK control cell ${item.name}`,
        [0.64, 0.025, 0.192],
        [x, 0.105, z],
        this.trim,
        parent,
      );
      const readout = this.texturePlane(
        `RBMK control readout ${item.name}`,
        0.61,
        0.085,
        { width: 400, height: 72 },
        [x, 0.125, z - 0.06],
        parent,
        [-Math.PI / 2, 0, 0],
      );
      readout.name = item.name;
      readout.plane.metadata = { rbmkPart: part };
      this.readouts.push(readout);
      this.hintMeshes.push(readout.plane);
      if (schema.type === 'checkbox') {
        this.createButton(
          parent,
          `RBMK toggle ${item.name}`,
          [x, 0.168, z + 0.047],
          [0.4, 0.08, 0.125],
          '#608b7e',
          { rbmkControl: { name: item.name, mode: 'toggle' }, rbmkPart: part },
        );
      } else {
        const delta =
          schema.type === 'select'
            ? 1
            : PHYSICAL_STEPS[item.name] || schema.step;
        for (const direction of [-1, 1])
          this.createButton(
            parent,
            `RBMK adjust ${item.name} ${direction}`,
            [x + direction * 0.15, 0.168, z + 0.047],
            [0.25, 0.08, 0.125],
            direction > 0 ? '#638b82' : '#7a7770',
            {
              rbmkControl: { name: item.name, delta: direction * delta },
              rbmkPart: part,
            },
          );
      }
    });
    const kind = {
      'reactor-controls': 'channels',
      'circulation-controls': 'thermal',
      'turbine-controls': 'turbines',
      'safety-controls': 'alarms',
    }[group.id];
    const bank = EQUIPMENT_BANKS.find((candidate) => candidate.kind === kind);
    this.buildEquipmentBank(parent, bank, items.length);
    this.box(
      `RBMK ${group.id} instrument riser`,
      [2.74, 0.62, 0.1],
      [0, 0.43, -0.9],
      this.steel,
      parent,
    );
    const field = this.texturePlane(
      `RBMK ${group.id} live equipment scales`,
      2.62,
      0.54,
      { width: 1048, height: 600 },
      [0, 0.43, -0.835],
      parent,
    );
    field.kind = kind;
    field.plane.metadata = { rbmkPart: partById(group.part) };
    this.auxiliaryPanels.push(field);
    this.hintMeshes.push(field.plane);
  }

  buildControlCell(parent, name, x, z, fallbackPart) {
    const schema = RBMK_CONTROLS[name];
    const part =
      RBMK_PANEL_PARTS.find((candidate) =>
        candidate.controls?.includes(name),
      ) || partById(fallbackPart);
    const readout = this.texturePlane(
      `RBMK control readout ${name}`,
      1.12,
      0.18,
      { width: 400, height: 72 },
      [x, 0.105, z - 0.12],
      parent,
      [-Math.PI / 2, 0, 0],
    );
    readout.name = name;
    readout.plane.metadata = { rbmkPart: part };
    this.readouts.push(readout);
    this.hintMeshes.push(readout.plane);
    if (schema.type === 'checkbox') {
      this.createButton(
        parent,
        `RBMK toggle ${name}`,
        [x, 0.17, z + 0.11],
        [0.42, 0.1, 0.18],
        COLORS.cyan,
        { rbmkControl: { name, mode: 'toggle' }, rbmkPart: part },
      );
      return;
    }
    const delta =
      schema.type === 'select' ? 1 : PHYSICAL_STEPS[name] || schema.step;
    this.createButton(
      parent,
      `RBMK decrease ${name}`,
      [x - 0.2, 0.17, z + 0.11],
      [0.28, 0.1, 0.18],
      '#7a7770',
      { rbmkControl: { name, delta: -delta }, rbmkPart: part },
    );
    this.createButton(
      parent,
      `RBMK increase ${name}`,
      [x + 0.2, 0.17, z + 0.11],
      [0.28, 0.1, 0.18],
      '#638b82',
      { rbmkControl: { name, delta }, rbmkPart: part },
    );
  }

  buildActionCell(parent, action, x, z, fallbackPart) {
    const part =
      action === 'scram' || action === 'clear'
        ? partById('az5')
        : partById(fallbackPart);
    const color =
      action === 'scram'
        ? '#b9362f'
        : action === 'clear'
          ? '#c19d3e'
          : '#4d7a64';
    this.makeTextPlate(
      `RBMK action label ${action}`,
      ACTION_LABELS[action],
      1.02,
      0.17,
      [x, 0.106, z - 0.12],
      parent,
      '#676d6d',
      '#f1e8c9',
      29,
      [-Math.PI / 2, 0, 0],
    );
    this.createButton(
      parent,
      `RBMK physical action ${action}`,
      [x, 0.19, z + 0.11],
      action === 'scram' ? [0.52, 0.14, 0.24] : [0.48, 0.11, 0.2],
      color,
      { rbmkAction: action, rbmkPart: part },
    );
  }

  makeTextPlate(
    name,
    label,
    width,
    height,
    position,
    parent,
    background,
    foreground,
    font,
    rotation = null,
  ) {
    const plate = this.texturePlane(
      name,
      width,
      height,
      { width: 768, height: 96 },
      position,
      parent,
      rotation,
    );
    const context = plate.texture.getContext();
    context.fillStyle = background;
    context.fillRect(0, 0, 768, 96);
    context.fillStyle = foreground;
    context.font = `bold ${font}px monospace`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(label, 384, 49, 744);
    plate.texture.update();
    return plate;
  }

  createButton(parent, name, position, size, color, metadata) {
    const material = this.material(`${name} hit material`, color, true, 0.018);
    const button = this.box(name, size, position, material, parent);
    button.isPickable = true;
    const capMaterial = this.material(`${name} cap material`, color, true);
    const cap = this.box(
      `${name} visible cap`,
      [size[0] * 0.56, Math.max(0.055, size[1] * 0.7), size[2] * 0.62],
      [0, 0, 0],
      capMaterial,
      button,
    );
    const capLabel =
      metadata.legend ||
      (metadata.rbmkAction
        ? ACTION_LABELS[metadata.rbmkAction]
        : metadata.rbmkControl?.mode === 'toggle'
          ? 'ВКЛ'
          : metadata.rbmkControl?.delta < 0
            ? '−'
            : '+');
    const legend = this.texturePlane(
      `${name} cap legend`,
      size[0] * 0.48,
      size[2] * 0.5,
      { width: 256, height: 128 },
      [0, size[1] * 0.51, 0],
      button,
      [-Math.PI / 2, 0, 0],
    );
    const legendContext = legend.texture.getContext();
    legendContext.fillStyle = color;
    legendContext.fillRect(0, 0, 256, 128);
    legendContext.fillStyle = '#f3ead0';
    legendContext.font = `bold ${metadata.rbmkAction || metadata.legend ? 50 : 88}px monospace`;
    legendContext.textAlign = 'center';
    legendContext.textBaseline = 'middle';
    legendContext.fillText(capLabel, 128, 67, 240);
    legend.texture.update();
    button.metadata = {
      ...metadata,
      restY: position[1],
      pressedUntil: 0,
      baseColor: color,
      cap,
    };
    this.buttons.push(button);
    return button;
  }

  setHints(enabled) {
    this.hintsEnabled = !!enabled;
    for (const mesh of this.hintMeshes) mesh.isPickable = !!enabled;
    for (const button of this.buttons) {
      const base = B.Color3.FromHexString(button.metadata.baseColor);
      button.material.alpha = enabled ? 0.18 : 0.018;
      button.metadata.cap.material.emissiveColor = base.scale(
        enabled ? 0.95 : 0.55,
      );
    }
  }

  setHovered(mesh) {
    const next =
      mesh?.metadata?.rbmkControl || mesh?.metadata?.rbmkAction ? mesh : null;
    if (next === this.hoveredButton) return;
    if (this.hoveredButton) {
      const previous = this.hoveredButton;
      previous.scaling.setAll(1);
      const base = B.Color3.FromHexString(previous.metadata.baseColor);
      previous.metadata.cap.material.emissiveColor = base.scale(
        this.hintsEnabled ? 0.95 : 0.55,
      );
    }
    this.hoveredButton = next;
    if (next) {
      next.scaling.setAll(1.08);
      next.metadata.cap.material.emissiveColor.set(0.95, 0.92, 0.7);
    }
  }

  activate(mesh) {
    if (!mesh?.metadata) return false;
    const now = performance.now();
    if (now - this.lastActivation < 90) return false;
    const state = this.handlers.state();
    const control = mesh.metadata.rbmkControl;
    if (control) {
      const schema = RBMK_CONTROLS[control.name];
      const current = state.controls[control.name];
      let value;
      if (control.mode === 'set') value = control.value;
      else if (control.mode === 'toggle') value = !current;
      else if (schema.type === 'select') {
        const options = Object.keys(schema.options);
        const index = options.indexOf(current);
        value =
          options[(index + control.delta + options.length) % options.length];
      } else value = current + control.delta;
      if (!this.handlers.control(control.name, value)) return false;
    } else if (mesh.metadata.rbmkAction) {
      if (!this.handlers.action(mesh.metadata.rbmkAction)) return false;
    } else return false;
    this.lastActivation = now;
    mesh.metadata.pressedUntil = now + 150;
    mesh.position.y = mesh.metadata.restY - 0.055;
    this.sync(true);
    this.onActivation?.({
      mesh,
      before: state,
      after: this.handlers.state(),
      control: mesh.metadata.rbmkControl || null,
      action: mesh.metadata.rbmkAction || null,
    });
    return true;
  }

  updateButtons(now, state) {
    for (const button of this.buttons) {
      if (button.metadata.pressedUntil && now >= button.metadata.pressedUntil) {
        button.metadata.pressedUntil = 0;
        button.position.y = button.metadata.restY;
      }
      const control = button.metadata.rbmkControl;
      if (!control || !['toggle', 'set'].includes(control.mode)) continue;
      const active =
        control.mode === 'set'
          ? state.controls[control.name] === control.value
          : !!state.controls[control.name];
      button.metadata.cap.material.diffuseColor = B.Color3.FromHexString(
        active ? '#43a66c' : '#654a43',
      );
      button.metadata.cap.material.emissiveColor =
        button.metadata.cap.material.diffuseColor.scale(
          this.hintsEnabled ? 0.95 : 0.55,
        );
    }
  }

  sync(force = false) {
    const now = performance.now();
    const state = this.handlers.state();
    this.updateButtons(now, state);
    if (!force && now - this.lastDraw < 150) return;
    this.lastDraw = now;
    this.history.push({
      power: state.power,
      pressure: state.pressure,
      drumLevelLeft: state.drumLevelLeft,
      flowLeft: state.flowLeft,
    });
    if (this.history.length > 90) this.history.shift();
    for (const screen of this.screens) this.drawInstrument(screen, state);
    for (const readout of this.readouts) this.drawReadout(readout, state);
    for (const panel of this.signalPanels) this.drawSignalPanel(panel, state);
    for (const panel of this.mimicPanels) this.drawMimicPanel(panel, state);
    for (const recorder of this.recorders) this.drawRecorder(recorder);
    for (const panel of this.auxiliaryPanels)
      this.drawEquipmentPanel(panel, state);
    this.updateChannelMaps(state);
    this.drawClock(state);
  }

  drawClock(state) {
    const elapsed = Math.max(0, Math.round(state.elapsed || 0));
    const hours = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const seconds = String(elapsed % 60).padStart(2, '0');
    const context = this.clock.texture.getContext();
    context.fillStyle = '#353a3a';
    context.fillRect(0, 0, 880, 136);
    context.strokeStyle = '#a7aaa4';
    context.lineWidth = 8;
    context.strokeRect(5, 5, 870, 126);
    context.fillStyle = '#d3b545';
    context.font = 'bold 72px monospace';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(`${hours}:${minutes}:${seconds}`, 440, 72);
    this.clock.texture.update();
    this.clock.renderedAt = this.lastDraw;
  }

  signalEntries(state) {
    const controls = state.controls;
    return [
      ['АЗ-5', state.scrammed, 'red'],
      ['N > 105', state.power > 105, 'red'],
      ['N < 5', state.power < 5, 'yellow'],
      ['P > 7.8', state.pressure > 7.8, 'red'],
      ['P < 6.4', state.pressure < 6.4, 'yellow'],
      ['G Л < 75', state.flowLeft < 75, 'yellow'],
      ['G П < 75', state.flowRight < 75, 'yellow'],
      ['БС-Л НИЗ', state.drumLevelLeft < -450, 'yellow'],
      ['БС-П НИЗ', state.drumLevelRight < -450, 'yellow'],
      ['САОР ГОТ', controls.eccsAvailable, 'green'],
      ['ВПРЫСК', controls.emergencyInjection, 'green'],
      ['ГЦН-Л1', controls.pumpsLeft >= 1, 'green'],
      ['ГЦН-Л2', controls.pumpsLeft >= 2, 'green'],
      ['ГЦН-Л3', controls.pumpsLeft >= 3, 'green'],
      ['ГЦН-Л4', controls.pumpsLeft >= 4, 'green'],
      ['ГЦН-П1', controls.pumpsRight >= 1, 'green'],
      ['ГЦН-П2', controls.pumpsRight >= 2, 'green'],
      ['ГЦН-П3', controls.pumpsRight >= 3, 'green'],
      ['ГЦН-П4', controls.pumpsRight >= 4, 'green'],
      ['ТГ-1 СЕТЬ', controls.generatorBreaker1, 'green'],
      ['ТГ-2 СЕТЬ', controls.generatorBreaker2, 'green'],
      ['АР ВКЛ', controls.automaticRegulator, 'green'],
      ['ОЗР < 15', state.orm < 15, 'red'],
      ['T ТОПЛ >', state.fuelTemperature > 900, 'red'],
      ['T ГРАФ >', state.graphiteTemperature > 760, 'red'],
      ['ЗАПАС <92', state.coolantInventory < 92, 'red'],
      ['f < 49', state.frequency < 49, 'yellow'],
      ['ПАРОСБР.', controls.steamDump > 0, 'yellow'],
      ['ПВ-Л > 0', controls.feedwaterLeft > 0, 'green'],
      ['ПВ-П > 0', controls.feedwaterRight > 0, 'green'],
      ['ГОТОВН. АЗ', !state.scrammed, 'green'],
      ['СИГНАЛЫ', state.alarms.length > 0, 'yellow'],
    ];
  }

  drawSignalPanel(panel, state) {
    const entries = this.signalEntries(state);
    const context = panel.texture.getContext();
    context.fillStyle = '#596164';
    context.fillRect(0, 0, 744, 212);
    for (let index = 0; index < entries.length; index++) {
      const [label, condition, severity] =
        entries[(index + panel.seed * 5) % entries.length];
      const active =
        state.equipment.lampTestUntil > state.elapsed ||
        (condition &&
          (severity === 'green' ||
            state.equipment.acknowledged ||
            Math.floor(state.elapsed * 2) % 2 === 0));
      const column = index % 8;
      const row = Math.floor(index / 8);
      const x = 5 + column * 92;
      const y = 5 + row * 51;
      const color =
        severity === 'red'
          ? '#b74438'
          : severity === 'green'
            ? '#547b62'
            : '#c09c3f';
      context.fillStyle = active ? color : '#bdb69e';
      context.fillRect(x, y, 87, 45);
      context.strokeStyle = '#302f2b';
      context.lineWidth = 3;
      context.strokeRect(x, y, 87, 45);
      context.fillStyle = active ? '#fff2c9' : '#3c3a33';
      context.font = 'bold 11px monospace';
      context.textAlign = 'center';
      context.fillText(label, x + 43.5, y + 27, 82);
    }
    context.textAlign = 'left';
    panel.texture.update();
    panel.renderedAt = this.lastDraw;
  }

  mimicMetrics(state) {
    const controls = state.controls;
    const rodInsertion =
      (controls.manualRodInsertion +
        controls.shortenedRodInsertion +
        controls.automaticRodInsertion) /
      3;
    return [
      ['МОЩНОСТЬ', state.power / 120],
      ['РЕАКТИВНОСТЬ', (state.reactivity + 5) / 10],
      ['СТЕРЖНИ', rodInsertion / 100],
      ['АВТОРЕГУЛЯТОР', controls.automaticRegulator ? 1 : 0],
      ['ЦЕПИ АЗ', state.scrammed ? 0 : 1],
      ['ОЗР', state.orm / 35],
      ['КМПЦ-Л', state.flowLeft / 120],
      ['КМПЦ-П', state.flowRight / 120],
      ['ГЦН-Л', controls.pumpsLeft / 4],
      ['ГЦН-П', controls.pumpsRight / 4],
      ['УРОВЕНЬ БС-Л', (state.drumLevelLeft + 1200) / 1800],
      ['УРОВЕНЬ БС-П', (state.drumLevelRight + 1200) / 1800],
      ['ПИТ.ВОДА-Л', controls.feedwaterLeft / 120],
      ['ПИТ.ВОДА-П', controls.feedwaterRight / 120],
      ['ОСТРЫЙ ПАР', state.steamFlow / 120],
      ['БРУ-К', controls.steamDump / 100],
      ['САОР ГОТОВН.', controls.eccsAvailable ? 1 : 0],
      ['САОР ВПРЫСК', controls.emergencyInjection ? 1 : 0],
      ['ЛОКАЛИЗАЦИЯ', state.coolantInventory / 100],
      ['РАСХОЛАЖИВ.', (state.flowLeft + state.flowRight) / 240],
      ['ОХЛАЖД. СУЗ', state.equipment.suzFlow / 150],
      ['ГАЗОВЫЙ КОНТ.', state.equipment.gasFlow / 200],
      ['ТГ-1', controls.turbineLoad1 / 500],
      ['ТГ-2', controls.turbineLoad2 / 500],
      [
        'КОНДЕНСАТОРЫ',
        (state.equipment.condenserPressure1 +
          state.equipment.condenserPressure2) /
          60,
      ],
      [
        'ТЕХНИЧ. ВОДА',
        (Number(controls.serviceWaterPump1) +
          Number(controls.serviceWaterPump2)) /
          2,
      ],
      [
        'СОБСТВ. НУЖДЫ',
        (Number(controls.generatorBreaker1) +
          Number(controls.generatorBreaker2)) /
          2,
      ],
      ['РАД. КОНТРОЛЬ', Math.min(1, state.coolantInventory / 100)],
      ['T ТОПЛИВА', state.fuelTemperature / 1100],
    ];
  }

  drawMimicPanel(panel, state) {
    const metrics = this.mimicMetrics(state);
    const index = (panel.seed - 2) * 4 + panel.row * 2 + panel.column;
    const [label, raw] = metrics[index % metrics.length];
    const value = Math.max(0, Math.min(1, raw));
    const context = panel.texture.getContext();
    context.fillStyle = COLORS.schematic;
    context.fillRect(0, 0, 360, 220);
    context.fillStyle = '#eee7cf';
    context.font = 'bold 16px monospace';
    context.textAlign = 'center';
    context.fillText(label, 180, 23, 330);
    const activeColor = value < 0.45 || value > 0.92 ? '#d3a33c' : '#d9e0c8';
    context.strokeStyle = activeColor;
    context.lineWidth = 8;
    context.beginPath();
    context.moveTo(20, 85);
    context.lineTo(93, 85);
    context.lineTo(126, 55);
    context.lineTo(233, 55);
    context.lineTo(266, 85);
    context.lineTo(340, 85);
    context.moveTo(180, 55);
    context.lineTo(180, 168);
    context.stroke();
    for (const x of [72, 180, 288]) {
      context.fillStyle = '#2e302d';
      context.fillRect(x - 18, 68, 36, 34);
      context.strokeStyle = activeColor;
      context.lineWidth = 4;
      context.strokeRect(x - 18, 68, 36, 34);
    }
    context.fillStyle = '#d8cfad';
    context.fillRect(30, 181, 300, 17);
    context.fillStyle = value < 0.45 ? '#b74438' : '#557c63';
    context.fillRect(30, 181, 300 * value, 17);
    context.strokeStyle = '#2e302d';
    context.lineWidth = 3;
    context.strokeRect(30, 181, 300, 17);
    context.textAlign = 'left';
    panel.texture.update();
    panel.renderedAt = this.lastDraw;
  }

  recorderNormalized(key, value) {
    if (key === 'power') return value / 120;
    if (key === 'pressure') return value / 9;
    if (key === 'drumLevelLeft') return (value + 1200) / 1800;
    return value / 120;
  }

  drawRecorder(recorder) {
    const labels = {
      power: 'N РЕАКТОРА',
      pressure: 'P КМПЦ',
      drumLevelLeft: 'УРОВЕНЬ БС-Л',
      flowLeft: 'РАСХОД КМПЦ-Л',
    };
    const context = recorder.texture.getContext();
    context.fillStyle = '#d8cfad';
    context.fillRect(0, 0, 300, 210);
    context.strokeStyle = '#8d866f';
    context.lineWidth = 1;
    for (let grid = 0; grid <= 12; grid++) {
      context.beginPath();
      context.moveTo(grid * 25, 0);
      context.lineTo(grid * 25, 210);
      context.moveTo(0, grid * 18);
      context.lineTo(300, grid * 18);
      context.stroke();
    }
    context.fillStyle = '#34342f';
    context.font = 'bold 15px monospace';
    context.fillText(labels[recorder.key], 9, 18);
    context.strokeStyle = '#8d352f';
    context.lineWidth = 3;
    context.beginPath();
    this.history.forEach((sample, index) => {
      const x = (index / Math.max(1, this.history.length - 1)) * 296 + 2;
      const normalized = Math.max(
        0,
        Math.min(
          1,
          this.recorderNormalized(recorder.key, sample[recorder.key]),
        ),
      );
      const y = 202 - normalized * 172;
      if (!index) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
    recorder.texture.update();
    recorder.renderedAt = this.lastDraw;
  }

  drawAuxiliaryPanel(panel, state) {
    const context = panel.texture.getContext();
    context.fillStyle = '#596164';
    context.fillRect(0, 0, 1048, 600);
    if (panel.kind === 'alarms') {
      const entries = this.signalEntries(state);
      entries.forEach(([label, active, severity], index) => {
        const column = index % 8;
        const row = Math.floor(index / 8);
        const x = 9 + column * 130;
        const y = 12 + row * 144;
        const color =
          severity === 'red'
            ? '#b74438'
            : severity === 'green'
              ? '#547b62'
              : '#c09c3f';
        context.fillStyle = active ? color : '#c8c0a5';
        context.fillRect(x, y, 120, 126);
        context.strokeStyle = '#2c2d2b';
        context.lineWidth = 6;
        context.strokeRect(x, y, 120, 126);
        context.fillStyle = active ? '#fff2c9' : '#34342f';
        context.font = 'bold 16px monospace';
        context.textAlign = 'center';
        context.fillText(label, x + 60, y + 71, 108);
      });
    } else if (panel.kind === 'channels') {
      for (let index = 0; index < 80; index++) {
        const column = index % 10;
        const row = Math.floor(index / 10);
        const x = 8 + column * 104;
        const y = 8 + row * 74;
        const radial = Math.hypot(column - 4.5, row - 3.5) / 6;
        const local = Math.max(
          0,
          Math.min(
            1.2,
            (state.power / 100) *
              (1 - radial * 0.28) *
              (0.96 + Math.sin(index * 1.73) * 0.04),
          ),
        );
        context.fillStyle =
          local > 1.05 ? '#b74438' : local > 0.65 ? '#c09c3f' : '#547b62';
        context.fillRect(x, y, 94, 64);
        context.strokeStyle = '#2c2d2b';
        context.lineWidth = 4;
        context.strokeRect(x, y, 94, 64);
        context.fillStyle = '#fff2c9';
        context.font = 'bold 13px monospace';
        context.textAlign = 'center';
        context.fillText(
          `К${String(index + 1).padStart(3, '0')}`,
          x + 47,
          y + 38,
        );
      }
    } else {
      const metrics = this.mimicMetrics(state);
      const offset = panel.kind === 'thermal' ? 0 : 10;
      for (let index = 0; index < 20; index++) {
        const [label, raw] = metrics[(index + offset) % metrics.length];
        const value = Math.max(0, Math.min(1, raw));
        const column = index % 4;
        const row = Math.floor(index / 4);
        const x = 12 + column * 259;
        const y = 12 + row * 116;
        context.fillStyle = '#d8cfad';
        context.fillRect(x, y, 247, 104);
        context.strokeStyle = '#34342f';
        context.lineWidth = 5;
        context.strokeRect(x, y, 247, 104);
        context.fillStyle = '#34342f';
        context.font = 'bold 17px monospace';
        context.textAlign = 'center';
        context.fillText(label, x + 123, y + 31, 230);
        context.fillStyle = '#eee7cf';
        context.fillRect(x + 13, y + 55, 221, 30);
        context.fillStyle =
          value < 0.45 || value > 0.93 ? '#b74438' : '#557c63';
        context.fillRect(x + 13, y + 55, 221 * value, 30);
        context.strokeStyle = '#34342f';
        context.lineWidth = 3;
        context.strokeRect(x + 13, y + 55, 221, 30);
      }
    }
    context.textAlign = 'left';
    panel.texture.update();
    panel.renderedAt = this.lastDraw;
  }

  drawEquipmentPanel(panel, state) {
    const e = state.equipment;
    const readings = {
      channels: [
        ['G СУЗ', e.suzFlow, 150, '%'],
        ['T СУЗ', e.suzTemperature, 100, '°C'],
        ['АВАР. БАК', e.suzTank, 100, '%'],
        ['G ГАЗА', e.gasFlow, 200, '%'],
        ['P ГАЗА', e.gasPressure, 2, 'отн.'],
        ['ВЛАЖНОСТЬ', e.gasHumidity, 1, 'отн.'],
      ],
      thermal: [
        ['G КМПЦ-Л', state.flowLeft, 150, '%'],
        ['G КМПЦ-П', state.flowRight, 150, '%'],
        ['ПЭН-Л', e.feedCapacityLeft * 100, 150, '%'],
        ['ПЭН-П', e.feedCapacityRight * 100, 150, '%'],
        ['БС-Л', state.drumLevelLeft + 1200, 1800, 'мм+1200'],
        ['БС-П', state.drumLevelRight + 1200, 1800, 'мм+1200'],
      ],
      turbines: [
        ['P КОНД.-1', e.condenserPressure1, 30, 'кПа'],
        ['P КОНД.-2', e.condenserPressure2, 30, 'кПа'],
        ['U ГЕН.-1', e.generatorVoltage1, 25, 'кВ'],
        ['U ГЕН.-2', e.generatorVoltage2, 25, 'кВ'],
        ['КЛАПАН-1', e.turbineValve1 * 100, 100, '%'],
        ['КЛАПАН-2', e.turbineValve2 * 100, 100, '%'],
      ],
      alarms: [
        ['САОР ГОТОВА', e.eccsCapacity * 100, 150, '%'],
        ['СПиР ОТВОД', e.cooldownMW, 60, 'МВт'],
        ['ПРОДУВКА', e.blowdownKgS, 20, 'кг/с'],
        ['СИГНАЛОВ', state.alarms.length, 20, 'шт.'],
        ['КВИТИРОВАНО', Number(e.acknowledged), 1, ''],
        ['ЛАМПЫ ТЕСТ', Number(e.lampTestUntil > state.elapsed), 1, ''],
      ],
    }[panel.kind];
    const context = panel.texture.getContext();
    context.fillStyle = '#596164';
    context.fillRect(0, 0, 1048, 600);
    readings.forEach(([label, raw, maximum, unit], index) => {
      const x = 12 + (index % 3) * 346;
      const y = 12 + Math.floor(index / 3) * 292;
      context.fillStyle = '#d8cfad';
      context.fillRect(x, y, 330, 270);
      context.strokeStyle = '#34342f';
      context.lineWidth = 7;
      context.strokeRect(x, y, 330, 270);
      context.fillStyle = '#34342f';
      context.textAlign = 'center';
      context.font = 'bold 28px monospace';
      context.fillText(label, x + 165, y + 48, 310);
      context.font = '22px monospace';
      context.fillText(`0 — ${maximum} ${unit}`, x + 165, y + 243, 308);
      context.strokeStyle = '#5b574b';
      context.lineWidth = 3;
      context.beginPath();
      context.moveTo(x + 24, y + 160);
      context.lineTo(x + 306, y + 160);
      for (let tick = 0; tick <= 10; tick++) {
        const at = x + 24 + tick * 28.2;
        context.moveTo(at, y + 145);
        context.lineTo(at, y + 180);
      }
      context.stroke();
      const needle = x + 24 + 282 * Math.max(0, Math.min(1, raw / maximum));
      context.strokeStyle = '#943a30';
      context.lineWidth = 10;
      context.beginPath();
      context.moveTo(needle, y + 100);
      context.lineTo(needle, y + 198);
      context.stroke();
    });
    panel.texture.update();
    panel.renderedAt = this.lastDraw;
  }

  updateChannelMaps(state) {
    for (const item of this.channelIndicators) {
      const local = Math.max(
        0,
        Math.min(
          1.2,
          (state.power / 100) *
            (0.94 + Math.sin(item.row * 2.1 + item.column * 1.4) * 0.06),
        ),
      );
      item.mesh.material =
        local > 1.05 ? this.red : local > 0.65 ? this.yellow : this.green;
    }
    for (const item of this.coreCells) {
      if (item.edge) {
        item.mesh.material = this.cream;
        continue;
      }
      const radial = Math.hypot(item.column / 6, item.row / 4.4);
      const local = (state.power / 100) * (1 - radial * 0.34);
      item.mesh.material =
        local > 1.02 ? this.red : local > 0.58 ? this.yellow : this.green;
    }
    this.channelMapsRenderedAt = this.lastDraw;
  }

  fidelityMetrics(auditReport = window.rbmkPhysicalAuditReport) {
    const wallBays = this.signalPanels.length;
    const behavior = auditReport?.total
      ? (auditReport.passed / auditReport.total) * 100
      : 0;
    return {
      score: null,
      gate: 90,
      passed: false,
      measurementStatus: 'unmeasured',
      layout: null,
      systemCoverage: null,
      density: null,
      semantics: null,
      behavior: Math.round(behavior),
      counts: {
        wallBays,
        deskSections: 8,
        signalCells: this.signalPanels.length * 32,
        mimicBlocks: this.mimicPanels.length,
        channelCells: this.channelIndicators.length + this.coreCells.length,
        recorders: this.recorders.length,
        analogSections: this.screens.length,
        auxiliaryCells: this.auxiliaryPanels.length * 6,
        physicalTargets: this.buttons.length,
        unlabeledDecorativeElements: null,
        systemsNamed: PANEL_SYSTEMS.length,
      },
    };
  }

  drawReadout(readout, state) {
    const name = readout.name;
    const value = state.controls[name];
    const context = readout.texture.getContext();
    context.fillStyle = '#d9d1b6';
    context.fillRect(0, 0, 400, 72);
    context.strokeStyle = '#453f36';
    context.lineWidth = 5;
    context.strokeRect(3, 3, 394, 66);
    context.fillStyle = '#292b29';
    context.font = 'bold 15px monospace';
    context.textAlign = 'center';
    context.fillText(
      CONTROL_SHORT_LABELS[name] ||
        RBMK_CONTROLS[name].shortLabel ||
        RBMK_CONTROLS[name].label,
      200,
      17,
      382,
    );
    if (EQUIPMENT_CONTROLS[name]) {
      context.fillStyle = value ? '#33654d' : '#8d342a';
      context.font = 'bold 27px monospace';
      context.fillText(
        value ? 'КОМАНДА: ВКЛ / ОТКР' : 'КОМАНДА: ОТКЛ / ЗАКР',
        200,
        52,
        380,
      );
      readout.texture.update();
      readout.renderedValue = value;
      readout.renderedAt = this.lastDraw;
      return;
    }
    const left = 22;
    const right = 378;
    const y = 45;
    context.strokeStyle = '#302f29';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(right, y);
    for (let tick = 0; tick <= 20; tick++) {
      const x = left + ((right - left) * tick) / 20;
      context.moveTo(x, y - (tick % 5 ? 6 : 11));
      context.lineTo(x, y + (tick % 5 ? 5 : 9));
    }
    context.stroke();
    const pointer = left + (right - left) * this.controlNormalized(name, value);
    context.fillStyle = '#8f2f26';
    context.beginPath();
    context.moveTo(pointer, 29);
    context.lineTo(pointer - 7, 63);
    context.lineTo(pointer + 7, 63);
    context.closePath();
    context.fill();
    context.textAlign = 'left';
    readout.texture.update();
    readout.renderedValue = value;
    readout.renderedAt = this.lastDraw;
  }

  readingValue(state, key) {
    if (key.startsWith('rod:')) return state.rods[key.slice(4)];
    if (key.startsWith('control:')) return state.controls[key.slice(8)];
    if (key === 'voidPercent') return state.voidFraction * 100;
    if (key === 'turbineLoads')
      return `${state.controls.turbineLoad1}/${state.controls.turbineLoad2}`;
    return state[key];
  }

  controlNormalized(name, value) {
    const schema = RBMK_CONTROLS[name];
    if (schema.type === 'checkbox') return value ? 1 : 0;
    if (schema.type === 'select') {
      const options = Object.keys(schema.options);
      return (
        Math.max(0, options.indexOf(value)) / Math.max(1, options.length - 1)
      );
    }
    return Math.max(
      0,
      Math.min(1, (value - schema.min) / (schema.max - schema.min)),
    );
  }

  readingNormalized(state, key, raw) {
    if (key.startsWith('rod:')) return Number(raw) / 100;
    if (key.startsWith('control:'))
      return this.controlNormalized(key.slice(8), raw);
    const ranges = {
      power: [0, 120],
      reactivity: [-5, 5],
      orm: [0, 35],
      pressure: [0, 9],
      flowLeft: [0, 120],
      flowRight: [0, 120],
      measuredFlowLeft: [0, 120],
      measuredFlowRight: [0, 120],
      drumLevelLeft: [-1200, 600],
      drumLevelRight: [-1200, 600],
      coolantInventory: [0, 120],
      voidPercent: [0, 40],
      coolantTemperature: [250, 320],
      fuelTemperature: [0, 1100],
      graphiteTemperature: [0, 900],
      steamFlow: [0, 120],
      electricalPower: [0, 1000],
      frequency: [48, 52],
    };
    if (key === 'turbineLoads')
      return (
        (this.controlNormalized('turbineLoad1', state.controls.turbineLoad1) +
          this.controlNormalized('turbineLoad2', state.controls.turbineLoad2)) /
        2
      );
    const [minimum, maximum] = ranges[key] || [0, 100];
    return Math.max(
      0,
      Math.min(1, (Number(raw) - minimum) / (maximum - minimum)),
    );
  }

  drawInstrument(screen, state) {
    screen.renderedState = {
      controls: { ...state.controls },
      scrammed: state.scrammed,
      power: state.power,
      pressure: state.pressure,
      alarms: [...state.alarms],
    };
    screen.renderedAt = this.lastDraw;
    const context = screen.texture.getContext();
    context.fillStyle = '#d6cfb7';
    context.fillRect(0, 0, 640, 430);
    context.strokeStyle = '#302f29';
    context.lineWidth = 8;
    context.strokeRect(7, 7, 626, 416);
    context.fillStyle = '#545957';
    context.fillRect(14, 14, 612, 48);
    context.fillStyle = '#e8dfc2';
    context.font = 'bold 24px monospace';
    context.textAlign = 'center';
    context.fillText(screen.panel.title, 320, 47, 585);
    context.textAlign = 'left';
    if (screen.panel.kind === 'annunciator') {
      this.drawAnnunciator(context, state);
      screen.texture.update();
      return;
    }
    screen.panel.readings.forEach(([label, key], index) => {
      const raw = this.readingValue(state, key);
      const normalized = this.readingNormalized(state, key, raw);
      const y = 91 + index * 61;
      const left = 235;
      const right = 605;
      context.fillStyle = '#363834';
      context.font = 'bold 17px monospace';
      context.fillText(label, 25, y + 10, 195);
      context.fillStyle = '#eee7cf';
      context.fillRect(left - 8, y - 19, right - left + 16, 47);
      context.strokeStyle = '#34342f';
      context.lineWidth = 2;
      context.strokeRect(left - 8, y - 19, right - left + 16, 47);
      context.beginPath();
      context.moveTo(left, y + 5);
      context.lineTo(right, y + 5);
      for (let tick = 0; tick <= 20; tick++) {
        const x = left + ((right - left) * tick) / 20;
        context.moveTo(x, y - (tick % 5 ? 4 : 11));
        context.lineTo(x, y + (tick % 5 ? 11 : 17));
      }
      context.stroke();
      const pointer = left + (right - left) * normalized;
      context.strokeStyle = '#9c342c';
      context.lineWidth = 5;
      context.beginPath();
      context.moveTo(pointer, y - 15);
      context.lineTo(pointer, y + 23);
      context.stroke();
    });
    context.fillStyle = state.scrammed ? '#b54132' : '#667c62';
    context.fillRect(24, 393, 24, 18);
    context.fillStyle = '#3b3a34';
    context.font = 'bold 15px monospace';
    context.fillText(state.scrammed ? 'АЗ-5' : 'ГОТОВНОСТЬ АЗ', 58, 408);
    screen.texture.update();
  }

  drawAnnunciator(context, state) {
    const lamps = [
      ['АЗ-5', state.scrammed, 'red'],
      ['N >', state.power > 105, 'red'],
      ['P КМПЦ', state.pressure > 7.8 || state.pressure < 6.4, 'yellow'],
      ['G ЛЕВ', state.flowLeft < 75, 'yellow'],
      ['G ПРАВ', state.flowRight < 75, 'yellow'],
      ['БС-Л', state.drumLevelLeft < -450, 'yellow'],
      ['БС-П', state.drumLevelRight < -450, 'yellow'],
      ['САОР', state.controls.eccsAvailable, 'green'],
      ['ВПРЫСК', state.controls.emergencyInjection, 'green'],
      ['ГЦН-Л', state.controls.pumpsLeft < 3, 'yellow'],
      ['ГЦН-П', state.controls.pumpsRight < 3, 'yellow'],
      ['ТГ-1', !state.controls.generatorBreaker1, 'yellow'],
      ['ТГ-2', !state.controls.generatorBreaker2, 'yellow'],
      ['ОЗР', state.orm < 15, 'red'],
      ['T ТОПЛ.', state.fuelTemperature > 900, 'red'],
      ['УТЕЧКА', state.coolantInventory < 92, 'red'],
      ['АР', state.controls.automaticRegulator, 'green'],
      ['ГОТОВН.', !state.scrammed, 'green'],
    ];
    lamps.forEach(([label, condition, color], index) => {
      const active = state.equipment.lampTestUntil > state.elapsed || condition;
      const column = index % 3;
      const row = Math.floor(index / 3);
      const x = 26 + column * 199;
      const y = 82 + row * 50;
      const activeColor =
        color === 'red' ? '#bc493b' : color === 'green' ? '#62866b' : '#c7a44d';
      context.fillStyle = active ? activeColor : '#837f70';
      context.fillRect(x, y, 182, 34);
      context.strokeStyle = '#403d35';
      context.lineWidth = 3;
      context.strokeRect(x, y, 182, 34);
      context.fillStyle = active ? '#f3e9c7' : '#36352f';
      context.font = 'bold 15px monospace';
      context.textAlign = 'center';
      context.fillText(label, x + 91, y + 23, 170);
    });
    context.textAlign = 'left';
    context.strokeStyle = '#4e4b40';
    context.lineWidth = 2;
    context.beginPath();
    this.history.forEach((sample, index) => {
      const x = 25 + (index / Math.max(1, this.history.length - 1)) * 590;
      const y = 412 - Math.max(0, Math.min(1, sample.power / 120)) * 34;
      if (!index) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  }
}
