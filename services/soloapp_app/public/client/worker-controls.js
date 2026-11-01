import { WORKER_COUNT } from './worker-patrol.js';

export class WorkerCountSync {
  constructor(send, clock = () => performance.now()) {
    this.send = send;
    this.clock = clock;
    this.count = WORKER_COUNT;
    this.disconnect();
  }
  disconnect() {
    this.ready = false;
    this.revision = 0;
    this.pending = null;
    this.error = '';
  }
  receive(message) {
    if (message.type === 'workers_state') {
      if (
        message.storage !== 'postgresql' ||
        !Number.isSafeInteger(message.revision) ||
        message.revision <= this.revision ||
        !Number.isInteger(message.count) ||
        message.count < 1 ||
        message.count > 10
      )
        return false;
      this.revision = message.revision;
      this.count = message.count;
      this.ready = true;
      this.error = '';
      return true;
    }
    if (
      message.type === 'workers_ack' &&
      this.pending &&
      message.requestId === this.pending.message.requestId &&
      typeof message.accepted === 'boolean'
    ) {
      this.pending = null;
      this.error = message.accepted
        ? ''
        : message.error === 'forbidden'
          ? 'Только для администратора'
          : 'Количество изменилось. Повторите выбор.';
    }
    return false;
  }
  request(count, admin) {
    if (
      !admin ||
      !this.ready ||
      this.pending ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 10 ||
      count === this.count
    )
      return false;
    const message = {
      type: 'workers_set',
      count,
      revision: this.revision,
      requestId: crypto.randomUUID(),
    };
    if (!this.send(message)) return false;
    this.pending = { message, sentAt: this.clock() };
    this.error = '';
    return true;
  }
  tick() {
    if (this.pending && this.clock() - this.pending.sentAt >= 1000) {
      this.pending.sentAt = this.clock();
      this.send(this.pending.message);
    }
  }
}

export class WorkerControls {
  constructor(parent, workers, network) {
    Object.assign(this, { workers, network });
    this.section = document.createElement('section');
    this.section.id = 'worker-controls';
    const title = document.createElement('strong');
    title.textContent = 'Учёные в комнате';
    const buttons = document.createElement('div');
    buttons.setAttribute('role', 'group');
    buttons.setAttribute('aria-label', 'Количество учёных');
    this.buttons = Array.from({ length: 10 }, (_, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = String(index + 1);
      button.setAttribute('aria-label', `Учёных: ${index + 1}`);
      button.onclick = () =>
        workers.sync.request(index + 1, network.participants.admin);
      buttons.append(button);
      return button;
    });
    this.status = document.createElement('small');
    this.status.setAttribute('role', 'status');
    this.section.append(title, buttons, this.status);
    parent.append(this.section);
    this.update();
  }
  update() {
    const { sync } = this.workers;
    this.section.hidden = !this.network.participants.admin;
    this.buttons.forEach((button, index) => {
      button.disabled =
        !sync.ready || !!sync.pending || !this.network.participants.admin;
      button.setAttribute('aria-pressed', String(index + 1 === sync.count));
    });
    this.status.textContent =
      sync.error ||
      (!sync.ready
        ? 'Ожидание сервера…'
        : sync.pending
          ? 'Сохраняется…'
          : `Выбрано: ${sync.count} · вход и выход через общую дверь`);
  }
}
