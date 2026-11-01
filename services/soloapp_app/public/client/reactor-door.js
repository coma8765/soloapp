import { DoorSync, doorThreshold } from './door-sync.js';
import { REACTOR_MAP } from '../shared/room.js';

export class ReactorDoor {
  constructor(room, B) {
    Object.assign(this, { room, B });
    this.views = [];
    this.amount = 0;
    this.sync = new DoorSync({
      send: (message) => {
        const network = room.network;
        // The server validates the side using the latest authenticated player pose.
        network?.send(room.player.state(++network.sequence));
        return network?.send(message);
      },
      passed: (destination, side) => {
        if (room.player.worldMap !== side) return;
        if (destination === REACTOR_MAP) room.enter();
        else room.leave();
      },
    });
    this.hint = document.createElement('div');
    this.hint.id = 'reactor-door-status';
    this.hint.setAttribute('role', 'status');
    this.hint.hidden = true;
    Object.assign(this.hint.style, {
      position: 'fixed',
      bottom: '90px',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '10px 16px',
      background: '#102526e8',
      color: '#fff',
      borderRadius: '8px',
      pointerEvents: 'none',
      zIndex: '8',
      textAlign: 'center',
    });
    document.body.append(this.hint);
  }

  build(parent, exit) {
    const { room, B } = this;
    const steel = room.material('Door steel', '#667b80');
    const leaf = room.material('Door leaves', '#c9d1cb');
    const accent = room.material('Door stripe', '#c2a04a');
    for (const x of [-1.24, 1.24])
      room.box('Door jamb', [0.28, 3.15, 0.4], [x, 1.575, 0], steel, parent);
    room.box('Door header', [2.76, 0.3, 0.4], [0, 3.1, 0], steel, parent);
    room.box('Door sill', [2.76, 0.06, 0.6], [0, 0.03, 0], steel, parent);
    const leaves = [-1, 1].map((side) => {
      const node = new B.TransformNode('Sliding door leaf', room.scene);
      node.parent = parent;
      node.position.x = side * 0.55;
      room.box('Solid door panel', [1.09, 2.88, 0.14], [0, 1.5, 0], leaf, node);
      room.box(
        'Door safety stripe',
        [1.09, 0.13, 0.16],
        [0, 1.02, 0],
        accent,
        node,
      );
      room.box('Door window', [0.65, 0.55, 0.17], [0, 2.13, 0], steel, node);
      return { side, node };
    });
    const texture = new B.DynamicTexture(
      'Door sign',
      { width: 1024, height: 256 },
      room.scene,
      false,
    );
    const signMaterial = room.material('Door sign material', '#ffffff', true);
    signMaterial.diffuseTexture = texture;
    signMaterial.emissiveTexture = texture;
    signMaterial.backFaceCulling = false;
    const sign = B.MeshBuilder.CreatePlane(
      'Door destination',
      { width: 2.6, height: 0.65 },
      room.scene,
    );
    sign.parent = parent;
    sign.position.set(0, 3.65, 0);
    sign.material = signMaterial;
    sign.isPickable = false;
    const view = { parent, exit, leaves, texture };
    this.views.push(view);
    this.draw(view);
  }

  draw(view) {
    const ctx = view.texture.getContext();
    ctx.fillStyle = '#142f32';
    ctx.fillRect(0, 0, 1024, 256);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 52px sans-serif';
    ctx.fillText(view.exit ? 'НА ПЛАНЕТУ' : 'БЩУ · ВВЭР-1200', 512, 85);
    ctx.font = '30px sans-serif';
    ctx.fillStyle = '#cfe6c9';
    ctx.fillText(this.sync.status(), 512, 163);
    ctx.font = '24px sans-serif';
    ctx.fillText('Автоматическая дверь', 512, 216);
    view.texture.update();
  }

  view() {
    if (this.room.player.worldMap === REACTOR_MAP)
      return this.views.find((v) => v.exit);
    if (this.room.player.worldMap === 'planet' && this.room.planet.visible)
      return this.views.find((v) => !v.exit);
    return null;
  }

  local(view, position) {
    return this.B.Vector3.TransformCoordinates(
      position,
      this.B.Matrix.Invert(view.parent.computeWorldMatrix(true)),
    );
  }

  resolve(next, before) {
    const view = this.view();
    if (!view) return next;
    const from = this.local(view, before),
      to = this.local(view, next);
    const threshold = doorThreshold(from.asArray(), to.asArray());
    if (!threshold) return next;
    // Stay on the source side until the server commits the passage.
    // The request is sent in update(), outside Player.update() to avoid reentrant teleportation.
    if (
      threshold.aperture &&
      this.sync.open &&
      this.amount >= 0.95 &&
      this.room.cooldown === 0
    )
      this.wantPass = this.room.player.worldMap;
    return this.B.Vector3.TransformCoordinates(
      this.B.Vector3.FromArray(threshold.position),
      view.parent.getWorldMatrix(),
    );
  }

  update(dt) {
    this.sync.requireServer(!!this.room.network?.auth?.token);
    this.sync.tick();
    const target = this.sync.open ? 1 : 0;
    this.amount +=
      Math.sign(target - this.amount) *
      Math.min(Math.abs(target - this.amount), dt / 0.5);
    for (const view of this.views)
      for (const { node, side } of view.leaves)
        node.position.x = side * (0.55 + this.amount * 1.13);
    const status = this.sync.status();
    if (status !== this.lastStatus) {
      for (const view of this.views) this.draw(view);
      this.lastStatus = status;
      this.hint.textContent = status;
    }
    const view = this.view();
    const p = view && this.local(view, this.room.player.position);
    const near =
      !!p &&
      Math.abs(p.x) < 1.5 &&
      Math.abs(p.z) < 2.5 &&
      p.y > -0.8 &&
      p.y < 3.1;
    this.hint.hidden = !near;
    if (this.wantPass) {
      if (
        near &&
        this.wantPass === this.room.player.worldMap &&
        this.room.cooldown === 0
      )
        this.sync.request('pass', this.wantPass);
      this.wantPass = null;
    } else if (near && this.room.cooldown === 0 && !this.sync.open)
      this.sync.request('open', this.room.player.worldMap);
  }
}
