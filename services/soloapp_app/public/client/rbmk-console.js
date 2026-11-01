import {
  RBMK_CONTROLS,
  RBMK_INSTRUMENT_PANELS,
  RBMK_PANEL_PARTS,
  RBMK_PHYSICAL_CONTROL_GROUPS,
} from './rbmk-data.js';

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
});

function partById(id) {
  return RBMK_PANEL_PARTS.find((part) => part.id === id);
}

function formatControl(name, value) {
  const schema = RBMK_CONTROLS[name];
  if (schema.type === 'checkbox') return value ? 'ВКЛ' : 'ОТКЛ';
  if (schema.type === 'select') return schema.options[value];
  return `${Math.round(value / schema.step) * schema.step} ${schema.unit}`;
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
    this.lastDraw = 0;
    this.lastActivation = 0;
    this.onActivation = null;
    this.build();
  }

  material(name, color, emissive = false) {
    const material = new B.StandardMaterial(name, this.scene);
    material.diffuseColor = B.Color3.FromHexString(color);
    material.specularColor.set(0.14, 0.14, 0.14);
    if (emissive) {
      material.emissiveColor = material.diffuseColor.scale(0.65);
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

  texturePlane(name, width, height, textureSize, position, parent = this.root) {
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
    plane.material = material;
    plane.isPickable = false;
    return { plane, texture };
  }

  build() {
    const steel = this.material('RBMK physical console steel', '#60696b');
    const bezel = this.material('RBMK physical console bezels', '#242b2d');
    const edge = this.material('RBMK physical console edges', '#8a9190');
    this.box(
      'RBMK physical rear cabinet',
      [18.2, 5.5, 0.62],
      [0, 2.75, -9],
      steel,
    );
    this.box(
      'RBMK physical rear cabinet top',
      [18.5, 0.14, 0.8],
      [0, 5.53, -8.92],
      edge,
    );
    this.box(
      'RBMK physical console plinth',
      [18.2, 0.18, 1.8],
      [0, 0.09, -7.85],
      bezel,
    );

    RBMK_INSTRUMENT_PANELS.forEach((panel, index) => {
      const x = -7.2 + index * 2.88;
      this.box(
        `RBMK instrument bezel ${panel.id}`,
        [2.72, 1.92, 0.22],
        [x, 4.23, -8.62],
        bezel,
      );
      const screen = this.texturePlane(
        `RBMK live instrument ${panel.id}`,
        2.54,
        1.72,
        { width: 640, height: 430 },
        [x, 4.23, -8.495],
      );
      screen.panel = panel;
      screen.plane.metadata = { rbmkPart: partById(panel.part) };
      this.screens.push(screen);
      this.hintMeshes.push(screen.plane);
    });

    RBMK_PHYSICAL_CONTROL_GROUPS.forEach((group, index) => {
      const x = -6.75 + index * 4.5;
      this.buildControlGroup(group, x, steel, bezel, edge);
    });
  }

  buildControlGroup(group, centerX, steel, bezel, edge) {
    const groupRoot = new B.TransformNode(
      `RBMK control group ${group.id}`,
      this.scene,
    );
    groupRoot.parent = this.root;
    groupRoot.position.set(centerX, 0, 0);
    this.box(
      `RBMK control board ${group.id}`,
      [4.18, 3.02, 0.42],
      [0, 1.61, -7.95],
      steel,
      groupRoot,
    );
    this.box(
      `RBMK control board header ${group.id}`,
      [4.02, 0.34, 0.12],
      [0, 2.93, -7.69],
      bezel,
      groupRoot,
    );
    const header = this.texturePlane(
      `RBMK control group title ${group.id}`,
      3.88,
      0.26,
      { width: 512, height: 64 },
      [0, 2.93, -7.62],
      groupRoot,
    );
    const headerContext = header.texture.getContext();
    headerContext.fillStyle = '#182022';
    headerContext.fillRect(0, 0, 512, 64);
    headerContext.fillStyle = '#e8dfbd';
    headerContext.font = 'bold 24px monospace';
    headerContext.textAlign = 'center';
    headerContext.fillText(group.title, 256, 41);
    header.texture.update();
    header.plane.metadata = { rbmkPart: partById(group.part) };
    this.hintMeshes.push(header.plane);

    const items = [
      ...group.controls.map((name) => ({ type: 'control', name })),
      ...(group.actions || []).map((name) => ({ type: 'action', name })),
    ];
    items.forEach((item, index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const x = column ? 1.02 : -1.02;
      const y = 2.48 - row * 0.68;
      if (item.type === 'control')
        this.buildControlCell(groupRoot, item.name, x, y, group.part, bezel);
      else this.buildActionCell(groupRoot, item.name, x, y, group.part, edge);
    });
  }

  buildControlCell(parent, name, x, y, fallbackPart, bezel) {
    const schema = RBMK_CONTROLS[name];
    const part =
      RBMK_PANEL_PARTS.find((candidate) =>
        candidate.controls?.includes(name),
      ) || partById(fallbackPart);
    this.box(
      `RBMK control recess ${name}`,
      [1.86, 0.58, 0.12],
      [x, y, -7.68],
      bezel,
      parent,
    );
    const readout = this.texturePlane(
      `RBMK control readout ${name}`,
      1.7,
      0.29,
      { width: 400, height: 72 },
      [x, y + 0.125, -7.605],
      parent,
    );
    readout.name = name;
    readout.plane.metadata = { rbmkPart: part };
    this.readouts.push(readout);
    this.hintMeshes.push(readout.plane);

    if (schema.type === 'checkbox') {
      this.createButton(
        parent,
        `RBMK toggle ${name}`,
        'ВКЛ / ОТКЛ',
        [x, y - 0.15, -7.56],
        [0.78, 0.2, 0.2],
        '#426d68',
        { rbmkControl: { name, mode: 'toggle' }, rbmkPart: part },
      );
      return;
    }
    const delta =
      schema.type === 'select' ? 1 : PHYSICAL_STEPS[name] || schema.step;
    this.createButton(
      parent,
      `RBMK decrease ${name}`,
      '−',
      [x - 0.43, y - 0.15, -7.56],
      [0.55, 0.2, 0.2],
      '#485356',
      { rbmkControl: { name, delta: -delta }, rbmkPart: part },
    );
    this.createButton(
      parent,
      `RBMK increase ${name}`,
      '+',
      [x + 0.43, y - 0.15, -7.56],
      [0.55, 0.2, 0.2],
      '#397077',
      { rbmkControl: { name, delta }, rbmkPart: part },
    );
  }

  buildActionCell(parent, action, x, y, fallbackPart, edge) {
    const part =
      action === 'scram'
        ? partById('az5')
        : action === 'clear'
          ? partById('az5')
          : partById(fallbackPart);
    this.box(
      `RBMK action guard ${action}`,
      [1.86, 0.58, 0.12],
      [x, y, -7.68],
      edge,
      parent,
    );
    this.createButton(
      parent,
      `RBMK physical action ${action}`,
      ACTION_LABELS[action],
      [x, y, -7.5],
      action === 'scram' ? [1.05, 0.38, 0.28] : [1.28, 0.3, 0.22],
      action === 'scram'
        ? '#c92f24'
        : action === 'clear'
          ? '#be9a35'
          : '#447d62',
      { rbmkAction: action, rbmkPart: part },
    );
  }

  createButton(parent, name, text, position, size, color, metadata) {
    const material = this.material(`${name} material`, color, true);
    const button = this.box(name, size, position, material, parent);
    button.isPickable = true;
    button.metadata = {
      ...metadata,
      restZ: position[2],
      pressedUntil: 0,
      baseColor: color,
    };
    const label = this.texturePlane(
      `${name} label`,
      Math.max(0.28, size[0] - 0.08),
      Math.max(0.11, size[1] - 0.04),
      { width: 256, height: 64 },
      [0, 0, size[2] / 2 + 0.006],
      button,
    );
    const context = label.texture.getContext();
    context.fillStyle = color;
    context.fillRect(0, 0, 256, 64);
    context.fillStyle = '#fff9df';
    context.font = `bold ${text.length > 8 ? 22 : 34}px monospace`;
    context.textAlign = 'center';
    context.fillText(text, 128, text.length > 8 ? 40 : 44);
    label.texture.update();
    label.plane.isPickable = false;
    this.buttons.push(button);
    return button;
  }

  setHints(enabled) {
    for (const mesh of this.hintMeshes) mesh.isPickable = !!enabled;
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
      if (control.mode === 'toggle') value = !current;
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
    mesh.position.z = mesh.metadata.restZ - 0.07;
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
        button.position.z = button.metadata.restZ;
      }
      const control = button.metadata.rbmkControl;
      if (!control || control.mode !== 'toggle') continue;
      const active = !!state.controls[control.name];
      button.material.diffuseColor = B.Color3.FromHexString(
        active ? '#43a66c' : '#654a43',
      );
      button.material.emissiveColor = button.material.diffuseColor.scale(0.65);
    }
  }

  sync(force = false) {
    const now = performance.now();
    const state = this.handlers.state();
    this.updateButtons(now, state);
    if (!force && now - this.lastDraw < 150) return;
    this.lastDraw = now;
    for (const screen of this.screens) this.drawInstrument(screen, state);
    for (const readout of this.readouts) this.drawReadout(readout, state);
  }

  drawReadout(readout, state) {
    const name = readout.name;
    const value = state.controls[name];
    const context = readout.texture.getContext();
    context.fillStyle = '#111718';
    context.fillRect(0, 0, 400, 72);
    context.fillStyle = '#c6bea2';
    context.font = 'bold 20px monospace';
    context.fillText(CONTROL_SHORT_LABELS[name], 10, 25);
    context.fillStyle = '#83f2b1';
    context.font = 'bold 23px monospace';
    context.textAlign = 'right';
    context.fillText(formatControl(name, value).slice(0, 24), 390, 56);
    context.textAlign = 'left';
    readout.texture.update();
    readout.renderedValue = value;
    readout.renderedAt = this.lastDraw;
  }

  readingValue(state, key) {
    if (key.startsWith('control:')) return state.controls[key.slice(8)];
    if (key === 'voidPercent') return state.voidFraction * 100;
    if (key === 'turbineLoads')
      return `${state.controls.turbineLoad1}/${state.controls.turbineLoad2}`;
    return state[key];
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
    context.fillStyle = '#071515';
    context.fillRect(0, 0, 640, 430);
    context.strokeStyle = '#40765d';
    context.lineWidth = 5;
    context.strokeRect(7, 7, 626, 416);
    context.fillStyle = '#9ff7ba';
    context.font = 'bold 30px monospace';
    context.fillText(screen.panel.title, 24, 48);
    if (screen.panel.kind === 'annunciator') {
      this.drawAnnunciator(context, state);
      screen.texture.update();
      return;
    }
    screen.panel.readings.forEach(([label, key, unit, digits], index) => {
      const raw = this.readingValue(state, key);
      const value = typeof raw === 'number' ? raw.toFixed(digits) : raw;
      const y = 100 + index * 63;
      context.fillStyle = '#729589';
      context.font = '22px monospace';
      context.fillText(label, 24, y);
      context.fillStyle = '#e5ffe9';
      context.font = 'bold 29px monospace';
      context.textAlign = 'right';
      context.fillText(`${value} ${unit}`, 614, y);
      context.textAlign = 'left';
      const normalized =
        typeof raw === 'number'
          ? Math.max(
              0,
              Math.min(
                1,
                Math.abs(raw) /
                  (key === 'pressure'
                    ? 9
                    : key.includes('Temperature')
                      ? 1100
                      : 120),
              ),
            )
          : 0;
      context.fillStyle = '#172723';
      context.fillRect(24, y + 13, 590, 10);
      context.fillStyle = state.alarms.length ? '#d9a23e' : '#3f9d68';
      context.fillRect(24, y + 13, 590 * normalized, 10);
    });
    context.fillStyle = state.scrammed ? '#ff5d4b' : '#5bc984';
    context.font = 'bold 24px monospace';
    context.fillText(state.scrammed ? 'АЗ СРАБОТАЛА' : 'АЗ ВЗВЕДЕНА', 24, 405);
    screen.texture.update();
  }

  drawAnnunciator(context, state) {
    const insertion =
      (state.controls.manualRodInsertion +
        state.controls.automaticRodInsertion +
        state.controls.shortenedRodInsertion) /
      3;
    for (let row = 0; row < 8; row++) {
      for (let column = 0; column < 8; column++) {
        const radial = Math.hypot(column - 3.5, row - 3.5) / 5;
        const local = Math.max(
          0,
          Math.min(
            1.2,
            (state.power / 100) *
              (1 - radial * 0.34) *
              (1 - insertion / 430) *
              (1 + Math.sin(row * 1.7 + column * 0.9) * 0.06),
          ),
        );
        const red = Math.round(45 + local * 175);
        const green = Math.round(55 + (1 - Math.abs(local - 0.65)) * 145);
        context.fillStyle = `rgb(${red},${green},58)`;
        context.fillRect(24 + column * 29, 82 + row * 29, 23, 23);
      }
    }
    context.fillStyle = '#789b8f';
    context.font = '18px monospace';
    context.fillText('КАРТА ЭНЕРГОВЫДЕЛЕНИЯ', 24, 337);
    context.fillStyle = '#e8ffe9';
    context.font = 'bold 20px monospace';
    context.fillText(state.scenario.label.slice(0, 29), 282, 90);
    const alarms = state.alarms.length
      ? state.alarms.slice(0, 7)
      : ['СИГНАЛОВ НЕТ'];
    alarms.forEach((alarm, index) => {
      context.fillStyle = state.alarms.length ? '#ff765f' : '#64d78d';
      context.font = `${index ? '' : 'bold '}18px monospace`;
      context.fillText(alarm.slice(0, 31), 282, 133 + index * 35);
    });
    context.fillStyle = state.controls.eccsAvailable ? '#64d78d' : '#ff765f';
    context.font = 'bold 19px monospace';
    context.fillText(
      `САОР ${state.controls.eccsAvailable ? 'ГОТОВА' : 'НЕДОСТУПНА'} · ВПРЫСК ${
        state.controls.emergencyInjection ? 'ВКЛ' : 'ОТКЛ'
      }`,
      282,
      392,
    );
  }
}
