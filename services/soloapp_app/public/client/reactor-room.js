import { orientation, vec } from './scene.js';
import { REACTOR_MAP, PHYSICAL_MAP, isReactorMap } from '../shared/room.js';
import { RbmkModel } from './rbmk-model.js';
import { RBMK_CONTROLS, RBMK_PANEL_PARTS } from './rbmk-data.js';
import { RbmkPhysicalConsole } from './rbmk-console.js';
import { RbmkJournalStation } from './rbmk-journal-station.js';
import { RbmkJournal } from './rbmk-journal.js';
import { RbmkServerSync } from './rbmk-server.js';
import { PhysicalSystemRoom } from './physical-system-room.js';
import { ReactorInstructor } from './reactor-instructor.js';
import { ReactorWorkers } from './reactor-workers.js';

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
    this.instructor = new ReactorInstructor(this);
    this.workers = new ReactorWorkers(this);
    this.server = new RbmkServerSync({
      send: (message) => this.network?.send(message),
      restore: (state) => {
        if (!this.model.restore(state)) return false;
        this.syncDialog();
        this.drawStatus(true);
        return true;
      },
      journal: (entry) => {
        if (this.journal.store.receive(entry, entry?.actor)) {
          if (entry.id === this.journal.pendingId)
            this.journal.finishEntry(entry);
          this.journal.persist();
          this.journal.draw(true);
        }
      },
      record: (record) => {
        const c = record?.command;
        if (!c || c.kind === 'journal') return;
        const label =
          c.kind === 'control' && RBMK_CONTROLS[c.name]
            ? `${RBMK_CONTROLS[c.name].label}: ${this.formatControl(c.name, record.value)}`
            : this.actionLabel(c.action);
        this.instructor.serverControl(
          record,
          label,
          this.actorLabel(record.from),
        );
        this.journal.store.recordAction(
          label,
          this.actorLabel(record.from),
          record.elapsed,
        );
      },
      acknowledged: (reply, command) => {
        if (!reply.accepted && command.kind === 'journal') {
          this.journal.pendingId = null;
          this.journal.message = `Запись отклонена сервером: ${reply.error}`;
          this.journal.draw(true);
        }
      },
      changed: () => this.syncTeamPanel(),
    });
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
    const floor = this.material('RBMK room terrazzo floor', '#778786');
    floor.specularColor.set(0.24, 0.24, 0.24);
    const ceiling = this.material('RBMK room acoustic ceiling', '#c8c7ba');
    ceiling.emissiveColor = B.Color3.FromHexString('#5a5a54');
    const wall = this.material('RBMK room wood wall', '#75563e');
    const panelWall = this.material('RBMK room panel wall', '#4d5658');
    this.box(
      'RBMK floor collider',
      [24, 0.2, 24],
      [0, -0.1, 0],
      floor,
      this.root,
      true,
    );
    this.box(
      'RBMK ceiling collider',
      [24, 0.2, 24],
      [0, 5.9, 0],
      ceiling,
      this.root,
      true,
    );
    this.box(
      'RBMK west wall collider',
      [0.2, 6, 24],
      [-12.1, 3, 0],
      wall,
      this.root,
      true,
    );
    this.box(
      'RBMK east wall collider',
      [0.2, 6, 24],
      [12.1, 3, 0],
      wall,
      this.root,
      true,
    );
    this.box(
      'RBMK north wall collider',
      [24, 6, 0.2],
      [0, 3, -12.1],
      panelWall,
      this.root,
      true,
    );
    this.box(
      'RBMK south wall collider',
      [24, 6, 0.2],
      [0, 3, 12.1],
      wall,
      this.root,
      true,
    );
    const grid = this.material('RBMK ceiling grid', '#86877f');
    for (let x = -11; x <= 11; x += 2)
      this.box(
        `RBMK ceiling longitudinal grid ${x}`,
        [0.045, 0.055, 24],
        [x, 5.78, 0],
        grid,
      );
    for (let z = -11; z <= 11; z += 2)
      this.box(
        `RBMK ceiling transverse grid ${z}`,
        [24, 0.055, 0.045],
        [0, 5.77, z],
        grid,
      );
    const lamp = this.material(
      'RBMK fluorescent ceiling lamps',
      '#f4f0d8',
      true,
    );
    for (const [x, z] of [
      [-7, -7],
      [-3, -7],
      [1, -7],
      [5, -7],
      [-5, -3],
      [-1, -3],
      [3, -3],
      [7, -3],
      [-7, 1],
      [-3, 1],
      [1, 1],
      [5, 1],
      [-5, 5],
      [-1, 5],
      [3, 5],
      [7, 5],
    ])
      this.box(
        `RBMK ceiling luminaire ${x} ${z}`,
        [1.55, 0.035, 0.5],
        [x, 5.72, z],
        lamp,
      );

    this.roomLight = new B.HemisphericLight(
      'RBMK room ambient light',
      B.Vector3.Up(),
      this.scene,
    );
    this.roomLight.intensity = 1.05;
    this.roomLight.setEnabled(false);
    this.buildExitPortal();
    this.buildHotspots();
    this.buildPhysicalConsole();
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

  buildPhysicalConsole() {
    this.physicalConsole = new RbmkPhysicalConsole(this.scene, this.root, {
      state: () => this.model.snapshot(),
      control: (name, value, operation) =>
        this.commitControl(name, value, operation),
      action: (action) => this.commitAction(action),
    });
    this.journal = new RbmkJournalStation(this);
    this.journal.restore();
    this.drawStatus(true);
  }

  focusJournal(view = 'machine') {
    if (!this.active || this.player.xr) return;
    this.setHints(false);
    document.exitPointerLock?.();
    this.player.keys.clear();
    const views = {
      machine: [-4.48, 5.9, -0.12],
      book: [-2.35, 5.9, -0.38],
      tape: [-0.3, 6.4, 0.05],
    };
    const [x, z, pitch] = views[view] || views.machine;
    this.player.position.set(x, 0, z);
    this.player.forward.set(0, 0, -1);
    this.player.pitch = pitch;
    this.player.update(0);
    document.body.classList.add('at-journal');
  }

  interactiveMesh(mesh) {
    return !!(
      mesh?.isEnabled() &&
      mesh.isVisible &&
      mesh.isPickable &&
      (mesh.metadata?.rbmkInstructor ||
        mesh.metadata?.physicalSystem ||
        mesh.metadata?.rbmkPart ||
        mesh.metadata?.rbmkControl ||
        mesh.metadata?.rbmkAction ||
        mesh.metadata?.rbmkJournal)
    );
  }

  activatePhysical(mesh) {
    if (mesh?.metadata?.rbmkInstructor) {
      this.instructor.activate();
      return true;
    }
    if (this.physicalView) return this.physicalRoom?.activate(mesh) || false;
    return this.journal.activate(mesh) || this.physicalConsole.activate(mesh);
  }

  activateCenter() {
    if (!this.active || this.uiOpen) return false;
    return this.activatePhysical(this.pickInteraction(true)?.pickedMesh);
  }

  pickInteraction(center = document.pointerLockElement === this.canvas, event) {
    const predicate = (mesh) => this.interactiveMesh(mesh);
    if (center)
      return this.scene.pickWithRay(
        this.scene.activeCamera.getForwardRay(8),
        predicate,
      );
    const rect = this.canvas.getBoundingClientRect();
    return this.scene.pick(
      event ? event.clientX - rect.left : this.scene.pointerX,
      event ? event.clientY - rect.top : this.scene.pointerY,
      predicate,
    );
  }

  updateHover() {
    if (!this.active) return null;
    const center =
      document.pointerLockElement === this.canvas ||
      (!this.uiOpen && document.body.classList.contains('playing'));
    const mesh =
      !this.player.xr && (center || this.pointerOverCanvas)
        ? this.pickInteraction(center)?.pickedMesh
        : null;
    this.physicalConsole.setHovered(mesh);
    this.canvas.style.cursor =
      !center && mesh
        ? mesh.metadata.rbmkInstructor ||
          mesh.metadata.rbmkControl ||
          mesh.metadata.rbmkAction ||
          mesh.metadata.rbmkJournal ||
          mesh.metadata.physicalSystem
          ? 'pointer'
          : this.hints
            ? 'help'
            : ''
        : '';
    return mesh;
  }

  togglePhysical() {
    if (!this.active) this.enter();
    if (!this.active) return false;
    this.physicalRoom ||= new PhysicalSystemRoom(this);
    this.setHints(false);
    this.elements.dialog.close();
    this.journal.blur();
    document.body.classList.remove('at-journal');
    this.viewPoses ||= {};
    this.viewPoses[this.physicalView ? 'physical' : 'control'] = {
      position: this.player.position.asArray(),
      forward: this.player.forward.clone(),
      pitch: this.player.pitch,
    };
    this.physicalView = !this.physicalView;
    this.root.setEnabled(!this.physicalView);
    this.physicalRoom.root.setEnabled(this.physicalView);
    const pose = this.viewPoses[this.physicalView ? 'physical' : 'control'];
    this.player.roomColliders = this.physicalView
      ? this.physicalRoom.colliders
      : this.colliders;
    this.player.setMap(
      this.physicalView ? PHYSICAL_MAP : REACTOR_MAP,
      pose?.position || [0, 0, 7],
    );
    if (pose) {
      this.player.forward.copyFrom(pose.forward);
      this.player.pitch = pose.pitch;
    }
    this.player.update(0);
    this.elements.hints.hidden = this.physicalView;
    this.journalButton.hidden = this.physicalView;
    document.body.classList.toggle('in-physical-system', this.physicalView);
    this.physicalRoom.update(0, true);
    this.record(
      this.physicalView
        ? 'переход в комнату физических процессов'
        : 'возврат в БЩУ',
    );
    this.cooldown = 1.5;
    return true;
  }

  xrRay(frame, source, referenceSpace, origin) {
    const pose = frame.getPose(source.targetRaySpace, referenceSpace);
    if (!pose) return null;
    const { position: p, orientation: q } = pose.transform;
    const direction = new B.Vector3(0, 0, -1).rotateByQuaternionToRef(
      new B.Quaternion(q.x, q.y, q.z, q.w),
      B.Vector3.Zero(),
    );
    const world = origin.computeWorldMatrix(true);
    return new B.Ray(
      B.Vector3.TransformCoordinates(new B.Vector3(p.x, p.y, p.z), world),
      B.Vector3.TransformNormal(direction, world).normalize(),
      5,
    );
  }

  selectXR(event, referenceSpace, origin) {
    if (!this.active) return;
    const ray = this.xrRay(
      event.frame,
      event.inputSource,
      referenceSpace,
      origin,
    );
    if (ray)
      this.activatePhysical(
        this.scene.pickWithRay(ray, (mesh) => this.interactiveMesh(mesh))
          ?.pickedMesh,
      );
  }

  updateXR(frame, referenceSpace, origin) {
    this.xrRays ||= new Map();
    for (const line of this.xrRays.values()) line.setEnabled(false);
    if (!this.active) return;
    for (const source of frame.session.inputSources) {
      const ray = this.xrRay(frame, source, referenceSpace, origin);
      if (!ray) continue;
      const pick = this.scene.pickWithRay(ray, (mesh) =>
        this.interactiveMesh(mesh),
      );
      const points = [
        ray.origin,
        pick?.hit ? pick.pickedPoint : ray.origin.add(ray.direction.scale(3)),
      ];
      let line = this.xrRays.get(source);
      if (!line) {
        line = B.MeshBuilder.CreateLines(
          'RBMK controller pointer',
          { points, updatable: true },
          this.scene,
        );
        line.isPickable = false;
        this.xrRays.set(source, line);
      } else
        B.MeshBuilder.CreateLines(
          'RBMK controller pointer',
          { points, instance: line },
          this.scene,
        );
      line.color = pick?.hit
        ? new B.Color3(0.9, 0.85, 0.55)
        : new B.Color3(0.4, 0.65, 0.75);
      line.setEnabled(true);
    }
    for (const [source, line] of this.xrRays)
      if (![...frame.session.inputSources].includes(source)) {
        line.dispose();
        this.xrRays.delete(source);
      }
  }

  connectNetwork(network) {
    this.network = network;
    network.onInstructorMessage = (peer, message) =>
      this.instructor.receive(peer, message);
    network.onReactorMessage = (peerId, message) =>
      this.receiveNetworkMessage(peerId, message);
    network.onReactorServerMessage = (message) => {
      if (message.type === 'reactor_disconnect') {
        this.server.disconnect();
        return;
      }
      if (!this.active) return;
      if (message.type === 'reactor_welcome')
        this.enableServer(message.id, message.protocol, message.userId);
      else {
        if (
          message.type === 'reactor_state' &&
          !this.server.ready &&
          Number.isSafeInteger(message.revision)
        )
          this.instructor.commandRevision = message.revision;
        this.server.receive(message);
        if (
          message.type === 'reactor_state' &&
          message.storage === 'postgresql'
        )
          this.workers.clock.sync(message.serverTime);
      }
    };
    if (this.active && network.auth?.token) this.prepareServer();
  }

  prepareServer() {
    if (!this.server.required) {
      this.localJournal = this.journal.store;
      this.journal.store = new RbmkJournal();
      this.journal.storageKey = 'rbmk-server-journal-cache-v1';
    }
    this.server.required = true;
  }

  enableServer(id, protocol, userId) {
    this.prepareServer();
    this.server.connect(id, protocol, userId);
  }

  share(kind, payload = {}) {
    if (this.server?.required) return;
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
    this.journal.store.recordAction(
      text,
      this.actorLabel(peerId),
      this.model.elapsed,
    );
    this.syncTeamPanel();
  }

  syncTeamPanel() {
    if (!this.elements.team) return;
    const participants = [
      ...(this.network?.id ? [this.network.id] : []),
      ...[...(this.network?.remotes || [])]
        .filter(([, remote]) => isReactorMap(remote.state?.map))
        .map(([id]) => id),
    ].sort((a, b) => a - b);
    const heading = participants.length
      ? `Команда в БЩУ: ${participants.map((id) => `#${id}`).join(', ')}`
      : 'Локальный режим · войдите для командной синхронизации';
    const value = `${heading}\n${this.server?.status() || ''}`;
    if (this.elements.team.textContent !== value)
      this.elements.team.textContent = value;
  }

  applyAction(action) {
    if (action === 'acknowledge') {
      this.model.acknowledgeAlarms();
      return true;
    }
    if (action === 'lamp-test') {
      this.model.testLamps();
      return true;
    }
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

  commitControl(name, rawValue, operation = null) {
    if (this.server.required) {
      if (!RBMK_CONTROLS[name]) return false;
      const mode =
        operation?.mode === 'toggle'
          ? 'toggle'
          : operation?.delta !== undefined
            ? 'delta'
            : 'set';
      return !!this.server.request({
        kind: 'control',
        name,
        mode,
        ...(mode === 'delta'
          ? { delta: operation.delta }
          : { value: rawValue }),
      });
    }
    const value = this.model.setControl(name, rawValue);
    if (value === undefined) return false;
    this.share('control', { name, value });
    this.instructor.control(
      `${RBMK_CONTROLS[name].label}: ${this.formatControl(name, value)}`,
      this.actorLabel(),
    );
    this.record(
      `${RBMK_CONTROLS[name].label}: ${this.formatControl(name, value)}`,
    );
    this.syncDialog();
    this.drawStatus(true);
    return true;
  }

  commitAction(action) {
    if (this.server.required)
      return !!this.server.request({ kind: 'action', action });
    if (!this.applyAction(action)) return false;
    this.share('action', { action });
    this.instructor.control(this.actionLabel(action), this.actorLabel());
    this.record(this.actionLabel(action));
    this.syncDialog();
    this.drawStatus(true);
    return true;
  }

  receiveNetworkMessage(peerId, message) {
    if (this.server.required) return;
    if (!this.active || message?.map !== REACTOR_MAP) return;
    if (message.kind === 'state-request') {
      this.network?.sendControl(peerId, {
        type: 'reactor',
        map: REACTOR_MAP,
        kind: 'state',
        state: this.model.snapshot(),
      });
      for (
        let offset = 0;
        offset < this.journal.store.entries.length;
        offset += 10
      )
        this.network?.sendControl(peerId, {
          type: 'reactor',
          map: REACTOR_MAP,
          kind: 'journal-history',
          entries: this.journal.store.entries.slice(offset, offset + 10),
        });
      return;
    }
    if (message.kind === 'journal-entry') {
      if (this.journal.store.receive(message.entry, this.actorLabel(peerId))) {
        this.journal.persist();
        this.journal.draw(true);
      }
      return;
    }
    if (message.kind === 'journal-history') {
      if (!Array.isArray(message.entries) || message.entries.length > 10)
        return;
      for (const entry of message.entries)
        this.journal.store.receive(entry, entry?.actor);
      this.journal.persist();
      this.journal.draw(true);
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
      this.instructor.control(
        `${schema.label}: ${this.formatControl(message.name, value)}`,
        this.actorLabel(peerId),
      );
      this.record(
        `${schema.label}: ${this.formatControl(message.name, value)}`,
        peerId,
      );
    } else if (message.kind === 'action') {
      if (!this.applyAction(message.action)) return;
      this.record(this.actionLabel(message.action), peerId);
      this.instructor.control(
        this.actionLabel(message.action),
        this.actorLabel(peerId),
      );
    } else return;
    this.syncDialog();
    this.drawStatus(true);
  }

  teamLeader() {
    const candidates = [
      ...(this.network?.id ? [this.network.id] : []),
      ...[...(this.network?.remotes || [])]
        .filter(([, remote]) => isReactorMap(remote.state?.map))
        .map(([id]) => id),
    ];
    return candidates.length ? Math.min(...candidates) : 0;
  }

  teamSize() {
    if (!this.active) return 0;
    return (
      1 +
      [...(this.network?.remotes || [])].filter(([, remote]) =>
        isReactorMap(remote.state?.map),
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
    if (action === 'acknowledge') return 'квитирование сигналов';
    if (action === 'lamp-test') return 'проверка ламп';
    if (action === 'scram') return 'АЗ-5';
    if (action === 'clear') return 'снятие останова';
    return 'возврат к исходному режиму';
  }

  bindUI() {
    const { hints, exit, dialog, close, fields, actions } = this.elements;
    hints.onclick = () => this.setHints(!this.hints);
    exit.onclick = () => this.leave();
    close.onclick = () => dialog.close();
    this.journalButton = document.createElement('button');
    this.journalButton.id = 'reactor-journal';
    this.journalButton.textContent = 'Журнал · печатная машинка';
    this.journalButton.hidden = true;
    this.journalButton.onclick = () => this.focusJournal();
    hints.after(this.journalButton);
    fields.addEventListener('input', (event) => {
      const input = event.target.closest('[data-rbmk-control]');
      if (!input) return;
      const name = input.dataset.rbmkControl;
      this.commitControl(
        name,
        input.type === 'checkbox'
          ? input.checked
          : input.type === 'range'
            ? Number(input.value)
            : input.value,
      );
    });
    actions.addEventListener('click', (event) => {
      const action =
        event.target.closest('[data-rbmk-action]')?.dataset.rbmkAction;
      this.commitAction(action);
    });
    this.canvas.addEventListener('pointermove', (event) => {
      if (!this.active || event.target !== this.canvas) return;
      this.pointerOverCanvas = true;
      const mesh = this.updateHover();
      const part = mesh?.metadata?.rbmkPart;
      if (this.hints && part) this.openPart(part);
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.pointerOverCanvas = false;
      this.updateHover();
    });
    // Camera motion (including walking/gamepad look) need not emit pointermove.
    // Refresh after the camera update so highlight and activation use one ray.
    this.scene.onBeforeRenderObservable.add(() => this.updateHover());
    this.canvas.addEventListener(
      'click',
      (event) => {
        if (!this.active || this.player.xr || event.button !== 0) return;
        const hit = this.pickInteraction(undefined, event);
        const mesh = hit?.pickedMesh;
        if (
          mesh?.metadata?.rbmkInstructor ||
          mesh?.metadata?.physicalSystem ||
          mesh?.metadata?.rbmkControl ||
          mesh?.metadata?.rbmkAction ||
          mesh?.metadata?.rbmkJournal
        ) {
          this.activatePhysical(mesh);
          event.stopImmediatePropagation();
          return;
        }
        const part = mesh?.metadata?.rbmkPart;
        if (this.hints && part) {
          event.stopImmediatePropagation();
          this.openPart(part);
        }
      },
      true,
    );
    // DOM click owns mouse/touch activation; selectXR owns XR activation.
    // Babylon POINTERPICK uses cursor coordinates even under pointer lock and
    // fires before click, so subscribing here would select a second/wrong key.
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
    this.physicalConsole.setHints(this.hints);
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
    if (this.network?.auth?.token) {
      this.prepareServer();
      if (this.network.id)
        this.server.connect(
          this.network.id,
          this.network.reactorProtocol,
          this.network.userId,
        );
    } else if (this.server.required) {
      this.server.required = false;
      this.server.pending.clear();
      this.model.reset();
      this.journal.store = this.localJournal || new RbmkJournal();
      this.localJournal = null;
      this.journal.storageKey = null;
    }
    this.physicalView = false;
    this.cooldown = 1.5;
    this.root.setEnabled(true);
    this.roomLight.setEnabled(true);
    this.portalRoot.setEnabled(false);
    this.planet.setVisible(false);
    this.player.roomColliders = this.colliders;
    this.player.setMap(REACTOR_MAP, [0, 0, 4.4]);
    this.player.forward.set(0, 0, -1);
    this.elements.hints.hidden = false;
    this.journalButton.hidden = false;
    this.elements.exit.hidden = false;
    this.elements.telemetry.hidden = false;
    if (this.elements.team) this.elements.team.hidden = false;
    document.body.classList.add('in-reactor');
    this.record('вход через портал');
    this.instructor.enter();
    this.share('state-request');
    this.syncTeamPanel();
    this.drawStatus(true);
  }

  leave() {
    if (!this.active) return;
    this.instructor.leave();
    this.setHints(false);
    this.physicalConsole.setHovered(null);
    this.journal.blur();
    this.server.leave();
    document.body.classList.remove('at-journal');
    for (const line of this.xrRays?.values() || []) line.setEnabled(false);
    this.active = false;
    this.physicalView = false;
    this.physicalRoom?.root.setEnabled(false);
    document.body.classList.remove('in-physical-system');
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
    this.journalButton.hidden = true;
    this.elements.exit.hidden = true;
    this.elements.telemetry.hidden = true;
    if (this.elements.team) this.elements.team.hidden = true;
    document.body.classList.remove('in-reactor');
    this.syncTeamPanel();
  }

  get uiOpen() {
    return (
      this.active &&
      (this.hints || this.elements.dialog.open || this.journal.focused)
    );
  }

  update(dt) {
    this.instructor.update(dt);
    this.workers.update(dt);
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
    if (!this.server.required || this.server.ready) this.model.step(dt);
    this.server.tick(this.model.snapshot());
    this.physicalRoom?.update(dt);
    if (
      Math.hypot(this.player.position.x + 3.5, this.player.position.z - 3.1) >
      3.8
    )
      document.body.classList.remove('at-journal');
    this.journal.store.sample(this.model.snapshot());
    this.journal.draw();
    const now = performance.now();
    if (
      !this.server.required &&
      this.network?.id &&
      this.teamLeader() === this.network.id &&
      now - this.lastSharedState > 1000
    ) {
      this.lastSharedState = now;
      this.share('state', { state: this.model.snapshot() });
    }
    if (
      !this.physicalView &&
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
    if (this.physicalView)
      return `ФИЗИЧЕСКАЯ СИСТЕМА · учебный разрез\nP / L1+R1 / оба grip · в БЩУ\nE / A / триггер · взаимодействовать\nНейтронная мощность ${s.power.toFixed(1)}%\nТепловая ${s.thermalPowerMW.toFixed(0)} МВт\nЭлектрическая ${s.electricalPower.toFixed(0)} МВт\nОстаточное тепло ${s.decayHeatMW.toFixed(1)} МВт\nДавление ${s.pressure.toFixed(2)} МПа\n${s.validity === 'outside-domain' ? 'ВНЕ ОБЛАСТИ МОДЕЛИ · нужен сброс' : s.scrammed ? 'АЗ: ' + s.scramReason : s.scenario.label}`;
    const alarms = s.alarms.length ? s.alarms.join('\n') : 'Сигналов нет';
    return `РБМК · УЧЕБНАЯ МОДЕЛЬ v${s.modelVersion}\nСценарий: ${s.scenario.label}\nНейтронная мощность ${s.power.toFixed(1)} %\nТепловая ${s.thermalPowerMW.toFixed(0)} МВт · эл. ${s.electricalPower.toFixed(0)} МВт\nДавление ${s.pressure.toFixed(2)} МПа\nУровни БС Л/П ${Math.round(s.drumLevelLeft)} / ${Math.round(s.drumLevelRight)} мм\nРасходы физ. Л/П ${s.flowLeft.toFixed(0)} / ${s.flowRight.toFixed(0)} %\nПоказания Л/П ${s.measuredFlowLeft.toFixed(0)} / ${s.measuredFlowRight.toFixed(0)} %\nОЗР ${s.orm.toFixed(1)} ст. · ρ ${s.reactivity.toFixed(2)} βэф\nПаросодержание ${(s.voidFraction * 100).toFixed(1)} % · запас ${s.coolantInventory.toFixed(1)} %\nT теплоносителя/топлива ${s.coolantTemperature.toFixed(1)} / ${s.fuelTemperature.toFixed(0)} °C\n${alarms}`;
  }

  drawStatus(force = false) {
    this.physicalConsole?.sync(force);
  }
}
