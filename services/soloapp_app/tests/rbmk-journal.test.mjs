import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RbmkJournal,
  parseJournalTime,
} from '../public/client/rbmk-journal.js';

const draft = (changes = {}) => ({
  journal: 'ИУР',
  kind: 'наблюдение',
  text: 'Показание сверено с прибором',
  status: 'зафиксировано',
  ...changes,
});

test('manual entries preserve authors, separate event time and recording time', () => {
  const journal = new RbmkJournal();
  const entry = journal.create(
    draft({ eventTime: '01:15' }),
    'участник #1',
    100,
    '1',
  );
  assert.equal(entry.eventAt, 75);
  assert.equal(entry.recordedAt, 100);
  assert.equal(entry.actor, 'участник #1');
  assert.throws(() => {
    entry.text = 'перезапись';
  }, TypeError);
  assert.throws(() => journal.create(draft(), 'участник #2', 110, '1'));
  assert.throws(() => parseJournalTime('01:60', 1000));
  assert.throws(() => parseJournalTime('05:00', 100));
  assert.equal(parseJournalTime('01:02:03', 4000), 3723);
});

test('orders require sender and recipient; completion needs a separate confirmed result', () => {
  const journal = new RbmkJournal();
  assert.throws(() =>
    journal.create(draft({ kind: 'распоряжение' }), 'НСБ', 10, 'bad'),
  );
  journal.create(
    draft({
      kind: 'распоряжение',
      sender: 'НСБ',
      recipient: 'ИУР',
      status: 'подтверждено',
    }),
    'НСБ',
    10,
    'order',
  );
  assert.equal(journal.entries[0].status, 'ожидается');
  journal.create(
    draft({ kind: 'результат', ref: 'order', status: 'выполнено' }),
    'ИУР',
    20,
    'result',
  );
  assert.equal(journal.openItems('ИУР').length, 1);
  journal.create(
    draft({ kind: 'результат', ref: 'order', status: 'подтверждено' }),
    'НСБ',
    30,
    'confirmed',
  );
  assert.equal(journal.openItems('ИУР').length, 0);
  assert.equal(journal.entries[0].text, 'Показание сверено с прибором');
});

test('corrections append without erasing history and cannot reference another role journal', () => {
  const journal = new RbmkJournal();
  journal.create(draft({ text: 'Первое наблюдение' }), 'ИУР', 10, 'first');
  assert.throws(() =>
    journal.create(
      draft({ kind: 'исправление', ref: 'missing' }),
      'ИУР',
      20,
      'bad',
    ),
  );
  assert.throws(() =>
    journal.create(
      draft({ journal: 'НСБ', kind: 'исправление', ref: 'first' }),
      'НСБ',
      20,
      'bad',
    ),
  );
  journal.create(
    draft({ kind: 'исправление', ref: 'first', text: 'Уточнение наблюдения' }),
    'ИУР',
    20,
    'second',
  );
  assert.equal(journal.entries[0].text, 'Первое наблюдение');
  assert.equal(journal.entries[1].ref, 'first');
});

test('handover requires acceptance by a different participant with a reference to the giving record', () => {
  const journal = new RbmkJournal();
  journal.create(
    draft({ kind: 'сдача смены', text: 'Передаю открытые вопросы: Д-1' }),
    '#1',
    10,
    'give',
  );
  assert.throws(() =>
    journal.create(
      draft({ kind: 'приём смены', ref: 'give' }),
      '#1',
      20,
      'self',
    ),
  );
  const accepted = journal.create(
    draft({ kind: 'приём смены', ref: 'give' }),
    '#2',
    20,
    'accept',
  );
  assert.equal(accepted.ref, 'give');
  assert.equal(journal.entries.length, 2);
});

test('automatic tape records signal appearance and disappearance and only indicated measurements', () => {
  const journal = new RbmkJournal();
  const state = {
    elapsed: 0,
    alarms: [],
    power: 100,
    pressure: 6.87,
    drumLevelLeft: 0,
    drumLevelRight: 0,
    measuredFlowLeft: 50,
    measuredFlowRight: 100,
    flowLeft: 37,
    flowRight: 81,
  };
  journal.sample(state);
  journal.sample({ ...state, elapsed: 1, alarms: ['Д-1 недостоверен'] });
  journal.sample({ ...state, elapsed: 2, alarms: ['Д-1 недостоверен'] });
  journal.sample({ ...state, elapsed: 3 });
  assert.equal(journal.machine.length, 3);
  assert.match(journal.machine[0].text, /G ПОКАЗ.=50\/100/);
  assert.match(journal.machine[1].text, /ПОЯВИЛСЯ/);
  assert.match(journal.machine[2].text, /ИСЧЕЗ/);
  journal.sample({ ...state, elapsed: 59 });
  assert.equal(journal.machine.length, 3);
  journal.sample({ ...state, elapsed: 60 });
  assert.equal(journal.machine.length, 4);
  journal.recordAction('ГЦН-Л отключён', '#1', 60);
  assert.equal(journal.protocol.length, 1);
  assert.equal(journal.entries.length, 0);
});

test('network import rejects impersonation and duplicate overwrites and preserves linked history', () => {
  const sender = new RbmkJournal(),
    receiver = new RbmkJournal();
  const first = sender.create(draft(), '#1', 10, 'first');
  assert.equal(receiver.receive(first, '#2'), false);
  assert.equal(receiver.receive(first, '#1'), true);
  assert.equal(receiver.receive({ ...first, text: 'переписано' }, '#1'), false);
  const correction = sender.create(
    draft({ kind: 'исправление', ref: 'first' }),
    '#1',
    20,
    'second',
  );
  assert.equal(receiver.receive(correction, '#1'), true);
  assert.equal(receiver.entries[0].text, first.text);
  assert.equal(
    receiver.receive({ ...first, id: 'invalid', recordedAt: NaN }, '#1'),
    false,
  );
  assert.equal(receiver.entries.length, 2);
});

test('history from several peers retains a correction received before its original', () => {
  const sender = new RbmkJournal(),
    receiver = new RbmkJournal();
  const first = sender.create(draft(), '#1', 10, 'original');
  const correction = sender.create(
    draft({ kind: 'исправление', ref: 'original', text: 'Уточнение' }),
    '#1',
    20,
    'correction',
  );
  assert.equal(receiver.receive(correction, '#1'), false);
  assert.equal(receiver.entries.length, 0);
  assert.equal(receiver.receive(first, '#1'), true);
  assert.equal(receiver.entries.length, 2);
  assert.equal(receiver.entries[1].ref, 'original');
  assert.equal(receiver.pending.size, 0);
});
