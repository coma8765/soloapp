import { REACTOR_MAP } from '../shared/room.js';

// A reliable, server-authoritative channel, also active while on the planet.
export class DoorSync {
  constructor({
    send,
    passed,
    clock = () => performance.now(),
    requestId = () => crypto.randomUUID(),
  }) {
    Object.assign(this, { send, passed, clock, requestId });
    this.required = false;
    this.online = false;
    this.ready = true;
    this.revision = 0;
    this.open = false;
    this.pending = null;
    this.retryAfter = 0;
    this.error = '';
  }

  requireServer(required) {
    if (this.required === required) return;
    this.required = required;
    this.ready = !required;
    this.online = false;
    this.open = false;
    this.pending = null;
    this.revision = -1;
  }

  connect(protocol, userId) {
    this.requireServer(true);
    if (this.userId && this.userId !== userId) this.pending = null;
    this.userId = userId;
    this.online = protocol === 1;
    this.ready = false;
    this.open = false;
    this.revision = -1;
    this.error = this.online ? '' : 'Сервер не поддерживает дверь';
  }

  disconnect() {
    this.online = false;
    this.ready = !this.required;
    this.open = false;
    this.error = this.required ? 'Ожидание связи с сервером' : '';
  }

  receive(message) {
    if (!this.required || !this.online) return;
    if (message.type === 'door_state') {
      if (
        message.storage !== 'postgresql' ||
        !Number.isSafeInteger(message.revision) ||
        message.revision < 1 ||
        message.revision <= this.revision ||
        typeof message.open !== 'boolean'
      )
        return;
      this.revision = message.revision;
      this.open = message.open;
      this.ready = true;
      this.error = '';
    } else if (
      message.type === 'door_ack' &&
      this.pending &&
      message.requestId === this.pending.message.requestId &&
      typeof message.accepted === 'boolean'
    ) {
      const { action, side } = this.pending.message;
      this.pending = null;
      this.retryAfter = this.clock() + 400;
      this.error = message.accepted
        ? ''
        : 'Дверь изменилась · повторите проход';
      const destination = side === 'planet' ? REACTOR_MAP : 'planet';
      if (
        message.accepted &&
        action === 'pass' &&
        message.destination === destination
      )
        this.passed(destination, side);
    }
  }

  request(action, side) {
    if (
      !['open', 'pass'].includes(action) ||
      !['planet', REACTOR_MAP].includes(side) ||
      this.pending ||
      this.clock() < this.retryAfter ||
      !this.ready
    )
      return false;
    if (!this.required) {
      if (action === 'open') {
        this.open = true;
        this.closeAt = this.clock() + 8000;
      } else if (this.open) {
        this.open = false;
        this.retryAfter = this.clock() + 500;
        this.passed(side === 'planet' ? REACTOR_MAP : 'planet', side);
      } else return false;
      return true;
    }
    if (!this.online) return false;
    const message = {
      type: 'door_request',
      requestId: this.requestId(),
      action,
      side,
      revision: this.revision,
    };
    this.pending = { message, sentAt: this.clock() };
    this.send(message);
    return true;
  }

  tick() {
    const now = this.clock();
    if (!this.required) {
      if (this.open && now >= this.closeAt) this.open = false;
      return;
    }
    if (
      this.online &&
      this.ready &&
      this.pending &&
      now - this.pending.sentAt >= 1000
    ) {
      this.pending.sentAt = now;
      this.send(this.pending.message);
    }
  }

  status() {
    if (this.required && (!this.online || !this.ready))
      return this.error || 'Ожидание состояния двери';
    if (this.pending?.message.action === 'pass')
      return 'Проход подтверждается…';
    if (this.error) return this.error;
    return this.open
      ? 'Проходите · дверь закроется за вами'
      : 'Подойдите к двери';
  }
}

// Swept threshold test: even a large movement step cannot tunnel through a closed door.
export function doorThreshold(before, next) {
  const side = Math.sign(before[2]) || 1;
  if (side * next[2] > 0.36 || side * before[2] < 0) return null;
  const dz = next[2] - before[2];
  const t = Math.max(0, Math.min(1, dz ? (side * 0.36 - before[2]) / dz : 1));
  const x = before[0] + (next[0] - before[0]) * t;
  const y = before[1] + (next[1] - before[1]) * t;
  if (Math.abs(x) > 1.4 || y < -0.8 || y > 3.1) return null;
  return { position: [x, y, side * 0.36], aperture: Math.abs(x) <= 0.78 };
}
