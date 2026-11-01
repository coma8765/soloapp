import { RBMK_CONTROLS } from './rbmk-data.js';

const B = window.BABYLON;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function controlLabel(control) {
  const schema = RBMK_CONTROLS[control.name];
  if (control.mode === 'toggle') return `${schema.label} · переключатель`;
  if (schema.type === 'select')
    return `${schema.label} · ${control.delta > 0 ? 'следующий' : 'предыдущий'}`;
  return `${schema.label} · ${control.delta > 0 ? '+' : '−'}${Math.abs(
    control.delta,
  )}`;
}

function targetLabel(mesh) {
  if (mesh.metadata.rbmkControl) return controlLabel(mesh.metadata.rbmkControl);
  if (mesh.metadata.rbmkAction === 'scram') return 'АЗ-5';
  if (mesh.metadata.rbmkAction === 'clear') return 'Снять АЗ';
  return 'Исходный режим';
}

function expectedControl(before, control) {
  const schema = RBMK_CONTROLS[control.name];
  const current = before.controls[control.name];
  if (control.mode === 'toggle') return !current;
  if (schema.type === 'select') {
    const options = Object.keys(schema.options);
    const index = options.indexOf(current);
    return options[(index + control.delta + options.length) % options.length];
  }
  const value = clamp(current + control.delta, schema.min, schema.max);
  return Math.round(value / schema.step) * schema.step;
}

function sameControls(left, right) {
  return Object.keys(RBMK_CONTROLS).every(
    (name) => left?.[name] === right?.[name],
  );
}

class RbmkPhysicalAudit {
  constructor(app) {
    this.app = app;
    this.reactor = app.reactor;
    this.console = app.reactor.physicalConsole;
    this.targets = [...this.console.buttons];
    this.index = 0;
    this.results = [];
    this.waitTimer = 0;
    this.overlay = this.buildOverlay();
  }

  buildOverlay() {
    const overlay = document.createElement('section');
    overlay.id = 'rbmk-physical-audit';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    Object.assign(overlay.style, {
      position: 'fixed',
      zIndex: '2000',
      top: '12px',
      right: '12px',
      width: 'min(360px, 38vw)',
      maxHeight: '42vh',
      overflow: 'auto',
      padding: '12px',
      border: '1px solid #68d5db',
      borderRadius: '8px',
      background: 'rgba(5, 18, 20, 0.92)',
      color: '#efffdc',
      font: '12px/1.35 monospace',
      pointerEvents: 'none',
      whiteSpace: 'pre-wrap',
    });
    document.body.append(overlay);
    return overlay;
  }

  start() {
    document.exitPointerLock?.();
    this.reactor.setHints(false);
    this.reactor.model.reset();
    this.reactor.drawStatus(true);
    this.console.onActivation = (event) => this.onActivation(event);
    this.focusCurrent();
    return this;
  }

  focusCurrent() {
    const mesh = this.targets[this.index];
    if (!mesh) {
      this.finish();
      return;
    }
    mesh.computeWorldMatrix(true);
    const target = mesh.getAbsolutePosition();
    const player = this.app.player;
    player.position.set(target.x, 0, target.z + 2.55);
    player.forward.set(0, 0, -1);
    const eye = player.position.add(B.Vector3.Up().scale(1.65));
    const direction = target.subtract(eye);
    player.pitch = Math.atan2(
      direction.y,
      Math.hypot(direction.x, direction.z),
    );
    player.inputEnabled = true;
    player.update(0);
    this.render();
  }

  verify(event) {
    const errors = [];
    const target = this.targets[this.index];
    if (event.mesh !== target) errors.push('нажат соседний 3D-орган');

    if (event.control) {
      const expected = expectedControl(event.before, event.control);
      const actual = event.after.controls[event.control.name];
      if (actual !== expected)
        errors.push(`модель: ожидалось ${expected}, получено ${actual}`);
      const readout = this.console.readouts.find(
        (item) => item.name === event.control.name,
      );
      if (readout?.renderedValue !== actual)
        errors.push('локальный 3D-индикатор не обновился');
    } else if (event.action === 'scram') {
      if (
        !event.after.scrammed ||
        event.after.controls.targetPower !== 0 ||
        event.after.controls.manualRodInsertion !== 100 ||
        event.after.controls.shortenedRodInsertion !== 100 ||
        event.after.controls.automaticRodInsertion !== 100
      )
        errors.push('АЗ-5 не выдала полный ввод стержней и нулевое задание');
    } else if (event.action === 'clear') {
      if (
        event.after.scrammed ||
        event.after.controls.targetPower !== 5 ||
        event.after.controls.manualRodInsertion !== 75
      )
        errors.push('снятие АЗ не восстановило пусковую конфигурацию');
    } else if (event.action === 'reset') {
      if (
        event.after.scrammed ||
        event.after.controls.targetPower !== 100 ||
        event.after.controls.scenario !== 'normal'
      )
        errors.push('исходный режим восстановлен не полностью');
    }

    const screensMatch = this.console.screens.every(
      (screen) =>
        screen.renderedAt === this.console.lastDraw &&
        screen.renderedState?.scrammed === event.after.scrammed &&
        sameControls(screen.renderedState?.controls, event.after.controls),
    );
    if (!screensMatch) errors.push('один из шести экранов отстаёт от модели');
    return errors;
  }

  onActivation(event) {
    const errors = this.verify(event);
    this.results.push({
      index: this.index + 1,
      label: targetLabel(this.targets[this.index]),
      ok: errors.length === 0,
      errors,
    });
    if (event.action === 'scram') {
      this.render(
        'Ожидание снижения мощности до 3% для физической кнопки снятия АЗ',
      );
      this.waitTimer = window.setInterval(() => {
        if (this.reactor.model.power > 3) return;
        window.clearInterval(this.waitTimer);
        this.waitTimer = 0;
        this.advance();
      }, 100);
      return;
    }
    window.setTimeout(() => this.advance(), 170);
  }

  advance() {
    this.index += 1;
    this.focusCurrent();
  }

  finish() {
    this.console.onActivation = null;
    const passed = this.results.filter((result) => result.ok).length;
    window.rbmkPhysicalAuditReport = {
      total: this.targets.length,
      passed,
      failed: this.targets.length - passed,
      results: this.results.map((result) => ({ ...result })),
    };
    this.overlay.dataset.complete = 'true';
    this.render(
      passed === this.targets.length
        ? 'ЗАВЕРШЕНО: все физические органы прошли проверку'
        : 'ЗАВЕРШЕНО: обнаружены ошибки',
    );
  }

  render(note = '') {
    const passed = this.results.filter((result) => result.ok).length;
    const rows = this.results.map(
      (result) =>
        `${result.ok ? '✓' : '✗'} ${String(result.index).padStart(2, '0')} ${result.label}${
          result.errors.length ? `: ${result.errors.join('; ')}` : ''
        }`,
    );
    const current = this.targets[this.index];
    this.overlay.textContent = [
      'ФИЗИЧЕСКИЙ АУДИТ БЩУ',
      `${passed}/${this.targets.length} успешно · ${this.results.length} проверено`,
      current
        ? `Цель ${this.index + 1}/${this.targets.length}: ${targetLabel(current)}`
        : 'Целей больше нет',
      note,
      '',
      ...rows,
    ]
      .filter((line, index) => line || index === 4)
      .join('\n');
  }
}

export function startRbmkPhysicalAudit(app) {
  return new RbmkPhysicalAudit(app).start();
}
