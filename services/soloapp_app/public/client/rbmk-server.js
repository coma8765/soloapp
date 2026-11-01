// Durable PostgreSQL command channel. No optimistic mutation of a shared
// control: only a committed server snapshot changes the displayed model.
export class RbmkServerSync {
  constructor({
    send,
    restore,
    journal,
    record,
    acknowledged,
    changed,
    clock = () => performance.now(),
    requestId = () => crypto.randomUUID(),
  }) {
    Object.assign(this, {
      send,
      restore,
      journal,
      record,
      acknowledged,
      changed,
      clock,
      requestId,
    });
    this.required = false;
    this.ready = false;
    this.online = false;
    this.id = 0;
    this.writer = 0;
    this.writerEpoch = 0;
    this.revision = -1;
    this.version = -1;
    this.pending = new Map();
    this.lastSnapshot = 0;
    this.error = '';
  }

  connect(id, protocol, userId = this.userId) {
    if (this.userId && userId !== this.userId) this.pending.clear();
    this.userId = userId;
    this.required = true;
    this.ready = false;
    this.id = id;
    this.online = protocol === 1;
    this.version = -1;
    this.error = this.online ? '' : 'Сервер не поддерживает хранение РБМК';
    if (this.online) this.send({ type: 'reactor_join', active: true });
    this.changed?.();
  }

  disconnect() {
    this.online = false;
    this.ready = false;
    this.error = 'Нет подтверждённого соединения с сервером';
    this.changed?.();
  }

  leave() {
    if (this.online) this.send({ type: 'reactor_join', active: false });
    this.online = false;
    this.ready = false;
  }

  request(command, id = this.requestId()) {
    if (!this.online || !this.ready || this.pending.size >= 32) {
      this.error = 'Команда не отправлена: ожидается состояние PostgreSQL';
      this.changed?.();
      return false;
    }
    if (this.pending.has(id)) return false;
    const message = { type: 'reactor_command', requestId: id, command };
    this.pending.set(id, { message, sentAt: this.clock() });
    this.send(message);
    this.changed?.();
    return id;
  }

  receive(message) {
    if (!this.required) return;
    if (message.type === 'reactor_state') {
      if (
        !Number.isSafeInteger(message.version) ||
        message.version <= this.version ||
        !Number.isSafeInteger(message.revision) ||
        !Number.isSafeInteger(message.writerEpoch) ||
        !Number.isSafeInteger(message.writer) ||
        message.storage !== 'postgresql'
      )
        return;
      const mustRestore =
        !this.ready ||
        message.writer !== this.id ||
        message.revision !== this.revision ||
        message.writerEpoch !== this.writerEpoch;
      if (mustRestore && !this.restore(message.state)) {
        this.error = 'Серверный снимок не прошёл проверку модели';
        this.ready = false;
        this.changed?.();
        return;
      }
      this.version = message.version;
      this.revision = message.revision;
      this.writerEpoch = message.writerEpoch;
      this.writer = message.writer;
      this.ready = true;
      this.committedElapsed = message.state.elapsed;
      this.error = '';
      this.changed?.();
    } else if (message.type === 'reactor_ack') {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      this.error = message.accepted
        ? ''
        : `Команда отклонена: ${message.error}`;
      this.acknowledged?.(message, pending.message.command);
      // An ACK does not advance the local model revision. The corresponding
      // committed snapshot must have been validated independently.
      this.changed?.();
    } else if (message.type === 'reactor_journal')
      this.journal?.(message.entry);
    else if (message.type === 'reactor_command_record')
      this.record?.(message.record);
  }

  tick(state) {
    if (!this.online || !this.ready) return;
    const now = this.clock();
    for (const pending of this.pending.values()) {
      if (now - pending.sentAt < 1500) continue;
      this.send(pending.message);
      pending.sentAt = now;
    }
    if (
      this.writer === this.id &&
      !this.pending.size &&
      now - this.lastSnapshot >= 200
    ) {
      this.lastSnapshot = now;
      this.send({
        type: 'reactor_snapshot',
        revision: this.revision,
        writerEpoch: this.writerEpoch,
        state,
      });
    }
  }

  status() {
    if (!this.required)
      return 'Локальное упражнение · серверное хранение выключено';
    if (!this.online || !this.ready)
      return this.error || 'Ожидание состояния PostgreSQL';
    return (
      `PostgreSQL · снимок ${this.version} · команды ${this.revision} · расчёт: #${this.writer}` +
      (this.pending.size
        ? ` · ожидают подтверждения: ${this.pending.size}`
        : '') +
      (this.error ? ` · ${this.error}` : '')
    );
  }
}
