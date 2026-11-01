export const SHIFT_INTERVAL_MS = 10 * 60 * 1000;

// Wall-clock buckets keep participants on the same ten-minute boundaries.
// Never replay missed shifts after mute, navigation, sleep or a clock rollback.
export class ShiftSchedule {
  constructor(now = Date.now()) {
    this.bucket = Math.floor(now / SHIFT_INTERVAL_MS);
    this.enabled = false;
  }

  poll(now, enabled) {
    const bucket = Math.floor(now / SHIFT_INTERVAL_MS);
    const due =
      bucket > this.bucket &&
      now % SHIFT_INTERVAL_MS < 5000 &&
      this.enabled &&
      enabled;
    this.bucket = Math.max(this.bucket, bucket);
    this.enabled = enabled;
    return due;
  }
}

const pad = (value) => String(value).padStart(2, '0');
export function clockFace(now) {
  const date = new Date(now);
  const offset = -date.getTimezoneOffset();
  const remaining = Math.ceil(
    (SHIFT_INTERVAL_MS - (now % SHIFT_INTERVAL_MS)) / 1000,
  );
  return {
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    date: `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`,
    zone: `UTC${offset < 0 ? '−' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`,
    next: `${pad(Math.floor(remaining / 60))}:${pad(remaining % 60)}`,
  };
}

export class ShiftClock {
  constructor(room, sound) {
    this.room = room;
    this.sound = sound;
    this.schedule = new ShiftSchedule();
    this.faces = new Map();
    this.addFace(room.root, [-11.85, 4.3, 0], Math.PI / 2);
    room.scene.onDisposeObservable.addOnce(() => this.dispose());
  }

  addFace(root, position, rotation = 0) {
    const B = window.BABYLON;
    const name = 'Real time shift clock ' + root.name;
    const mesh = B.MeshBuilder.CreatePlane(
      name,
      { width: 3.4, height: 1.2 },
      this.room.scene,
    );
    mesh.parent = root;
    mesh.position.set(...position);
    mesh.rotation.y = rotation;
    mesh.isPickable = false;
    const texture = new B.DynamicTexture(
      name,
      { width: 1024, height: 360 },
      this.room.scene,
      false,
    );
    const material = new B.StandardMaterial(name, this.room.scene);
    material.diffuseTexture = texture;
    material.emissiveColor = B.Color3.White();
    material.disableLighting = true;
    material.backFaceCulling = false;
    mesh.material = material;
    this.faces.set(root, { mesh, texture, last: '' });
  }

  prepareAudio() {
    if (this.buffer || !this.sound.context || this.disposed) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const response = await fetch(
          new URL('../assets/new-shift.wav', import.meta.url),
        );
        if (!response.ok) throw Error('Запись новой смены недоступна');
        const buffer = await this.sound.context.decodeAudioData(
          await response.arrayBuffer(),
        );
        if (!this.disposed) this.buffer = buffer;
        this.audioError = '';
      } catch (error) {
        this.audioError = error.message;
        console.warn('Shift announcement:', error.message);
      }
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  update(now = Date.now(), visible = true) {
    if (this.disposed) return;
    const audible =
      this.room.active &&
      visible &&
      !this.sound.muted &&
      this.sound.context?.state === 'running';
    if (!audible) this.stopAudio();
    if (this.schedule.poll(now, audible && !!this.buffer)) {
      this.stopAudio();
      const source = this.sound.context.createBufferSource();
      source.buffer = this.buffer;
      source.connect(this.sound.master);
      source.onended = () => {
        source.disconnect();
        if (this.source === source) this.source = null;
      };
      source.start();
      this.source = source;
    }
    if (!this.room.active) return;
    const physicalRoot = this.room.physicalRoom?.root;
    if (physicalRoot && !this.faces.has(physicalRoot))
      this.addFace(physicalRoot, [-11.85, 4.3, 7], Math.PI / 2);
    const face = clockFace(now);
    const text = `${face.date} ${face.time} ${face.zone} ${face.next}`;
    for (const [root, entry] of this.faces) {
      if (!root.isEnabled() || entry.last === text) continue;
      entry.last = text;
      const ctx = entry.texture.getContext();
      ctx.fillStyle = '#101e22';
      ctx.fillRect(0, 0, 1024, 360);
      ctx.strokeStyle = '#83978a';
      ctx.lineWidth = 8;
      ctx.strokeRect(4, 4, 1016, 352);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#c4d6c8';
      ctx.font = '28px sans-serif';
      ctx.fillText(`РЕАЛЬНОЕ ВРЕМЯ · ${face.zone}`, 512, 46);
      ctx.fillStyle = '#bef4c6';
      ctx.font = '116px monospace';
      ctx.fillText(face.time, 512, 145);
      ctx.fillStyle = '#c4d6c8';
      ctx.font = '32px sans-serif';
      ctx.fillText(`Новая смена через ${face.next}`, 512, 246);
      ctx.font = '26px sans-serif';
      ctx.fillText(face.date, 512, 310);
      entry.texture.update();
    }
  }

  stopAudio() {
    if (!this.source) return;
    this.source.stop();
    this.source.disconnect();
    this.source = null;
  }

  dispose() {
    this.disposed = true;
    this.stopAudio();
    this.buffer = null;
    for (const { mesh } of this.faces.values()) mesh.dispose(false, true);
    this.faces.clear();
  }
}
