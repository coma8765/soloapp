import { AVATARS, findAvatar } from './avatar-catalog.js';
const B = window.BABYLON;
const $ = (id) => document.getElementById(id);
const WIDTH = 1024,
  HEIGHT = 1120;

// A single world-space surface for mouse, physical keyboard and XR target rays.
// Native inputs remain the accessible source of truth and support paste/autofill.
export class AccountPanel {
  constructor(scene, auth, player, canvas, walk, preferences) {
    Object.assign(this, { scene, auth, player, canvas, walk, preferences });
    this.mode = 'auth';
    this.settingsBusy = false;
    this.field = 'email';
    this.shift = false;
    this.symbols = false;
    this.hover = '';
    this.targets = [];
    this.rays = new Map();
    this.mesh = B.MeshBuilder.CreatePlane(
      'account-panel',
      { width: 1.25, height: (1.25 * HEIGHT) / WIDTH },
      scene,
    );
    this.mesh.rotationQuaternion = B.Quaternion.Identity();
    this.mesh.renderingGroupId = 3;
    this.texture = new B.DynamicTexture(
      'account-panel-texture',
      { width: WIDTH * 2, height: HEIGHT * 2 },
      scene,
      true,
    );
    this.texture.hasAlpha = true;
    this.texture.anisotropicFilteringLevel = 8;
    const material = new B.StandardMaterial('account-panel-material', scene);
    material.diffuseTexture = this.texture;
    material.emissiveColor = B.Color3.White();
    material.disableLighting = true;
    material.backFaceCulling = false;
    material.useAlphaFromDiffuseTexture = true;
    this.mesh.material = material;
    this.mesh.setEnabled(false);
    this.createSettingsGear();
    const choices = $('avatar-options');
    for (const avatar of AVATARS) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'avatar';
      input.value = avatar.id;
      input.addEventListener('change', () => this.chooseAvatar(avatar.id));
      label.append(
        input,
        document.createTextNode(`${avatar.name} · ${avatar.description}`),
      );
      choices.append(label);
    }
    $('settings-form').onsubmit = (event) => {
      event.preventDefault();
      void this.applySettings();
    };
    $('settings-close').onclick = () => this.closeSettings();
    $('settings-dialog').addEventListener('cancel', (event) => {
      event.preventDefault();
      this.closeSettings();
    });
    $('settings-dialog').addEventListener('close', () => {
      if (!this.settingsOpen) this.player.inputEnabled = !this.lobby?.countdown;
    });
    window.addEventListener('keydown', (event) => {
      if (event.code === 'Escape' && this.settingsOpen) {
        event.preventDefault();
        this.closeSettings();
      }
    });
    document.body.classList.add('spatial-ui');
    for (const name of ['email', 'password']) {
      $(`auth-${name}`).addEventListener('focus', () => {
        this.field = name;
      });
    }
    canvas.addEventListener('pointermove', (event) => {
      if (this.xr) return;
      this.hover = this.targetAt(this.pickMouse(event))?.id || '';
      canvas.style.cursor = this.hover ? 'pointer' : '';
    });
    // Babylon can suppress synthetic mouse clicks after touch in WebKit.
    // Activate a tap on pointerup and suppress any follow-up compatibility click.
    canvas.addEventListener(
      'pointerdown',
      (event) => {
        if (this.xr || event.pointerType === 'mouse') return;
        const target = this.targetAt(this.pickMouse(event));
        if (target)
          this.touchTarget = {
            pointer: event.pointerId,
            id: target.id,
            x: event.clientX,
            y: event.clientY,
          };
      },
      true,
    );
    canvas.addEventListener(
      'pointerup',
      (event) => {
        const tap = this.touchTarget;
        if (!tap || tap.pointer !== event.pointerId) return;
        this.touchTarget = null;
        const target = this.targetAt(this.pickMouse(event));
        if (
          target?.id !== tap.id ||
          Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 12
        )
          return;
        this.touchClickUntil = performance.now() + 700;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.activate(target);
      },
      true,
    );
    canvas.addEventListener('pointercancel', () => {
      this.touchTarget = null;
    });
    canvas.addEventListener(
      'click',
      (event) => {
        if (performance.now() < (this.touchClickUntil || 0)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        const hit = this.pickMouse(event);
        if (!hit) return;
        event.stopImmediatePropagation();
        this.activate(this.targetAt(hit));
      },
      true,
    );
    window.addEventListener('resize', () => {
      if (this.visible && !this.xr) this.present();
    });
    this.auth.onSignIn = ({ registered }) => {
      if (registered || !this.preferences.saved) this.openSettings(true);
    };
    if (this.auth.token && !this.preferences.saved) this.openSettings(true);
  }

  get visible() {
    return this.mesh.isEnabled();
  }
  get settingsOpen() {
    return $('settings-dialog').open;
  }
  get busy() {
    return this.mode === 'settings' ? this.settingsBusy : this.auth.busy;
  }

  openSettings(onboarding = false) {
    if (this.settingsBusy || this.lobby?.countdown) return;
    this.onboarding = onboarding;
    this.mode = 'settings';
    this.draft = this.player.avatar.id || this.preferences.id;
    $('settings-title').textContent = onboarding
      ? 'Выберите аватар'
      : 'Настройки';
    $('settings-status').textContent = '';
    $('settings-save').textContent = onboarding
      ? 'Выбрать и продолжить'
      : 'Сохранить';
    $('auth-dialog').close();
    if (!this.settingsOpen) $('settings-dialog').show();
    this.chooseAvatar(this.draft);
    document.activeElement?.blur();
    if (!this.xr)
      $('avatar-options')
        .querySelector('input:checked')
        ?.focus({ preventScroll: true });
    this.player.keys.clear();
    this.player.inputEnabled = false;
    document.exitPointerLock?.();
    this.recenter = true;
    this.sync();
  }

  closeSettings() {
    if (this.settingsBusy) return;
    $('settings-dialog').close();
    this.player.inputEnabled = !this.lobby?.countdown;
    this.player.keys.clear();
    document.activeElement?.blur();
    this.sync();
  }

  chooseAvatar(id) {
    if (this.settingsBusy || !findAvatar(id)) return;
    this.draft = id;
    for (const input of $('avatar-options').querySelectorAll('input'))
      input.checked = input.value === id;
    $('settings-status').textContent = '';
    this.lastState = '';
  }

  async applySettings() {
    if (this.settingsBusy || !this.settingsOpen) return;
    this.settingsBusy = true;
    $('settings-save').disabled = $('settings-close').disabled = true;
    $('avatar-options').disabled = true;
    $('settings-status').textContent = 'Загружаем аватар…';
    this.sync();
    try {
      if (!(await this.player.avatar.select(this.draft))) {
        $('settings-status').textContent =
          'Не удалось загрузить аватар. Попробуйте ещё раз.';
        return;
      }
      const saved = this.preferences.save(this.draft);
      $('settings-status').textContent = saved
        ? 'Выбор сохранён.'
        : 'Аватар изменён, но браузер не разрешил сохранить выбор.';
      if (saved) {
        this.settingsBusy = false;
        this.closeSettings();
      }
    } finally {
      this.settingsBusy = false;
      $('settings-save').disabled = $('settings-close').disabled = false;
      $('avatar-options').disabled = false;
      this.sync();
    }
  }

  toggleMenu() {
    if (this.lobby?.countdown) return;
    if (this.lobby) {
      this.toggle();
      this.sync();
      return;
    }
    if (this.settingsOpen) this.closeSettings();
    else if ($('auth-dialog').open) {
      $('auth-dialog').close();
      this.sync();
    } else if (this.auth.token) this.openSettings();
    else {
      this.auth.require();
      this.recenter = true;
      this.sync();
    }
  }

  createSettingsGear() {
    this.gear = B.MeshBuilder.CreatePlane(
      'settings-gear',
      { size: 0.13 },
      this.scene,
    );
    this.gear.renderingGroupId = 3;
    const texture = new B.DynamicTexture(
      'settings-gear-texture',
      { width: 256, height: 256 },
      this.scene,
      true,
    );
    texture.hasAlpha = true;
    const c = texture.getContext();
    c.fillStyle = '#173b43';
    c.beginPath();
    c.roundRect(3, 3, 250, 250, 45);
    c.fill();
    c.fillStyle = '#eaf6f6';
    c.font = '180px sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('⚙', 128, 130);
    texture.update();
    const material = new B.StandardMaterial(
      'settings-gear-material',
      this.scene,
    );
    material.diffuseTexture = texture;
    material.emissiveColor = B.Color3.White();
    material.disableLighting = true;
    material.backFaceCulling = false;
    this.gear.material = material;
    this.gear.setEnabled(false);
    this.gearTarget = {
      id: 'settings-gear',
      action: () =>
        this.settingsOpen ? this.closeSettings() : this.openSettings(),
    };
  }

  toggle() {
    if (this.lobby?.countdown) return;
    if (this.settingsOpen) {
      this.closeSettings();
      return;
    }
    if (this.auth.token) {
      if (this.lobby.visible) this.lobby.visible = false;
      else this.lobby.show();
    } else if ($('auth-dialog').open) $('auth-dialog').close();
    else this.auth.require();
    this.recenter = true;
  }

  present() {
    const camera = this.scene.activeCamera;
    camera.computeWorldMatrix(true);
    const world = camera.getWorldMatrix();
    let distance = 1.8;
    if (!this.xr) {
      const aspect = this.scene.getEngine().getAspectRatio(camera);
      distance = Math.max(
        1.2,
        0.83 / Math.tan(camera.fov / 2),
        0.76 / (Math.tan(camera.fov / 2) * aspect),
      );
    }
    this.mesh.position.copyFrom(
      B.Vector3.TransformCoordinates(new B.Vector3(0, 0, -distance), world),
    );
    world.decompose(undefined, this.mesh.rotationQuaternion);
    this.mesh.computeWorldMatrix(true);
  }

  sync() {
    const countdown = !!this.lobby?.countdown;
    if (countdown !== this.countdown) {
      this.countdown = countdown;
      this.recenter = true;
      this.controllerFocus = '';
    }
    document.body.classList.toggle('settings-open', this.settingsOpen);
    this.gear.setEnabled(!!this.xr && !countdown);
    if (this.xr) {
      this.gear.parent = this.scene.activeCamera;
      this.gear.position.set(-0.42, -0.25, -1);
    }
    const mode = countdown
      ? 'countdown'
      : this.settingsOpen
        ? 'settings'
        : this.auth.token && this.lobby
          ? 'lobby'
          : 'auth';
    if (mode !== this.mode) {
      this.mode = mode;
      this.lastState = '';
      this.recenter = true;
      this.controllerFocus = '';
    }
    const visible =
      countdown ||
      this.settingsOpen ||
      (this.auth.token ? !!this.lobby?.visible : $('auth-dialog').open);
    if (visible !== this.visible) {
      this.mesh.setEnabled(visible);
      if (visible) this.present();
      else {
        this.hover = '';
        this.controllerFocus = '';
        this.lastState = '';
        this.canvas.style.cursor = '';
        this.hideRays();
      }
    }
    if (!visible) return;
    if (this.recenter) {
      this.present();
      this.recenter = false;
    }
    const state = JSON.stringify([
      this.mode,
      this.draft,
      this.onboarding,
      this.settingsBusy,
      $('settings-status').textContent,
      this.field,
      this.shift,
      this.symbols,
      this.hover,
      this.controllerFocus,
      this.controllerActive,
      this.auth.busy,
      this.auth.registration,
      $('auth-email').value,
      $('auth-password').value,
      $('auth-error').textContent,
      !!this.auth.token,
      this.page,
      this.lobby?.servers,
      this.lobby?.current,
      this.lobby?.busy,
      this.lobby?.error,
      this.lobby?.userId,
      countdown ? this.lobby.secondsLeft : null,
    ]);
    if (state !== this.lastState) {
      this.lastState = state;
      this.draw();
    }
  }

  draw() {
    const c = this.texture.getContext();
    c.setTransform(2, 0, 0, 2, 0, 0);
    c.clearRect(0, 0, WIDTH, HEIGHT);
    this.targets = [];
    const box = (x, y, w, h, fill, stroke = '#537e8d') => {
      c.beginPath();
      c.roundRect(x, y, w, h, 18);
      c.fillStyle = fill;
      c.fill();
      c.strokeStyle = stroke;
      c.lineWidth = 2;
      c.stroke();
    };
    const text = (value, x, y, size = 28, color = '#eaf6f6') => {
      c.font = `${size}px sans-serif`;
      c.fillStyle = color;
      c.textAlign = 'left';
      c.fillText(value, x, y);
    };
    const button = (
      id,
      label,
      x,
      y,
      w,
      h,
      action,
      accent = false,
      labelY = h / 2 + 10,
    ) => {
      this.targets.push({ id, x, y, w, h, action });
      const selected = this.hover === id || this.controllerFocus === id;
      box(
        x,
        y,
        w,
        h,
        selected ? '#447481' : accent ? '#bde5d1' : '#1c3d4d',
        selected ? '#dcfff2' : '#507784',
      );
      if (this.controllerFocus === id) {
        c.lineWidth = 5;
        c.strokeStyle = '#e8ffe5';
        c.stroke();
      }
      c.font = '28px sans-serif';
      c.textAlign = 'center';
      c.fillStyle = accent && !selected ? '#13333b' : '#eaf6f6';
      c.fillText(label, x + w / 2, y + labelY);
    };
    box(3, 3, WIDTH - 6, HEIGHT - 6, '#102c3bee', '#8fbbc6');
    if (this.countdown) {
      text('ПЕРЕХОД В ДРУГОЙ МИР', 48, 100, 32, '#c0e6dc');
      text('Белая комната', 48, 178, 56);
      text(
        'Все участники готовы. Переносим вас вместе.',
        48,
        246,
        29,
        '#adc8d2',
      );
      const value = this.lobby.secondsLeft;
      c.textAlign = 'center';
      c.font = 'bold 280px sans-serif';
      c.fillStyle = '#e8ffe5';
      c.fillText(value || '…', WIDTH / 2, 660);
      text(
        value ? 'До появления в комнате' : 'Ожидаем подтверждения сервера…',
        190,
        784,
        34,
      );
      text(
        'Точка спавна назначена каждому участнику.',
        118,
        966,
        30,
        '#adc8d2',
      );
      this.texture.update();
      return;
    }
    if (this.mode === 'lobby') {
      this.drawLobby(text, button, box);
      this.texture.update();
      return;
    }
    text('MICRO / PLANET', 48, 59, 24, '#c0e6dc');
    if (this.mode === 'settings') {
      this.drawSettings({ text, button });
      this.texture.update();
      return;
    }
    text('ЛОКАЛЬНАЯ ПРОГУЛКА', 642, 59, 21, '#a8c4cf');
    text(
      this.auth.registration ? 'Присоединиться к миру' : 'С возвращением',
      48,
      118,
      44,
    );
    text(
      'Планета уже здесь. Войдите, чтобы встретить других.',
      48,
      165,
      27,
      '#adc8d2',
    );
    for (const [name, label, y] of [
      ['email', 'Почта', 226],
      ['password', 'Пароль · от 12 символов', 334],
    ]) {
      text(label, 48, y - 14, 25, '#adc8d2');
      const input = $(`auth-${name}`);
      const active = this.field === name || this.controllerFocus === name;
      box(
        48,
        y,
        928,
        70,
        active ? '#244758' : '#183544',
        active ? '#a4ead9' : '#4a6e7b',
      );
      if (this.controllerFocus === name) {
        c.lineWidth = 5;
        c.strokeStyle = '#e8ffe5';
        c.stroke();
      }
      let value =
        name === 'password'
          ? '•'.repeat(Array.from(input.value).length)
          : input.value;
      if (value.length > 44) value = '…' + value.slice(-43);
      text(
        value || (name === 'email' ? 'you@example.com' : 'Ваш пароль'),
        70,
        y + 46,
        32,
        value ? '#f0fbf9' : '#8ba9b6',
      );
      this.targets.push({
        id: name,
        x: 48,
        y,
        w: 928,
        h: 70,
        action: () => {
          this.field = name;
          if (!this.xr) input.focus({ preventScroll: true });
        },
      });
    }
    const error = $('auth-error').textContent;
    text(error.slice(0, 70), 48, 435, 23, '#ffd1b8');
    text(error.slice(70, 140), 48, 462, 23, '#ffd1b8');
    button(
      'submit',
      this.auth.busy
        ? 'Подключаемся…'
        : this.auth.registration
          ? 'Создать аккаунт и войти'
          : 'Войти',
      48,
      480,
      928,
      62,
      () => {
        void this.auth.submit();
      },
      true,
    );
    button(
      'switch',
      this.auth.registration
        ? 'Уже есть аккаунт? Войти'
        : 'Создать новый аккаунт',
      48,
      554,
      928,
      48,
      () => $('auth-switch').click(),
    );
    const rows = this.symbols
      ? ['!@#$%^&*()', '[]{}<>/\\|~', '`_+-=;:\'"', ',.?€£¥₽№']
      : ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm@.'];
    rows.forEach((row, index) => {
      const chars = Array.from(
        this.shift && !this.symbols ? row.toUpperCase() : row,
      );
      const w = 82,
        gap = 10,
        x = (WIDTH - chars.length * (w + gap) + gap) / 2;
      chars.forEach((key, i) =>
        button(
          'key-' + index + '-' + i,
          key,
          x + i * (w + gap),
          624 + index * 68,
          w,
          58,
          () => this.write(key),
        ),
      );
    });
    button('shift', this.shift ? 'ABC ↑' : 'abc ↑', 48, 902, 170, 60, () => {
      this.shift = !this.shift;
    });
    button('symbols', this.symbols ? 'abc' : '#+=', 230, 902, 152, 60, () => {
      this.symbols = !this.symbols;
    });
    button('space', 'Пробел', 394, 902, 210, 60, () => this.write(' '));
    button('backspace', '⌫', 616, 902, 170, 60, () => this.write(null));
    button('next', 'Далее', 798, 902, 178, 60, () => {
      this.field = this.field === 'email' ? 'password' : 'email';
    });
    button('walk', 'Продолжить прогулку  ↗', 48, 992, 928, 66, () => {
      $('auth-dialog').close();
      document.activeElement?.blur();
      this.sync();
      this.walk();
    });
    text(
      this.controllerActive
        ? '✕ — выбрать · ○ — назад · L1 / R1 — соседний элемент'
        : this.xr
          ? 'Луч + триггер · B — открыть / убрать панель'
          : 'Мышь / клавиатура · Esc — вернуться после прогулки',
      48,
      1094,
      24,
      '#adc8d2',
    );
    this.texture.update();
  }

  drawSettings({ text, button }) {
    text(this.onboarding ? 'Выберите аватар' : 'Настройки', 48, 135, 48);
    text('Ваш образ в мире', 48, 195, 30, '#adc8d2');
    text('Выбор сохранится в этом браузере.', 48, 240, 26, '#adc8d2');
    const rowStep = Math.min(135, 420 / AVATARS.length);
    AVATARS.forEach((avatar, index) => {
      const y = 285 + index * rowStep,
        selected = avatar.id === this.draft;
      button(
        'avatar-' + avatar.id,
        `${selected ? '●' : '○'}  ${avatar.name}`,
        48,
        y,
        928,
        rowStep - 12,
        () => this.chooseAvatar(avatar.id),
        selected,
        36,
      );
      text(
        avatar.description,
        88,
        y + rowStep - 30,
        24,
        selected ? '#254e4d' : '#adc8d2',
      );
    });
    const message = $('settings-status').textContent;
    text(message.slice(0, 60), 48, 735, 25, '#ffd1b8');
    text(message.slice(60), 48, 772, 25, '#ffd1b8');
    button(
      'settings-save',
      this.settingsBusy ? 'Загружаем…' : $('settings-save').textContent,
      48,
      830,
      928,
      72,
      () => {
        void this.applySettings();
      },
      true,
    );
    button('settings-close', 'Закрыть', 48, 926, 928, 64, () =>
      this.closeSettings(),
    );
    text(
      this.controllerActive
        ? '✕ — выбрать · ○ — закрыть · L1 / R1 — выбор'
        : this.xr
          ? 'Луч + триггер · B — закрыть'
          : 'Мышь / клавиатура · Esc — закрыть',
      48,
      1080,
      24,
      '#adc8d2',
    );
  }

  write(key) {
    if (this.auth.busy) return;
    const input = $(`auth-${this.field}`);
    const value = Array.from(input.value);
    if (key === null) value.pop();
    else value.push(key);
    input.value = value.join('').slice(0, input.maxLength);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (!this.xr) input.focus({ preventScroll: true });
  }

  activate(target) {
    if (
      !target ||
      this.countdown ||
      this.busy ||
      (this.mode === 'lobby' && this.lobby?.busy)
    )
      return;
    target.action();
    this.sync();
  }

  drawLobby(text, button) {
    text('MICRO / PLANET', 48, 59, 24, '#c0e6dc');
    text('Один общий мир', 48, 150, 48);
    text('Все участники YC и home встречаются на этой планете.', 48, 230, 26);
    button('settings', 'Настройки и аватар', 48, 350, 928, 72, () =>
      this.openSettings(),
    );
    button('reconnect', 'Переподключиться', 48, 460, 928, 72, () =>
      this.lobby.reconnect(),
    );
    button('logout', 'Выйти из аккаунта', 48, 570, 928, 72, () =>
      $('logout').click(),
    );
    button(
      'walk',
      'Продолжить прогулку ↗',
      48,
      900,
      928,
      72,
      () => {
        this.lobby.visible = false;
        this.sync();
        this.walk();
      },
      true,
    );
  }

  targetAt(pick) {
    if (!pick?.hit) return null;
    if (pick.pickedMesh === this.gear)
      return this.gear.isEnabled() ? this.gearTarget : null;
    if (pick.pickedMesh !== this.mesh || !this.visible) return null;
    const uv = pick?.getTextureCoordinates();
    if (!uv) return null;
    const x = uv.x * WIDTH,
      y = (1 - uv.y) * HEIGHT;
    return this.targets.find(
      (t) => x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h,
    );
  }

  pickMouse(event) {
    if (!this.visible || this.xr) return null;
    const rect = this.canvas.getBoundingClientRect();
    const hit = this.scene.pick(
      event.clientX - rect.left,
      event.clientY - rect.top,
      (mesh) => mesh === this.mesh,
    );
    return hit?.hit ? hit : null;
  }

  xrRay(frame, source, referenceSpace, origin) {
    const pose = frame.getPose(source.targetRaySpace, referenceSpace);
    if (!pose) return null;
    const { position: p, orientation: q } = pose.transform;
    const rotation = new B.Quaternion(q.x, q.y, q.z, q.w);
    const direction = new B.Vector3(0, 0, -1).rotateByQuaternionToRef(
      rotation,
      B.Vector3.Zero(),
    );
    const world = origin.computeWorldMatrix(true);
    return new B.Ray(
      B.Vector3.TransformCoordinates(new B.Vector3(p.x, p.y, p.z), world),
      B.Vector3.TransformNormal(direction, world).normalize(),
      5,
    );
  }

  isInteractiveMesh(mesh) {
    return (
      (mesh === this.mesh && this.visible) ||
      (mesh === this.gear && this.gear.isEnabled())
    );
  }

  updateXR(frame, referenceSpace, origin) {
    if (!this.xr || (!this.visible && !this.gear.isEnabled())) {
      this.hideRays();
      return;
    }
    this.hover = '';
    for (const visual of this.rays.values()) visual.setEnabled(false);
    for (const source of frame.session.inputSources) {
      const ray = this.xrRay(frame, source, referenceSpace, origin);
      if (!ray) continue;
      const pick = this.scene.pickWithRay(ray, (mesh) =>
        this.isInteractiveMesh(mesh),
      );
      const target = this.targetAt(pick);
      if (target) this.hover = target.id;
      const points = [
        ray.origin,
        pick?.hit ? pick.pickedPoint : ray.origin.add(ray.direction.scale(2)),
      ];
      let line = this.rays.get(source);
      if (!line) {
        line = B.MeshBuilder.CreateLines(
          'account-controller-ray',
          { points, updatable: true },
          this.scene,
        );
        line.isPickable = false;
        line.renderingGroupId = 3;
        this.rays.set(source, line);
      } else
        B.MeshBuilder.CreateLines(
          'account-controller-ray',
          { points, instance: line },
          this.scene,
        );
      line.color = target
        ? new B.Color3(0.7, 1, 0.83)
        : new B.Color3(0.4, 0.65, 0.75);
      line.setEnabled(true);
    }
    for (const [source, line] of this.rays)
      if (![...frame.session.inputSources].includes(source)) {
        line.dispose();
        this.rays.delete(source);
      }
  }

  selectXR(event, referenceSpace, origin) {
    if (!this.visible && !this.gear.isEnabled()) return;
    const ray = this.xrRay(
      event.frame,
      event.inputSource,
      referenceSpace,
      origin,
    );
    if (ray)
      this.activate(
        this.targetAt(
          this.scene.pickWithRay(ray, (mesh) => this.isInteractiveMesh(mesh)),
        ),
      );
  }

  hideRays() {
    for (const line of this.rays.values()) line.setEnabled(false);
  }
}
