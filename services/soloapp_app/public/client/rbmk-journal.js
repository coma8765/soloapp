// Project rules: research docs/JOURNAL.md. Human entries and machine records
// are deliberately different streams. This is a teaching form, not a facsimile.
export const JOURNAL_ROLES = Object.freeze(['ИУР', 'НСБ', 'ТУРБИНЫ']);
export const JOURNAL_KINDS = Object.freeze([
  'наблюдение',
  'доклад',
  'распоряжение',
  'результат',
  'исправление',
  'сдача смены',
  'приём смены',
]);
export const JOURNAL_STATUSES = Object.freeze([
  'зафиксировано',
  'ожидается',
  'принято',
  'выполнено',
  'подтверждено',
]);

const clean = (value, maximum = 120) =>
  typeof value === 'string'
    ? Array.from(value)
        .filter(
          (char) =>
            (char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) ||
            char === '\n' ||
            char === '\t',
        )
        .join('')
        .trim()
        .slice(0, maximum)
    : '';

export function journalTime(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

export function parseJournalTime(value, now) {
  if (!value?.trim()) return now;
  if (!/^\d{1,3}:\d{2}(:\d{2})?$/.test(value))
    throw new Error('Время события: ММ:СС или ЧЧ:ММ:СС');
  const parts = value.split(':').map(Number);
  if (parts.at(-1) > 59 || (parts.length === 3 && parts[1] > 59))
    throw new Error('Время: минуты и секунды должны быть меньше 60');
  const seconds = parts.reduce((sum, part) => sum * 60 + part, 0);
  if (seconds > now + 1) throw new Error('Время события позже времени записи');
  return seconds;
}

export class RbmkJournal {
  constructor() {
    this.entries = [];
    this.machine = [];
    this.protocol = [];
    this.previousAlarms = new Set();
    this.nextSummary = 0;
    this.lastElapsed = -1;
    this.revision = 0;
    this.pending = new Map();
  }

  create(draft, actor, now, id) {
    if (this.entries.length >= 2000)
      throw new Error('Журнал заполнен: выгрузите упражнение');
    const text = clean(draft.text, 800);
    if (!text) throw new Error('Введите содержание записи');
    if (
      !JOURNAL_ROLES.includes(draft.journal) ||
      !JOURNAL_KINDS.includes(draft.kind)
    )
      throw new Error('Выберите журнал и вид записи');
    if (!Number.isFinite(now) || now < 0 || !clean(actor))
      throw new Error('Не установлен автор или время записи');
    const ref = clean(draft.ref);
    const original = this.entries.find((entry) => entry.id === ref);
    if (['исправление', 'результат', 'приём смены'].includes(draft.kind)) {
      if (!original || original.journal !== draft.journal)
        throw new Error('Укажите номер исходной записи этого журнала');
      if (draft.kind === 'результат' && original.kind !== 'распоряжение')
        throw new Error('Результат должен ссылаться на распоряжение');
      if (
        draft.kind === 'приём смены' &&
        (original.kind !== 'сдача смены' || original.actor === actor)
      )
        throw new Error('Приём подтверждает другой участник по записи о сдаче');
    }
    const sender = clean(draft.sender),
      recipient = clean(draft.recipient);
    if (draft.kind === 'распоряжение' && (!sender || !recipient))
      throw new Error('У распоряжения укажите передающего и принимающего');
    const entry = Object.freeze({
      id: clean(id),
      journal: draft.journal,
      kind: draft.kind,
      actor: clean(actor),
      recordedAt: now,
      wallTime: Object.hasOwn(draft, 'wallTime')
        ? typeof draft.wallTime === 'string' &&
          Number.isFinite(Date.parse(draft.wallTime))
          ? draft.wallTime
          : null
        : new Date().toISOString(),
      eventAt: parseJournalTime(draft.eventTime || '', now),
      equipment: clean(draft.equipment) || 'Блок',
      text,
      sender,
      recipient,
      status: JOURNAL_STATUSES.includes(draft.status)
        ? draft.status
        : 'зафиксировано',
      ref,
    });
    if (!entry.id || this.entries.some((item) => item.id === entry.id))
      throw new Error('Номер записи уже использован');
    // A command is pending until a separate result is entered. Never infer
    // completion from receiving a message or from the reactor's hidden state.
    const accepted = Object.freeze({
      ...entry,
      status: entry.kind === 'распоряжение' ? 'ожидается' : entry.status,
    });
    this.entries.push(accepted);
    this.revision++;
    return accepted;
  }

  receive(entry, actor) {
    if (!entry || entry.actor !== actor || typeof entry.id !== 'string')
      return false;
    if (this.entries.some((item) => item.id === entry.id)) return false;
    if (
      ['исправление', 'результат', 'приём смены'].includes(entry.kind) &&
      typeof entry.ref === 'string' &&
      !this.entries.some((item) => item.id === entry.ref)
    ) {
      if (this.pending.size < 2000)
        this.pending.set(entry.id, { entry, actor });
      return false;
    }
    try {
      this.create(
        { ...entry, eventTime: journalTime(entry.eventAt) },
        actor,
        entry.recordedAt,
        entry.id,
      );
      for (const [id, waiting] of this.pending) {
        if (!this.entries.some((item) => item.id === waiting.entry.ref))
          continue;
        this.pending.delete(id);
        this.receive(waiting.entry, waiting.actor);
      }
      return true;
    } catch {
      return false;
    }
  }

  openItems(journal) {
    return this.entries.filter(
      (entry) =>
        entry.journal === journal &&
        entry.kind === 'распоряжение' &&
        !this.entries.some(
          (result) =>
            result.ref === entry.id &&
            result.kind === 'результат' &&
            result.status === 'подтверждено',
        ),
    );
  }

  recordAction(text, actor, now) {
    this.protocol.push(
      Object.freeze({ time: now, actor, text: clean(text, 400) }),
    );
    this.protocol = this.protocol.slice(-2000);
  }

  sample(state) {
    if (state.elapsed < this.lastElapsed) {
      this.machine.push({
        time: state.elapsed,
        source: 'УПРАЖНЕНИЕ',
        text: 'Новое исходное состояние; часы упражнения сброшены',
      });
      this.previousAlarms.clear();
      this.nextSummary = 0;
    }
    this.lastElapsed = state.elapsed;
    const alarms = new Set(state.alarms);
    for (const alarm of alarms)
      if (!this.previousAlarms.has(alarm))
        this.machine.push({
          time: state.elapsed,
          source: 'СИГНАЛИЗАЦИЯ',
          text: `ПОЯВИЛСЯ: ${alarm}`,
        });
    for (const alarm of this.previousAlarms)
      if (!alarms.has(alarm))
        this.machine.push({
          time: state.elapsed,
          source: 'СИГНАЛИЗАЦИЯ',
          text: `ИСЧЕЗ: ${alarm}`,
        });
    this.previousAlarms = alarms;
    if (state.elapsed >= this.nextSummary) {
      this.machine.push({
        time: state.elapsed,
        source: 'ПРИБОРЫ · УЧЕБНЫЙ ЦИКЛ 60 С',
        text:
          `N=${state.power.toFixed(1)} %; P=${state.pressure.toFixed(2)} МПа; ` +
          `H БС=${Math.round(state.drumLevelLeft)}/${Math.round(state.drumLevelRight)} мм; ` +
          `G ПОКАЗ.=${state.measuredFlowLeft.toFixed(0)}/${state.measuredFlowRight.toFixed(0)} %`,
      });
      this.nextSummary = state.elapsed + 60;
    }
    if (this.machine.length > 4000)
      this.machine.splice(0, this.machine.length - 4000);
  }
}
