import {
  RbmkJournal,
  JOURNAL_ROLES,
  JOURNAL_KINDS,
  JOURNAL_STATUSES,
  journalTime,
} from './rbmk-journal.js';

const B = window.BABYLON;
const FIELDS = Object.freeze([
  ['text', 'СОДЕРЖАНИЕ'],
  ['equipment', 'ОБОРУДОВАНИЕ'],
  ['eventTime', 'ВРЕМЯ СОБЫТИЯ (пусто = сейчас)'],
  ['sender', 'ПЕРЕДАЛ'],
  ['recipient', 'ПРИНЯЛ / КОМУ'],
  ['ref', 'ССЫЛКА НА № ЗАПИСИ'],
]);

function wrap(text, width = 64) {
  return String(text)
    .split('\n')
    .flatMap((paragraph) => {
      const lines = [];
      let line = '';
      for (const word of paragraph.split(/\s+/)) {
        if (line.length + word.length + 1 > width) {
          lines.push(line);
          line = '';
        }
        if (word.length > width) {
          if (line) {
            lines.push(line);
            line = '';
          }
          for (let i = 0; i < word.length; i += width)
            lines.push(word.slice(i, i + width));
        } else line += (line ? ' ' : '') + word;
      }
      if (line || !lines.length) lines.push(line);
      return lines;
    });
}

// Mechanical controls, type bars, platen, ribbon and paper are independent
// geometry. Every key is pickable; no photo or preprinted event image is used.
export class RbmkJournalStation {
  constructor(room) {
    this.room = room;
    this.console = room.physicalConsole;
    this.store = new RbmkJournal();
    this.keys = [];
    this.field = 'text';
    this.draft = {
      journal: 'ИУР',
      kind: 'наблюдение',
      status: 'зафиксировано',
      text: '',
      equipment: '',
      eventTime: '',
      sender: '',
      recipient: '',
      ref: '',
    };
    this.focused = false;
    this.page = 0;
    this.message =
      'Нажмите «ВВОД»: клавиатура или клавиши машинки. Ctrl+Enter — запись.';
    this.lastDraw = 0;
    this.printedChars = 0;
    this.lastPrint = 0;
    this.build();
    this.buildInput();
  }

  box(name, size, at, material, parent = this.root, collider = false) {
    return this.console.box(
      `Журнал · ${name}`,
      size,
      at,
      material,
      parent,
      collider,
    );
  }

  plate(name, label, width, at, parent = this.root, rotation = null) {
    return this.console.makeTextPlate(
      `Журнал · ${name}`,
      label,
      width,
      0.095,
      at,
      parent,
      '#d8cfb4',
      '#252b29',
      36,
      rotation,
    );
  }

  key(label, command, at, width = 0.17, parent = this.root) {
    const key = this.box(
      `клавиша ${label}`,
      [width, 0.045, 0.105],
      at,
      this.console.bezel,
      parent,
    );
    key.isPickable = true;
    key.metadata = { rbmkJournal: command, restY: at[1] };
    const legend = this.console.texturePlane(
      `Журнал · ${label}`,
      width * 0.92,
      0.087,
      { width: 256, height: 128 },
      [0, 0.024, 0],
      key,
      [-Math.PI / 2, 0, 0],
    );
    const ctx = legend.texture.getContext();
    ctx.fillStyle = '#292e2d';
    ctx.fillRect(0, 0, 256, 128);
    ctx.fillStyle = '#e9dec1';
    ctx.font = `bold ${label.length === 1 ? 94 : 43}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 128, 65, 242);
    legend.texture.update();
    this.keys.push(key);
    return key;
  }

  build() {
    const c = this.console;
    this.root = new B.TransformNode('RBMK journal desk', this.room.scene);
    this.root.parent = this.room.root;
    this.root.position.set(-3.5, 0, 3.1);
    const wood = c.material('Journal desk wood', '#655345');
    const paint = c.material('Typewriter olive enamel', '#60675e');
    const paper = c.material('Journal paper edges', '#d7d0b2');
    this.box('стол', [4.4, 0.12, 1.7], [0, 0.8, 0], wood, this.root, true);
    for (const x of [-2, 2])
      for (const z of [-0.65, 0.65])
        this.box('ножка', [0.09, 0.74, 0.09], [x, 0.37, z], c.darkSteel);
    this.plate(
      'назначение',
      'ОПЕРАТИВНЫЕ ЖУРНАЛЫ · ИУР / НСБ / ТУРБИНЫ',
      3.95,
      [0, 0.76, 0.862],
    );
    this.machine = new B.TransformNode(
      'Mechanical journal typewriter',
      this.room.scene,
    );
    this.machine.parent = this.root;
    this.machine.position.x = -0.98;
    this.box(
      'корпус машинки',
      [2, 0.15, 0.99],
      [0, 0.95, 0.1],
      paint,
      this.machine,
    );
    this.box(
      'задний корпус',
      [1.9, 0.27, 0.25],
      [0, 1.13, -0.34],
      paint,
      this.machine,
    );
    this.carriage = new B.TransformNode('Typewriter carriage', this.room.scene);
    this.carriage.parent = this.machine;
    const platen = B.MeshBuilder.CreateCylinder(
      'Typewriter rubber platen',
      { height: 1.82, diameter: 0.14, tessellation: 20 },
      this.room.scene,
    );
    platen.parent = this.carriage;
    platen.position.set(0, 1.22, -0.39);
    platen.rotation.z = Math.PI / 2;
    platen.material = c.bezel;
    platen.isPickable = false;
    for (const x of [-0.99, 0.99]) {
      const knob = B.MeshBuilder.CreateCylinder(
        'Typewriter paper-feed knob',
        { height: 0.1, diameter: 0.22, tessellation: 16 },
        this.room.scene,
      );
      knob.parent = this.carriage;
      knob.position.set(x, 1.22, -0.39);
      knob.rotation.z = Math.PI / 2;
      knob.material = c.bezel;
      knob.isPickable = false;
    }
    this.box(
      'каретка',
      [1.97, 0.055, 0.09],
      [0, 1.19, -0.27],
      c.trim,
      this.carriage,
    );
    for (const x of [-0.4, 0.4]) {
      const spool = B.MeshBuilder.CreateCylinder(
        'Typewriter ribbon spool',
        { height: 0.026, diameter: 0.25, tessellation: 20 },
        this.room.scene,
      );
      spool.parent = this.machine;
      spool.position.set(x, 1.105, -0.09);
      spool.material = c.bezel;
      spool.isPickable = false;
    }
    this.box(
      'красящая лента',
      [0.8, 0.025, 0.018],
      [0, 1.12, -0.08],
      c.bezel,
      this.machine,
    );
    this.typebar = this.box(
      'литера',
      [0.027, 0.035, 0.26],
      [0, 1.08, -0.09],
      c.trim,
      this.machine,
    );
    this.paper = c.texturePlane(
      'Typewriter live draft paper',
      1.78,
      1.14,
      { width: 1280, height: 820 },
      [0, 1.83, -0.42],
      this.machine,
      [-0.08, 0, 0],
    );
    const rows = [
      '1234567890-№:Ё',
      'ЙЦУКЕНГШЩЗХЪ',
      'ФЫВАПРОЛДЖЭ',
      'ЯЧСМИТЬБЮ.,',
    ];
    rows.forEach((letters, row) =>
      [...letters].forEach((letter, col) =>
        this.key(
          letter,
          { type: 'char', value: letter },
          [
            (col - (letters.length - 1) / 2) * 0.151,
            1.064 - row * 0.009,
            0.08 + row * 0.115,
          ],
          0.133,
          this.machine,
        ),
      ),
    );
    this.key(
      'ПРОБЕЛ',
      { type: 'char', value: ' ' },
      [-0.12, 1.035, 0.57],
      1.08,
      this.machine,
    );
    this.key(
      '⌫',
      { type: 'backspace' },
      [0.62, 1.035, 0.57],
      0.25,
      this.machine,
    );
    this.key('ВВОД', { type: 'focus' }, [-0.65, 0.91, 0.73], 0.5, this.machine);
    this.key(
      'ЗАПИСАТЬ',
      { type: 'submit' },
      [0, 0.91, 0.73],
      0.65,
      this.machine,
    );
    this.key('ВЫХОД', { type: 'exit' }, [0.68, 0.91, 0.73], 0.5, this.machine);

    // The ruled open book is the human record. The neighbouring teletype is
    // the automatic stream. Its data never become a human entry by themselves.
    this.box(
      'переплёт книги',
      [2.14, 0.045, 1.42],
      [1.15, 0.9, -0.02],
      c.green,
    );
    this.box('блок бумаги', [2.08, 0.03, 1.36], [1.15, 0.937, -0.02], paper);
    this.book = c.texturePlane(
      'Operational journal live ruled pages',
      2.05,
      1.34,
      { width: 1600, height: 1060 },
      [1.15, 0.956, -0.02],
      this.root,
      [-Math.PI / 2, 0, 0],
    );
    this.book.plane.isPickable = true;
    this.book.plane.metadata = { rbmkJournal: { type: 'read', view: 'book' } };
    this.key('ЖУРНАЛ', { type: 'role' }, [0.47, 0.95, 0.74], 0.46);
    this.key('ВИД', { type: 'kind' }, [0.98, 0.95, 0.74], 0.4);
    this.key('СТАТУС', { type: 'status' }, [1.46, 0.95, 0.74], 0.46);
    this.key('ПОЛЕ', { type: 'field' }, [1.98, 0.95, 0.74], 0.42);
    this.key('← СТР.', { type: 'page', delta: 1 }, [0.45, 0.95, -0.76], 0.6);
    this.key('СТР. →', { type: 'page', delta: -1 }, [1.13, 0.95, -0.76], 0.6);
    this.key('КАРТОГР.', { type: 'cartogram' }, [1.9, 0.95, -0.76], 0.72);
    this.key('ВЫГРУЗИТЬ', { type: 'export' }, [-1.76, 0.95, -0.76], 0.76);
    this.key('ФОРМУЛЯР', { type: 'form' }, [-0.9, 0.95, -0.76], 0.76);

    this.teleRoot = new B.TransformNode(
      'Automatic teletype station',
      this.room.scene,
    );
    this.teleRoot.parent = this.root;
    this.teleRoot.position.set(3.2, 0, -0.2);
    this.box(
      'стойка телетайпа',
      [1.6, 0.9, 0.8],
      [0, 0.45, 0],
      c.darkSteel,
      this.teleRoot,
    );
    this.box(
      'принтер телетайпа',
      [1.5, 0.22, 0.7],
      [0, 1.02, 0],
      paint,
      this.teleRoot,
    );
    this.tape = c.texturePlane(
      'Automatic signal paper tape',
      1.37,
      2,
      { width: 1000, height: 1450 },
      [0, 2.1, -0.19],
      this.teleRoot,
    );
    this.tape.plane.isPickable = true;
    this.tape.plane.metadata = { rbmkJournal: { type: 'read', view: 'tape' } };
    this.plate(
      'телетайп',
      'АВТОМАТИЧЕСКАЯ РЕГИСТРАЦИЯ',
      1.42,
      [0, 1.13, 0.36],
      this.teleRoot,
    );
    this.key(
      'ЛЕНТА ↑',
      { type: 'tape', delta: 1 },
      [-0.38, 1.15, 0.24],
      0.62,
      this.teleRoot,
    );
    this.key(
      'ЛЕНТА ↓',
      { type: 'tape', delta: -1 },
      [0.38, 1.15, 0.24],
      0.62,
      this.teleRoot,
    );
    this.tapePage = 0;
  }

  buildInput() {
    // This invisible input bridges IME, clipboard and accessibility to the
    // typewriter. All visible editing happens on its sheet inside the room.
    this.input = document.createElement('textarea');
    this.input.id = 'rbmk-typewriter-input';
    this.input.setAttribute(
      'aria-label',
      'Печатная машинка — содержание выбранного поля',
    );
    Object.assign(this.input.style, {
      position: 'fixed',
      left: '-10000px',
      width: '1px',
      height: '1px',
    });
    document.body.append(this.input);
    this.input.addEventListener('input', () => {
      this.draft[this.field] = this.input.value.slice(
        0,
        this.field === 'text' ? 800 : 120,
      );
      this.input.value = this.draft[this.field];
      this.strike();
      this.draw(true);
    });
    this.input.addEventListener('keydown', (event) => {
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        this.blur();
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        this.nextField();
      }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        this.submit();
      }
    });
    this.input.addEventListener('keyup', (event) =>
      event.stopImmediatePropagation(),
    );
    this.input.addEventListener('blur', () => {
      this.focused = false;
    });
    this.accessible = document.createElement('section');
    this.accessible.id = 'rbmk-journal-status';
    this.accessible.setAttribute('role', 'status');
    this.accessible.setAttribute('aria-label', 'Бумажный журнал БЩУ');
    Object.assign(this.accessible.style, {
      position: 'fixed',
      left: '-10000px',
      width: '1px',
      height: '1px',
    });
    document.body.append(this.accessible);
  }

  focus() {
    this.printedEntry = null;
    document.exitPointerLock?.();
    this.room.player.keys.clear();
    this.focused = true;
    this.input.value = this.draft[this.field];
    this.input.focus({ preventScroll: true });
    this.message =
      'Печать на листе · Tab — поле · Ctrl+Enter — записать · Esc — встать';
    this.draw(true);
  }

  blur() {
    this.focused = false;
    this.input.blur();
    this.room.player.keys.clear();
    this.message = 'Ввод завершён. Черновик сохранён на машинке.';
    this.draw(true);
  }

  nextField() {
    this.field =
      FIELDS[
        (FIELDS.findIndex(([name]) => name === this.field) + 1) % FIELDS.length
      ][0];
    if (this.focused) {
      this.input.value = this.draft[this.field];
      this.input.focus({ preventScroll: true });
    }
    this.draw(true);
  }

  strike() {
    this.lastPrint = performance.now();
    this.typebar.rotation.x = -0.65;
    this.carriage.position.x = -((this.draft.text.length % 64) / 64) * 0.15;
  }

  activate(mesh) {
    const command = mesh?.metadata?.rbmkJournal;
    if (!command || !this.room.active) return false;
    if (command.type === 'read') {
      this.room.focusJournal(command.view);
      return true;
    }
    const now = performance.now();
    if (now - (this.lastActivation || 0) < 100) return true;
    this.lastActivation = now;
    if (
      ['char', 'backspace', 'role', 'kind', 'status', 'field', 'form'].includes(
        command.type,
      )
    )
      this.printedEntry = null;
    const before = {
      ...this.draft,
      field: this.field,
      page: this.page,
      tapePage: this.tapePage,
      cartogram: !!this.printCartogram,
      entries: this.store.entries.length,
      focused: this.focused,
    };
    mesh.position.y = mesh.metadata.restY - 0.018;
    mesh.metadata.releaseAt = now + 140;
    const cycle = (key, values) => {
      this.draft[key] =
        values[(values.indexOf(this.draft[key]) + 1) % values.length];
    };
    if (command.type === 'char' || command.type === 'backspace') {
      const value = this.draft[this.field];
      this.draft[this.field] =
        command.type === 'char'
          ? (value + command.value).slice(0, this.field === 'text' ? 800 : 120)
          : value.slice(0, -1);
      this.input.value = this.draft[this.field];
      this.strike();
    } else if (command.type === 'focus') this.focus();
    else if (command.type === 'exit') this.blur();
    else if (command.type === 'submit') this.submit();
    else if (command.type === 'role') {
      cycle('journal', JOURNAL_ROLES);
      this.page = 0;
    } else if (command.type === 'kind') cycle('kind', JOURNAL_KINDS);
    else if (command.type === 'status') cycle('status', JOURNAL_STATUSES);
    else if (command.type === 'field') this.nextField();
    else if (command.type === 'page')
      this.page = Math.max(
        0,
        Math.min(
          this.page + command.delta,
          Math.max(
            0,
            this.store.entries.filter((e) => e.journal === this.draft.journal)
              .length - 1,
          ),
        ),
      );
    else if (command.type === 'tape')
      this.tapePage = Math.max(
        0,
        Math.min(
          this.tapePage + command.delta,
          Math.max(0, Math.ceil(this.store.machine.length / 8) - 1),
        ),
      );
    else if (command.type === 'cartogram') {
      this.printCartogram = !this.printCartogram;
      if (this.printCartogram) this.cartogramState = this.room.model.snapshot();
      this.message = this.printCartogram
        ? 'Картограмма: расчётная учебная сетка, не независимые датчики каналов.'
        : 'Хронологическая лента сигналов.';
    } else if (command.type === 'form') {
      const original = this.store.entries
        .filter((entry) => entry.journal === this.draft.journal)
        .at(-1);
      this.draft.ref = original?.id || '';
      this.draft.sender = this.room.actorLabel();
      this.message = original
        ? `Ссылка на последнюю запись: ${original.id}. Содержание заполните самостоятельно.`
        : 'Исходных записей ещё нет. Заполните содержание и реквизиты.';
    } else if (command.type === 'export') this.export();
    this.draw(true);
    this.onActivation?.({ mesh, command, before });
    return true;
  }

  submit() {
    try {
      if (this.pendingId)
        throw new Error('Ожидается подтверждение предыдущей записи PostgreSQL');
      const target = this.room.server.required ? new RbmkJournal() : this.store;
      if (this.room.server.required) target.entries = [...this.store.entries];
      const entry = target.create(
        this.draft,
        this.room.actorLabel(),
        this.room.model.elapsed,
        `${this.room.network?.id || 'Л'}-${crypto.randomUUID().slice(0, 8)}`,
      );
      if (this.room.server.required) {
        if (!this.room.server.request({ kind: 'journal', entry }, entry.id))
          throw new Error(this.room.server.status());
        this.pendingId = entry.id;
        this.message = 'Запись отправлена. Ожидается подтверждение PostgreSQL.';
        this.draw(true);
        return;
      }
      this.room.share('journal-entry', { entry });
      this.persist();
      this.finishEntry(entry);
    } catch (error) {
      this.message = error.message;
    }
    this.draw(true);
  }

  finishEntry(entry) {
    this.pendingId = null;
    this.printedEntry = entry;
    this.draft.text = '';
    this.draft.eventTime = '';
    this.input.value = this.draft[this.field];
    this.page = 0;
    this.message = `Запись № ${entry.id} внесена${this.room.server.required ? ' · PostgreSQL' : ''}. Исправление — отдельной записью.`;
    this.strike();
    this.draw(true);
  }

  persist() {
    try {
      sessionStorage.setItem(
        this.storageKey || 'rbmk-human-journal-v1',
        JSON.stringify(this.store.entries),
      );
    } catch {
      this.message += ' Браузер не сохранил копию; выгрузите журнал.';
    }
  }

  restore() {
    try {
      const entries = JSON.parse(
        sessionStorage.getItem('rbmk-human-journal-v1') || '[]',
      );
      if (Array.isArray(entries))
        for (const entry of entries.slice(0, 2000))
          this.store.receive(entry, entry.actor);
    } catch {
      this.message = 'Копия журнала не прочитана. Можно начать новые записи.';
    }
  }

  export() {
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              form: 'Учебный макет по docs/JOURNAL.md; не исторический бланк',
              entries: this.store.entries,
              machine: this.store.machine,
              instructor: this.store.protocol,
            },
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      ),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'rbmk-training-journals.json';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.message =
      'Выгружены отдельные потоки: ручные записи, телетайп, протокол инструктора.';
  }

  draw(force = false) {
    const now = performance.now();
    for (const key of this.keys)
      if (key.metadata.releaseAt && now > key.metadata.releaseAt) {
        key.position.y = key.metadata.restY;
        key.metadata.releaseAt = 0;
      }
    if (now - this.lastPrint > 120) this.typebar.rotation.x = 0;
    if (!force && now - this.lastDraw < 180) return;
    this.lastDraw = now;
    const actor = this.room.actorLabel();
    const header = `ЖУРНАЛ ${this.draft.journal} · ${this.draft.kind} · ${this.draft.status}`;
    const paperLines = [
      header,
      `АВТОР: ${actor} · ЧАСЫ УПР.: ${journalTime(this.room.model.elapsed)}`,
      `ОБОРУД.: ${this.draft.equipment || 'Блок'} · СОБЫТИЕ: ${this.draft.eventTime || 'сейчас'}`,
      `ПЕРЕДАЛ: ${this.draft.sender || '—'} · ПРИНЯЛ: ${this.draft.recipient || '—'}`,
      `ССЫЛКА: ${this.draft.ref || '—'} · ПОЛЕ: ${FIELDS.find(([id]) => id === this.field)[1]}`,
      '──────────────────────────────────────────────────────────────',
      ...wrap(
        this.draft.text ||
          this.printedEntry?.text ||
          '[МЕСТО ДЛЯ ВАШЕЙ ЗАПИСИ]',
        64,
      ).slice(-10),
      '',
      ...wrap(this.message, 64).slice(0, 2),
    ];
    this.drawPaper(this.paper, 1280, 820, paperLines, 27, 38);
    this.drawBook();
    this.drawTape();
    this.accessible.textContent =
      `${header}\n${paperLines.join('\n')}\nРучных записей: ${this.store.entries.length}\n` +
      this.store.entries
        .slice(-3)
        .map((e) => `№ ${e.id} ${e.kind}: ${e.text} · ${e.actor}`)
        .join('\n');
  }

  drawPaper(surface, width, height, lines, font, lineHeight) {
    const ctx = surface.texture.getContext();
    ctx.fillStyle = '#e8dfc4';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#b4ab90';
    ctx.lineWidth = 2;
    for (const x of [18, width - 18])
      for (let y = 20; y < height; y += 38) {
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.stroke();
      }
    ctx.fillStyle = '#262b29';
    ctx.font = `${font}px monospace`;
    ctx.textAlign = 'left';
    lines.forEach((line, index) =>
      ctx.fillText(line, 42, 42 + index * lineHeight, width - 84),
    );
    surface.texture.update();
  }

  drawBook() {
    const ctx = this.book.texture.getContext();
    ctx.fillStyle = '#e5dcc0';
    ctx.fillRect(0, 0, 1600, 1060);
    ctx.fillStyle = '#b6aa8b';
    ctx.fillRect(787, 0, 26, 1060);
    ctx.fillStyle = '#2d302c';
    ctx.font = 'bold 26px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`БЛОК · ЖУРНАЛ ${this.draft.journal} · УЧЕБНЫЙ МАКЕТ`, 35, 42);
    const entries = this.store.entries.filter(
      (entry) => entry.journal === this.draft.journal,
    );
    const start = Math.max(0, entries.length - this.page - 1);
    const end = Math.max(0, entries.length - this.page);
    const selected = entries.slice(start, end);
    ctx.font = '22px monospace';
    ctx.fillText(
      `Стр. ${start + 1} · ${selected[0]?.wallTime?.replace('T', ' ').slice(0, 19) || 'Дата не установлена'} · открытых распоряжений: ${this.store.openItems(this.draft.journal).length}`,
      35,
      80,
    );
    ctx.strokeStyle = '#9d967e';
    ctx.lineWidth = 2;
    for (const x of [30, 205, 370, 1365, 1570]) {
      ctx.beginPath();
      ctx.moveTo(x, 100);
      ctx.lineTo(x, 1025);
      ctx.stroke();
    }
    for (const y of [100, 155, 1010]) {
      ctx.beginPath();
      ctx.moveTo(30, y);
      ctx.lineTo(1570, y);
      ctx.stroke();
    }
    ctx.fillText('ВРЕМЯ', 42, 137);
    ctx.fillText('ОБОРУД.', 215, 137);
    ctx.fillText('СОДЕРЖАНИЕ / АВТОР / СВЯЗЬ ЗАПИСЕЙ', 390, 137);
    ctx.fillText('СТАТУС', 1380, 137);
    selected.forEach((entry, index) => {
      const y = 190 + index * 285;
      ctx.font = '28px monospace';
      ctx.fillText(journalTime(entry.recordedAt), 42, y);
      ctx.fillText('событие', 42, y + 31);
      ctx.fillText(journalTime(entry.eventAt), 42, y + 60);
      wrap(entry.equipment, 9)
        .slice(0, 6)
        .forEach((line, row) => ctx.fillText(line, 215, y + row * 30));
      const lines = [
        `№ ${entry.id} · ${entry.kind} · ${entry.actor}`,
        ...wrap(entry.text.replace(/\s+/g, ' '), 55),
        ...(entry.sender || entry.recipient
          ? [`Передал: ${entry.sender} → ${entry.recipient}`]
          : []),
        ...(entry.ref ? [`Связь с № ${entry.ref}`] : []),
      ];
      lines.forEach((line, row) => ctx.fillText(line, 385, y + row * 38, 960));
      wrap(entry.status, 10).forEach((line, row) =>
        ctx.fillText(line, 1378, y + row * 38),
      );
    });
    if (!selected.length)
      ctx.fillText(
        'Записей нет. Автоматические сигналы печатаются отдельно на телетайпе.',
        390,
        205,
        950,
      );
    this.book.texture.update();
  }

  drawTape() {
    const state = this.cartogramState || this.room.model.snapshot();
    if (this.printCartogram) {
      const lines = [
        'КАРТОГРАММА · УЧЕБНЫЙ РАСЧЁТ',
        `ВРЕМЯ РАСЧЁТА ${journalTime(state.elapsed)}`,
        'Не независимые измерения каналов',
        '    01 02 03 04 05 06 07 08',
      ];
      for (let row = 0; row < 8; row++) {
        const cells = Array.from({ length: 8 }, (_, col) => {
          const shape = Math.max(
            0,
            1 - Math.hypot(col - 3.5, row - 3.5) * 0.055,
          );
          return String(Math.round(state.power * shape)).padStart(3, ' ');
        });
        lines.push(`${String(row + 1).padStart(2, '0')} ${cells.join(' ')}`);
      }
      lines.push(
        '',
        `N ${state.power.toFixed(1)} % · P ${state.pressure.toFixed(2)} МПа`,
        'Сетка 8×8 — учебная, не схема АЗ',
        'Это сводка, не журнал событий',
      );
      this.drawPaper(this.tape, 1000, 1450, lines, 30, 48);
      return;
    }
    const end = Math.max(0, this.store.machine.length - this.tapePage * 8);
    const entries = this.store.machine.slice(Math.max(0, end - 8), end);
    const lines = [
      'ТЕЛЕТАЙП · СИГНАЛЫ / СВОДКИ',
      'УЧЕБНЫЙ ЦИКЛ ПАРАМЕТРОВ: 60 С',
      'Не оперативный журнал человека',
      '────────────────────────────────────────',
    ];
    for (const entry of entries)
      lines.push(
        `${journalTime(entry.time)} | ${entry.source}`,
        ...wrap(entry.text, 48),
        '',
      );
    this.drawPaper(
      this.tape,
      1000,
      1450,
      [...lines.slice(0, 4), ...lines.slice(4).slice(-28)],
      27,
      40,
    );
  }
}
