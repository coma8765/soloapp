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
    for (let index = 0; index < 7; index++) {
      const bay = this.arcNode(
        `RBMK wall bay ${index + 1}`,
        index,
        7,
        10.35,
        0.215,
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
      this.buildLabelRows(bay, index);
      if (index < RBMK_INSTRUMENT_PANELS.length)
        this.buildLiveScreen(bay, RBMK_INSTRUMENT_PANELS[index]);
      else this.buildRecorderCluster(bay);
    }
  }

  buildAnnunciators(parent, seed) {
    const colors = [this.cream, this.cream, this.yellow, this.green, this.red];
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 8; column++) {
        const color = colors[(column + row * 3 + seed) % colors.length];
        this.box(
          `RBMK annunciator ${seed}-${row}-${column}`,
          [0.215, 0.12, 0.065],
          [-0.79 + column * 0.225, 5.29 - row * 0.14, 0.22],
          color,
          parent,
        );
      }
    }
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
    for (let row = -4; row <= 4; row++) {
      for (let column = -6; column <= 6; column++) {
        if ((column / 6) ** 2 + (row / 4.4) ** 2 > 1) continue;
        const edge = Math.abs(column) > 4 || Math.abs(row) > 2;
        this.box(
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
        const context = board.texture.getContext();
        context.fillStyle = COLORS.schematic;
        context.fillRect(0, 0, 360, 220);
        context.strokeStyle = '#eee7cf';
        context.fillStyle = '#eee7cf';
        context.lineWidth = 5;
        context.font = 'bold 13px monospace';
        context.fillText(`2H${seed + 1}${row}${column}`, 10, 20);
        for (let line = 0; line < 3; line++) {
          const y = 54 + line * 57;
          context.beginPath();
          context.moveTo(14, y);
          context.lineTo(82 + seed * 3, y);
          context.lineTo(112, y + (line % 2 ? 22 : -22));
          context.lineTo(210, y + (line % 2 ? 22 : -22));
          context.lineTo(244, y);
          context.lineTo(346, y);
          context.stroke();
          for (let symbol = 0; symbol < 3; symbol++)
            context.strokeRect(47 + symbol * 112, y - 11, 22, 22);
        }
        board.texture.update();
        board.plane.metadata = {
          rbmkPart: partById(seed % 2 ? 'instrumentation' : 'annunciators'),
        };
        this.hintMeshes.push(board.plane);
      }
    }
  }

  buildLabelRows(parent, seed) {
    for (let row = 0; row < 6; row++) {
      for (let column = 0; column < 7; column++) {
        const active = (seed * 7 + row * 3 + column) % 11 === 0;
        this.box(
          `RBMK engraved label ${seed}-${row}-${column}`,
          [0.245, 0.065, 0.055],
          [-0.75 + column * 0.25, 3.42 - row * 0.09, 0.22],
          active ? this.yellow : this.cream,
          parent,
        );
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
    for (let handle = 0; handle < 3; handle++) {
      const knob = B.MeshBuilder.CreateCylinder(
        `RBMK instrument selector ${panel.id}-${handle}`,
        { diameter: 0.08, height: 0.055, tessellation: 16 },
        this.scene,
      );
      knob.parent = parent;
      knob.position.set(-0.2 + handle * 0.2, 1.78, 0.36);
      knob.rotation.x = Math.PI / 2;
      knob.material = this.bezel;
      knob.isPickable = false;
    }
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
        const context = chart.texture.getContext();
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
        context.strokeStyle = '#8d352f';
        context.lineWidth = 3;
        context.beginPath();
        for (let point = 0; point <= 30; point++) {
          const px = point * 10;
          const py =
            105 +
            Math.sin(point * 0.48 + row + column * 2) * 32 +
            Math.cos(point * 0.17 + column) * 14;
          if (!point) context.moveTo(px, py);
          else context.lineTo(px, py);
        }
        context.stroke();
        chart.texture.update();
      }
    }
  }

  buildDeskBank() {
    RBMK_PHYSICAL_CONTROL_GROUPS.forEach((group, index) => {
      const desk = this.arcNode(
        `RBMK desk section ${group.id}`,
        index + 1,
        6,
        7,
        0.44,
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
      this.buildDecorativeKeys(deck, index);
    });
    this.buildSideDesk(0, 'left');
    this.buildSideDesk(5, 'right');
  }

  buildSideDesk(index, side) {
    const desk = this.arcNode(`RBMK auxiliary desk ${side}`, index, 6, 7, 0.44);
    this.box(
      `RBMK auxiliary cabinet ${side}`,
      [3.05, 1.02, 1.78],
      [0, 0.51, 0],
      this.darkSteel,
      desk,
    );
    const deck = new B.TransformNode(
      `RBMK auxiliary sloped deck ${side}`,
      this.scene,
    );
    deck.parent = desk;
    deck.position.set(0, 1.08, 0);
    deck.rotation.x = 0.24;
    this.box(
      `RBMK auxiliary console plate ${side}`,
      [3.02, 0.16, 2.05],
      [0, 0, 0],
      this.steel,
      deck,
    );
    this.makeTextPlate(
      `RBMK auxiliary desk title ${side}`,
      side === 'left' ? 'КОНТРОЛЬ КАНАЛОВ' : 'СИГНАЛИЗАЦИЯ И СВЯЗЬ',
      2.72,
      0.18,
      [0, 0.115, -0.86],
      deck,
      '#5b6263',
      '#eee6c9',
      23,
      [-Math.PI / 2, 0, 0],
    );
    for (let row = 0; row < 7; row++) {
      for (let column = 0; column < 12; column++) {
        const material =
          (row + column + index) % 17 === 0
            ? this.yellow
            : (row * 2 + column + index) % 11 === 0
              ? this.green
              : this.cream;
        this.box(
          `RBMK ${side} matrix key ${row}-${column}`,
          [0.13, 0.05, 0.1],
          [-0.72 + column * 0.13, 0.125, -0.54 + row * 0.18],
          material,
          deck,
        );
      }
    }
  }

  buildControlGroup(parent, group) {
    const items = [
      ...group.controls.map((name) => ({ type: 'control', name })),
      ...(group.actions || []).map((name) => ({ type: 'action', name })),
    ];
    items.forEach((item, index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const x = column ? 0.72 : -0.72;
      const z = -0.52 + row * 0.42;
      if (item.type === 'control')
        this.buildControlCell(parent, item.name, x, z, group.part);
      else this.buildActionCell(parent, item.name, x, z, group.part);
    });
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

  buildDecorativeKeys(parent, seed) {
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 9; column++) {
        const material =
          (row * 9 + column + seed) % 13 === 0
            ? this.yellow
            : (row + column + seed) % 7 === 0
              ? this.green
              : this.cream;
        this.box(
          `RBMK auxiliary key ${seed}-${row}-${column}`,
          [0.13, 0.055, 0.11],
          [-0.55 + column * 0.14, 0.125, 0.62 + row * 0.13],
          material,
          parent,
        );
      }
    }
    for (let index = 0; index < 5; index++) {
      const guard = this.box(
        `RBMK guarded switch ${seed}-${index}`,
        [0.18, 0.16, 0.18],
        [-0.48 + index * 0.24, 0.18, 0.42],
        this.material(
          `RBMK guard material ${seed}-${index}`,
          '#d9cfad',
          false,
          0.42,
        ),
        parent,
      );
      guard.visibility = 0.78;
    }
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
      if (!control || control.mode !== 'toggle') continue;
      const active = !!state.controls[control.name];
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
    for (const screen of this.screens) this.drawInstrument(screen, state);
    for (const readout of this.readouts) this.drawReadout(readout, state);
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
    context.fillText(CONTROL_SHORT_LABELS[name], 200, 17, 382);
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
    const insertion =
      (state.controls.manualRodInsertion +
        state.controls.automaticRodInsertion +
        state.controls.shortenedRodInsertion) /
      3;
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
      ['ГЦН-Л', state.controls.pumpsLeft < 4, 'yellow'],
      ['ГЦН-П', state.controls.pumpsRight < 4, 'yellow'],
      ['ТГ-1', !state.controls.generatorBreaker1, 'yellow'],
      ['ТГ-2', !state.controls.generatorBreaker2, 'yellow'],
      ['ОЗР', state.orm < 15, 'red'],
      ['T ТОПЛ.', state.fuelTemperature > 900, 'red'],
      ['УТЕЧКА', state.coolantInventory < 92, 'red'],
      ['АР', state.controls.automaticRegulator, 'green'],
      ['ГОТОВН.', !state.scrammed, 'green'],
    ];
    lamps.forEach(([label, active, color], index) => {
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
    const local = Math.max(0, Math.min(1, state.power / 120));
    context.strokeStyle = '#4e4b40';
    context.lineWidth = 2;
    context.beginPath();
    for (let x = 25; x <= 615; x += 8) {
      const phase = (x - 25) / 590;
      const y =
        394 - local * 31 * (0.45 + Math.sin(phase * 24 + insertion / 30) * 0.2);
      if (x === 25) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
  }
}
