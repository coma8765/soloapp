import { orientation, vec } from './scene.js';
import { REACTOR_MAP } from '../shared/room.js';
import { RbmkModel } from './rbmk-model.js';
import { RBMK_CONTROLS, RBMK_PANEL_PARTS } from './rbmk-data.js';

const B = window.BABYLON;
export { REACTOR_MAP } from '../shared/room.js';

export class ReactorRoom {
  constructor(scene, terrain, planet, player, canvas, elements) {
    Object.assign(this, {
      scene,
      terrain,
      planet,
      player,
      canvas,
      elements,
    });
    this.model = new RbmkModel();
    this.root = new B.TransformNode('RBMK training room', scene);
    this.root.setEnabled(false);
    this.colliders = [];
    this.hotspots = [];
    this.cooldown = 0;
    this.lastStatusDraw = 0;
    this.lastSharedState = 0;
    this.teamLog = [];
    this.materials = new Map();
    this.buildRoom();
    this.buildPlanetPortal();
    this.bindUI();
  }

  material(name, color, emissive = false, alpha = 1) {
    const material = new B.StandardMaterial(name, this.scene);
    material.diffuseColor = B.Color3.FromHexString(color);
    material.specularColor.set(0.12, 0.12, 0.12);
    material.alpha = alpha;
    if (emissive) {
      material.emissiveColor = material.diffuseColor;
      material.disableLighting = true;
    }
    return material;
  }

  box(name, size, position, material, parent = this.root, collider = false) {
    const mesh = B.MeshBuilder.CreateBox(
      name,
      { width: size[0], height: size[1], depth: size[2] },
      this.scene,
    );
    mesh.parent = parent;
    mesh.position.copyFromFloats(...position);
    mesh.material = material;
    mesh.isPickable = collider;
    if (collider) this.colliders.push(mesh);
    return mesh;
  }

  buildRoom() {
    const dark = this.material('RBMK room invisible shell', '#15191b');
    dark.alpha = 0.01;
    this.box(
      'RBMK floor collider',
      [24, 0.2, 24],
      [0, -0.1, 0],
      dark,
      this.root,
      true,
    );
    this.box(
      'RBMK ceiling collider',
      [24, 0.2, 24],
      [0, 24.1, 0],
      dark,
      this.root,
      true,
    );
    this.box(
      'RBMK west wall collider',
      [0.2, 24, 24],
      [-12.1, 12, 0],
      dark,
      this.root,
      true,
    );
    this.box(
      'RBMK east wall collider',
      [0.2, 24, 24],
      [12.1, 12, 0],
      dark,
      this.root,
      true,
    );
    this.box(
      'RBMK north wall collider',
      [24, 24, 0.2],
      [0, 12, -12.1],
      dark,
      this.root,
      true,
    );
    this.box(
      'RBMK south wall collider',
      [24, 24, 0.2],
      [0, 12, 12.1],
      dark,
      this.root,
      true,
    );

    const face = (name, filename, position, rotation) => {
      const mesh = B.MeshBuilder.CreatePlane(name, { size: 24 }, this.scene);
      mesh.parent = this.root;
      mesh.position.copyFromFloats(...position);
      mesh.rotation.copyFromFloats(...rotation);
      mesh.isPickable = false;
      const texture = new B.Texture(
        new URL(`../assets/reactor/${filename}`, import.meta.url).href,
        this.scene,
        false,
        false,
        B.Texture.TRILINEAR_SAMPLINGMODE,
      );
      texture.anisotropicFilteringLevel = 8;
      const material = this.material(name + ' material', '#ffffff', true);
      material.diffuseTexture = texture;
      material.emissiveTexture = texture;
      material.backFaceCulling = false;
      mesh.material = material;
      return mesh;
    };
    face(
      'Ignalina panorama f',
      'ignalina-control-room-f-3200.jpg',
      [0, 12, -12],
      [0, 0, 0],
    );
    face(
      'Ignalina panorama b',
      'ignalina-control-room-b-3200.jpg',
      [0, 12, 12],
      [0, Math.PI, 0],
    );
    face(
      'Ignalina panorama r',
      'ignalina-control-room-r-3200.jpg',
      [12, 12, 0],
      [0, -Math.PI / 2, 0],
    );
    face(
      'Ignalina panorama l',
      'ignalina-control-room-l-3200.jpg',
      [-12, 12, 0],
      [0, Math.PI / 2, 0],
    );
    face(
      'Ignalina panorama u',
      'ignalina-control-room-u-3200.jpg',
      [0, 24, 0],
      [Math.PI / 2, 0, 0],
    );
    face(
      'Ignalina panorama d',
      'ignalina-control-room-d-3200.jpg',
      [0, 0.01, 0],
      [-Math.PI / 2, 0, 0],
    );

    this.roomLight = new B.HemisphericLight(
      'RBMK room ambient light',
      B.Vector3.Up(),
      this.scene,
    );
    this.roomLight.intensity = 0.8;
    this.roomLight.setEnabled(false);
    this.buildExitPortal();
    this.buildHotspots();
    this.buildStatusDisplay();
  }

  buildPlanetPortal() {
    const spawn = vec(this.terrain.spawn());
    const up = spawn.normalizeToNew();
    let tangent = B.Vector3.Cross(B.Axis.Y, up);
    if (tangent.lengthSquared() < 0.01) tangent = B.Vector3.Cross(B.Axis.X, up);
    tangent.normalize();
    const arc = 3.2 / spawn.length();
    const direction = up
      .scale(Math.cos(arc))
      .add(tangent.scale(Math.sin(arc)))
      .normalize();
    const position = direction.scale(
      this.terrain.radius(direction.asArray()) + 0.04,
    );
    this.portalRoot = new B.TransformNode('RBMK portal near spawn', this.scene);
    this.portalRoot.position.copyFrom(position);
    this.portalRoot.rotationQuaternion = orientation(
      tangent.negate(),
      direction,
    );
    this.portalPosition = position;
    this.portalFrame(this.portalRoot, false);
  }

  portalFrame(parent, exit) {
    const frame = this.material(
      exit ? 'RBMK return portal frame' : 'RBMK entry portal frame',
      exit ? '#d7b15e' : '#62d0d8',
      true,
    );
    const glow = this.material(
      exit ? 'RBMK return portal glow' : 'RBMK entry portal glow',
      exit ? '#9a6e34' : '#154f59',
      true,
      0.62,
    );
    this.box(
      'Portal left upright',
      [0.18, 3.1, 0.22],
      [-1.15, 1.55, 0],
      frame,
      parent,
    );
    this.box(
      'Portal right upright',
      [0.18, 3.1, 0.22],
      [1.15, 1.55, 0],
      frame,
      parent,
    );
    this.box('Portal lintel', [2.48, 0.18, 0.22], [0, 3.02, 0], frame, parent);
    const surface = B.MeshBuilder.CreatePlane(
      exit ? 'Return portal surface' : 'RBMK portal surface',
      { width: 2.15, height: 2.82 },
      this.scene,
    );
    surface.parent = parent;
    surface.position.set(0, 1.52, 0.05);
    surface.material = glow;
    surface.isPickable = false;
  }

  buildExitPortal() {
    this.exitPortal = new B.TransformNode('RBMK return portal', this.scene);
    this.exitPortal.parent = this.root;
    this.exitPortal.position.set(0, 0, 10.7);
    this.exitPortal.rotation.y = Math.PI;
    this.portalFrame(this.exitPortal, true);
  }

  buildHotspots() {
    for (const part of RBMK_PANEL_PARTS) {
      const [offset, bottom, width, height] = part.area;
      const wall = part.wall;
      const mesh = B.MeshBuilder.CreatePlane(
        `RBMK hotspot ${part.id} ${wall}`,
        { width, height },
        this.scene,
      );
      mesh.parent = this.root;
      if (wall === 'left' || wall === 'right') {
        mesh.position.set(
          wall === 'left' ? -11.88 : 11.88,
          bottom + height / 2,
          offset + width / 2,
        );
        mesh.rotation.y = wall === 'left' ? Math.PI / 2 : -Math.PI / 2;
      } else {
        mesh.position.set(
          offset + width / 2,
          bottom + height / 2,
          wall === 'back' ? 11.88 : -11.88,
        );
        mesh.rotation.y = wall === 'back' ? Math.PI : 0;
      }
      const material = this.material(
        `RBMK hotspot material ${part.id} ${wall}`,
        part.id === 'az5' ? '#ff684d' : '#59d6de',
        true,
        0.025,
      );
      material.backFaceCulling = false;
      mesh.material = material;
      mesh.metadata = { rbmkPart: part };
      mesh.isPickable = false;
      this.hotspots.push(mesh);
    }
  }

  buildStatusDisplay() {
    const consoleMaterial = this.material('RBMK training console', '#30393b');
    this.box(
      'RBMK training console body',
      [4.6, 1.15, 0.35],
      [0, 1.55, -7.7],
      consoleMaterial,
    );
    this.statusPlane = B.MeshBuilder.CreatePlane(
      'RBMK live parameter display',
      { width: 4.25, height: 2.2 },
      this.scene,
    );
    this.statusPlane.parent = this.root;
    this.statusPlane.position.set(0, 2.45, -7.49);
    this.statusPlane.isPickable = false;
    this.statusTexture = new B.DynamicTexture(
      'RBMK live parameter texture',
      { width: 1024, height: 530 },
      this.scene,
      true,
    );
    const material = this.material(
      'RBMK live parameter material',
      '#ffffff',
      true,
    );
    material.diffuseTexture = this.statusTexture;
    material.emissiveTexture = this.statusTexture;
    material.backFaceCulling = false;
    this.statusPlane.material = material;
    this.drawStatus(true);
  }

  connectNetwork(network) {
    this.network = network;
    network.onReactorMessage = (peerId, message) =>
      this.receiveNetworkMessage(peerId, message);
  }

  share(kind, payload = {}) {
    this.network?.broadcastControl({
      type: 'reactor',
      map: REACTOR_MAP,
      kind,
      ...payload,
    });
  }

  actorLabel(peerId = this.network?.id) {
    return peerId ? `участник #${peerId}` : 'локальный участник';
  }

  record(text, peerId = this.network?.id) {
    const elapsed = Math.max(0, Math.round(this.model.elapsed));
    this.teamLog.unshift(
      `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(
        elapsed % 60,
      ).padStart(2, '0')} · ${this.actorLabel(peerId)} · ${text}`,
    );
    this.teamLog.length = Math.min(this.teamLog.length, 12);
    this.syncTeamPanel();
  }

  syncTeamPanel() {
    if (!this.elements.team) return;
    const participants = [
      ...(this.network?.id ? [this.network.id] : []),
      ...[...(this.network?.remotes || [])]
        .filter(([, remote]) => remote.state?.map === REACTOR_MAP)
        .map(([id]) => id),
    ].sort((a, b) => a - b);
    const heading = participants.length
      ? `Команда в БЩУ: ${participants.map((id) => `#${id}`).join(', ')}`
      : 'Локальный режим · войдите для командной синхронизации';
    const value = `${heading}\n${
      this.teamLog.join('\n') || 'Журнал действий пока пуст'
    }`;
    if (this.elements.team.textContent !== value)
      this.elements.team.textContent = value;
  }

  applyAction(action) {
    if (action === 'scram') {
      this.model.scram();
      return true;
    }
    if (action === 'clear') return this.model.clearScram();
    if (action === 'reset') {
      this.model.reset();
      return true;
    }
    return false;
  }

  receiveNetworkMessage(peerId, message) {
    if (!this.active || message?.map !== REACTOR_MAP) return;
    if (message.kind === 'state-request') {
      this.network?.sendControl(peerId, {
        type: 'reactor',
        map: REACTOR_MAP,
        kind: 'state',
        state: this.model.snapshot(),
      });
      return;
    }
    if (message.kind === 'state') {
      if (this.model.restore(message.state)) {
        this.drawStatus(true);
        this.syncDialog();
      }
      return;
    }
    if (message.kind === 'control') {
      const value = this.model.setControl(message.name, message.value);
      if (value === undefined) return;
      const schema = RBMK_CONTROLS[message.name];
      this.record(
        `${schema.label}: ${this.formatControl(message.name, value)}`,
        peerId,
      );
    } else if (message.kind === 'action') {
      if (!this.applyAction(message.action)) return;
      this.record(this.actionLabel(message.action), peerId);
    } else return;
    this.syncDialog();
    this.drawStatus(true);
  }

  teamLeader() {
    const candidates = [
      ...(this.network?.id ? [this.network.id] : []),
      ...[...(this.network?.remotes || [])]
        .filter(([, remote]) => remote.state?.map === REACTOR_MAP)
        .map(([id]) => id),
    ];
    return candidates.length ? Math.min(...candidates) : 0;
  }

  teamSize() {
    if (!this.active) return 0;
    return (
      1 +
      [...(this.network?.remotes || [])].filter(
        ([, remote]) => remote.state?.map === REACTOR_MAP,
      ).length
    );
  }

  formatControl(name, value) {
    const schema = RBMK_CONTROLS[name];
    if (schema.type === 'checkbox') return value ? 'да' : 'нет';
    if (schema.type === 'select') return schema.options[value];
    const rounded = Math.round(value / schema.step) * schema.step;
    return `${rounded} ${schema.unit}`;
  }

  actionLabel(action) {
    if (action === 'scram') return 'АЗ-5';
    if (action === 'clear') return 'снятие останова';
    return 'возврат к исходному режиму';
  }

  bindUI() {
    const { hints, exit, dialog, close, fields, actions } = this.elements;
    hints.onclick = () => this.setHints(!this.hints);
    exit.onclick = () => this.leave();
    close.onclick = () => dialog.close();
    fields.addEventListener('input', (event) => {
      const input = event.target.closest('[data-rbmk-control]');
      if (!input) return;
      const name = input.dataset.rbmkControl;
      const value = this.model.setControl(
        name,
        input.type === 'checkbox'
          ? input.checked
          : input.type === 'range'
            ? Number(input.value)
            : input.value,
      );
      if (value === undefined) return;
      this.share('control', { name, value });
      this.record(
        `${RBMK_CONTROLS[name].label}: ${this.formatControl(name, value)}`,
      );
      this.syncDialog();
      this.drawStatus(true);
    });
    actions.addEventListener('click', (event) => {
      const action =
        event.target.closest('[data-rbmk-action]')?.dataset.rbmkAction;
      if (!this.applyAction(action)) return;
      this.share('action', { action });
      this.record(this.actionLabel(action));
      this.syncDialog();
      this.drawStatus(true);
    });
    this.canvas.addEventListener('pointermove', (event) => {
      if (!this.active || !this.hints || event.target !== this.canvas) return;
      const hit = this.scene.pick(
        this.scene.pointerX,
        this.scene.pointerY,
        (mesh) => !!mesh.metadata?.rbmkPart,
      );
      const part = hit?.pickedMesh?.metadata?.rbmkPart;
      if (part) this.openPart(part);
      this.canvas.style.cursor = part ? 'help' : '';
    });
    this.canvas.addEventListener(
      'click',
      (event) => {
        if (!this.active || !this.hints) return;
        const hit = this.scene.pick(
          this.scene.pointerX,
          this.scene.pointerY,
          (mesh) => !!mesh.metadata?.rbmkPart,
        );
        const part = hit?.pickedMesh?.metadata?.rbmkPart;
        if (part) {
          event.stopImmediatePropagation();
          this.openPart(part);
        }
      },
      true,
    );
  }

  setHints(enabled) {
    this.hints = !!enabled && this.active;
    this.elements.hints.setAttribute('aria-pressed', String(this.hints));
    this.elements.hints.textContent = this.hints
      ? 'Подсказки · включены'
      : 'Подсказки по панели';
    for (const mesh of this.hotspots) {
      mesh.isPickable = this.hints;
      mesh.material.alpha = this.hints ? 0.13 : 0.025;
    }
    if (this.hints) {
      document.exitPointerLock?.();
      this.player.keys.clear();
      this.openPart(RBMK_PANEL_PARTS[0]);
    } else {
      this.canvas.style.cursor = '';
      if (this.elements.dialog.open) this.elements.dialog.close();
    }
  }

  openPart(part) {
    if (this.currentPart?.id === part.id && this.elements.dialog.open) return;
    this.currentPart = part;
    this.elements.title.textContent = part.title;
    this.elements.description.textContent = part.description;
    this.elements.source.textContent = part.source;
    this.renderControls(part);
    if (!this.elements.dialog.open) this.elements.dialog.show();
    this.syncDialog();
  }

  renderControls(part) {
    const fields = [];
    for (const name of part.controls || []) {
      const schema = RBMK_CONTROLS[name];
      if (schema.type === 'checkbox') {
        const label = document.createElement('label');
        label.className = 'rbmk-switch';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.rbmkControl = name;
        label.append(input, document.createTextNode(schema.label));
        fields.push(label);
        continue;
      }
      const label = document.createElement('label');
      label.textContent = schema.label;
      if (schema.type === 'select') {
        const select = document.createElement('select');
        select.dataset.rbmkControl = name;
        for (const [value, text] of Object.entries(schema.options)) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = text;
          select.append(option);
        }
        label.append(select);
        fields.push(label);
        continue;
      }
      const row = document.createElement('span');
      row.className = 'rbmk-range-row';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = schema.min;
      input.max = schema.max;
      input.step = schema.step;
      input.dataset.rbmkControl = name;
      const output = document.createElement('output');
      output.dataset.rbmkValue = name;
      row.append(input, output);
      label.append(row);
      fields.push(label);
    }
    this.elements.fields.replaceChildren(...fields);
    const buttons = [];
    for (const action of part.actions || []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.rbmkAction = action;
      button.textContent =
        action === 'scram'
          ? 'АЗ-5 · заглушить реактор'
          : 'Снять АЗ после останова';
      if (action === 'scram') button.className = 'danger';
      buttons.push(button);
    }
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.dataset.rbmkAction = 'reset';
    reset.textContent = 'Исходный режим';
    buttons.push(reset);
    this.elements.actions.replaceChildren(...buttons);
  }

  syncDialog() {
    const state = this.model.snapshot();
    for (const input of this.elements.fields.querySelectorAll(
      '[data-rbmk-control]',
    )) {
      const value = state.controls[input.dataset.rbmkControl];
      if (input.type === 'checkbox') input.checked = value;
      else if (document.activeElement !== input) input.value = value;
    }
    for (const output of this.elements.fields.querySelectorAll(
      '[data-rbmk-value]',
    )) {
      const name = output.dataset.rbmkValue;
      output.value = this.formatControl(name, state.controls[name]);
    }
    const clear = this.elements.actions.querySelector(
      '[data-rbmk-action="clear"]',
    );
    if (clear)
      clear.disabled =
        !state.scrammed ||
        state.power > 3 ||
        state.controls.scenario !== 'normal';
    this.elements.summary.textContent = this.statusText();
  }

  enter() {
    if (this.active || this.cooldown > 0) return;
    this.saved = {
      position: this.player.position.clone(),
      forward: this.player.forward.clone(),
      pitch: this.player.pitch,
    };
    this.active = true;
    this.cooldown = 1.5;
    this.root.setEnabled(true);
    this.roomLight.setEnabled(true);
    this.portalRoot.setEnabled(false);
    this.planet.setVisible(false);
    this.player.roomColliders = this.colliders;
    this.player.setMap(REACTOR_MAP, [0, 0, 7.4]);
    this.player.forward.set(0, 0, -1);
    this.elements.hints.hidden = false;
    this.elements.exit.hidden = false;
    this.elements.telemetry.hidden = false;
    if (this.elements.team) this.elements.team.hidden = false;
    document.body.classList.add('in-reactor');
    this.record('вход через портал');
    this.share('state-request');
    this.syncTeamPanel();
    this.drawStatus(true);
  }

  leave() {
    if (!this.active) return;
    this.setHints(false);
    this.active = false;
    this.cooldown = 1.5;
    this.root.setEnabled(false);
    this.roomLight.setEnabled(false);
    this.planet.setVisible(true);
    this.portalRoot.setEnabled(true);
    this.player.roomColliders = [];
    this.player.setMap('planet', this.saved.position.asArray());
    this.player.forward.copyFrom(this.saved.forward);
    this.player.pitch = this.saved.pitch;
    this.player.update(0);
    this.elements.hints.hidden = true;
    this.elements.exit.hidden = true;
    this.elements.telemetry.hidden = true;
    if (this.elements.team) this.elements.team.hidden = true;
    document.body.classList.remove('in-reactor');
    this.syncTeamPanel();
  }

  get uiOpen() {
    return this.active && (this.hints || this.elements.dialog.open);
  }

  update(dt) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (!this.active) {
      if (
        this.cooldown === 0 &&
        this.planet.visible &&
        B.Vector3.Distance(this.player.position, this.portalPosition) < 1.25
      )
        this.enter();
      return;
    }
    this.model.step(dt);
    const now = performance.now();
    if (
      this.network?.id &&
      this.teamLeader() === this.network.id &&
      now - this.lastSharedState > 1000
    ) {
      this.lastSharedState = now;
      this.share('state', { state: this.model.snapshot() });
    }
    if (
      this.cooldown === 0 &&
      Math.hypot(
        this.player.position.x - this.exitPortal.position.x,
        this.player.position.z - this.exitPortal.position.z,
      ) < 1.15
    ) {
      this.leave();
      return;
    }
    this.drawStatus();
    if (this.elements.dialog.open) this.syncDialog();
    this.elements.telemetry.textContent = this.statusText();
    this.syncTeamPanel();
  }

  statusText() {
    const s = this.model.snapshot();
    const alarms = s.alarms.length ? s.alarms.join('\n') : 'Сигналов нет';
    return `РБМК · УЧЕБНАЯ МОДЕЛЬ v${s.modelVersion}\nСценарий: ${s.scenario.label}\nМощность ${s.power.toFixed(1)} % · ${s.electricalPower.toFixed(0)} МВт\nДавление ${s.pressure.toFixed(2)} МПа\nУровни БС Л/П ${Math.round(s.drumLevelLeft)} / ${Math.round(s.drumLevelRight)} мм\nРасходы физ. Л/П ${s.flowLeft.toFixed(0)} / ${s.flowRight.toFixed(0)} %\nПоказания Л/П ${s.measuredFlowLeft.toFixed(0)} / ${s.measuredFlowRight.toFixed(0)} %\nОЗР ${s.orm.toFixed(1)} ст. · ρ ${s.reactivity.toFixed(2)} усл.\nПаросодержание ${(s.voidFraction * 100).toFixed(1)} % · запас ${s.coolantInventory.toFixed(1)} %\nT теплоносителя/топлива ${s.coolantTemperature.toFixed(1)} / ${s.fuelTemperature.toFixed(0)} °C\n${alarms}`;
  }

  drawStatus(force = false) {
    const now = performance.now();
    if (!force && now - this.lastStatusDraw < 150) return;
    this.lastStatusDraw = now;
    const s = this.model.snapshot();
    const context = this.statusTexture.getContext();
    context.fillStyle = '#071918';
    context.fillRect(0, 0, 1024, 530);
    context.strokeStyle = '#4fae78';
    context.lineWidth = 5;
    context.strokeRect(8, 8, 1008, 514);
    context.fillStyle = '#87ffc0';
    context.font = 'bold 42px monospace';
    context.fillText('РБМК · УЧЕБНАЯ МОДЕЛЬ', 40, 62);
    context.font = '34px monospace';
    const rows = [
      [`N, %`, s.power.toFixed(1)],
      [`P КМПЦ, МПа`, s.pressure.toFixed(2)],
      [
        `H БС Л/П, мм`,
        `${Math.round(s.drumLevelLeft)}/${Math.round(s.drumLevelRight)}`,
      ],
      [`ОЗР, ст.`, s.orm.toFixed(1)],
      [
        `G КМПЦ Л/П, %`,
        `${s.measuredFlowLeft.toFixed(0)}/${s.measuredFlowRight.toFixed(0)}`,
      ],
      [`Nэл, МВт`, s.electricalPower.toFixed(0)],
    ];
    rows.forEach(([label, value], index) => {
      const x = index < 3 ? 40 : 530;
      const y = 130 + (index % 3) * 62;
      context.fillStyle = '#8aaea0';
      context.fillText(label, x, y);
      context.fillStyle = '#d8ffe5';
      context.textAlign = 'right';
      context.fillText(value, x + 410, y);
      context.textAlign = 'left';
    });
    context.fillStyle = s.alarms.length ? '#ff6b55' : '#73d892';
    context.font = 'bold 30px monospace';
    const alarm = s.alarms[0] || 'НОРМАЛЬНАЯ ЭКСПЛУАТАЦИЯ';
    context.fillText(alarm.slice(0, 52), 40, 430);
    context.fillStyle = '#789c8c';
    context.font = '24px monospace';
    context.fillText(
      'Оценочная динамика для тренажёра · не проектные данные',
      40,
      490,
    );
    this.statusTexture.update();
  }
}
