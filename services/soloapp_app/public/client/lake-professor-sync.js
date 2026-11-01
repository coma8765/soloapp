// Shared lake conversations travel over the existing authenticated WSS world.
export class LakeProfessorSync {
  constructor(network, clock = () => performance.now()) {
    this.network = network;
    this.clock = clock;
    this.pending = new Map();
    this.reset();
    network.onProfessorMessage = (message) => this.receive(message);
  }
  get required() {
    return !!this.network.auth.token;
  }
  reset() {
    for (const request of this.pending.values())
      request.finish(Error('Нет соединения с общим состоянием профессора'));
    this.pending.clear();
    this.state = null;
    this.protocol = 0;
    this.online = false;
  }
  receive(message) {
    if (message.type === 'professor_disconnect') {
      this.reset();
      return;
    }
    if (message.type === 'professor_welcome') {
      this.reset();
      this.protocol = message.protocol;
      this.online = true;
      return;
    }
    if (message.type === 'professor_ack') {
      const request = this.pending.get(message.requestId);
      if (request)
        request.finish(
          message.accepted
            ? null
            : Error(
                message.error === 'busy'
                  ? 'Профессор отвечает другому участнику. Дождитесь завершения ответа.'
                  : 'Разговор завершён или участник отошёл от профессора.',
              ),
        );
      return;
    }
    if (
      message.type !== 'professor_state' ||
      !this.online ||
      this.protocol !== 1 ||
      message.storage !== 'postgresql' ||
      !Number.isSafeInteger(message.revision) ||
      message.revision < 1 ||
      !Number.isSafeInteger(message.serverTime) ||
      message.serverTime < 0 ||
      !Array.isArray(message.lakes) ||
      message.lakes.length !== 4 ||
      message.lakes.some(
        (s, id) =>
          !s ||
          s.id !== id ||
          !['idle', 'thinking', 'answer'].includes(s.phase) ||
          !Number.isSafeInteger(s.focus) ||
          s.focus < 0 ||
          !Number.isSafeInteger(s.owner) ||
          s.owner < 0 ||
          !Number.isSafeInteger(s.startedAt) ||
          !Number.isSafeInteger(s.until) ||
          typeof s.text !== 'string' ||
          s.text.length > 4096 ||
          typeof s.answer !== 'string' ||
          s.answer.length > 4000 ||
          (s.position !== null &&
            (!Array.isArray(s.position) ||
              s.position.length !== 3 ||
              !s.position.every(Number.isFinite))),
      ) ||
      (this.state &&
        (message.revision < this.state.revision ||
          message.serverTime < this.state.serverTime))
    )
      return;
    this.state = message;
    this.receivedAt = this.clock();
  }
  now() {
    return this.state
      ? this.state.serverTime + this.clock() - this.receivedAt
      : 0;
  }
  record(lake) {
    return this.state?.lakes[lake] || null;
  }
  command(lake, turn, action, fields = {}, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      if (!this.online || this.protocol !== 1 || !this.state)
        return reject(Error('Ожидание серверной синхронизации профессора'));
      const requestId = crypto.randomUUID();
      const message = {
        type: 'professor_command',
        requestId,
        lake,
        turn,
        action,
        ...fields,
      };
      const abort = () =>
        request.finish(signal.reason || Error('Вопрос отменён'));
      const request = {
        message,
        sentAt: this.clock(),
        deadline: this.clock() + 12000,
        finish: (error) => {
          this.pending.delete(requestId);
          signal?.removeEventListener('abort', abort);
          if (error) reject(error);
          else resolve();
        },
      };
      this.pending.set(requestId, request);
      signal?.addEventListener('abort', abort, { once: true });
      if (!this.network.send(message))
        request.finish(Error('Нет соединения с сервером'));
    });
  }
  async request(lake, run, signal) {
    if (!this.required) return run();
    const turn = crypto.randomUUID();
    let published = false;
    // Publish the current target before the claim, including immediately after approach.
    this.network.send(this.network.player.state(++this.network.sequence));
    try {
      await this.command(lake, turn, 'begin', {}, signal);
      const result = await run();
      signal.throwIfAborted();
      await this.command(
        lake,
        turn,
        'result',
        {
          text: result.transcript,
          answer: result.answer,
        },
        signal,
      );
      published = true;
      return result;
    } finally {
      if (!published) void this.command(lake, turn, 'cancel').catch(() => {});
    }
  }
  tick() {
    const now = this.clock();
    for (const request of this.pending.values()) {
      if (now >= request.deadline)
        request.finish(Error('Сервер не подтвердил разговор'));
      else if (now - request.sentAt >= 1500) {
        request.sentAt = now;
        this.network.send(request.message);
      }
    }
  }
}

export function professorDisplay(record, now) {
  if (!record)
    return {
      text: '',
      answer: '',
      status: 'Ожидание общего состояния профессора…',
      focused: false,
      nod: 0,
      position: null,
    };
  const phase = now < record.until ? record.phase : 'idle';
  const envelope =
    phase === 'answer'
      ? Math.max(
          0,
          Math.min(
            1,
            (now - record.startedAt) / 500,
            (record.until - now) / 500,
          ),
        )
      : 0;
  return {
    text: record.text,
    answer: record.answer,
    status:
      phase === 'thinking'
        ? `Думаю над вопросом участника #${record.owner}…`
        : phase === 'answer'
          ? 'Отвечаю участникам…'
          : record.focus
            ? 'Готов к вопросу. Включите микрофон и сделайте паузу после вопроса.'
            : 'Подойдите, чтобы поговорить',
    focused: !!record.focus,
    position: record.position,
    nod: envelope
      ? Math.sin((now - record.startedAt) / 180) * 0.025 * envelope
      : 0,
  };
}
