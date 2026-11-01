const B = window.BABYLON;

// This harness only positions the camera and observes outcomes. It never
// invokes a journal command: all activations must come through a real ray pick.
export function startRbmkJournalAudit(app) {
  const station = app.reactor.journal;
  const targets = [...station.keys];
  const results = [];
  let index = 0,
    pending = false;
  const overlay = document.createElement('section');
  overlay.id = 'rbmk-journal-audit';
  overlay.setAttribute('role', 'status');
  Object.assign(overlay.style, {
    position: 'fixed',
    right: '12px',
    top: '12px',
    zIndex: '2000',
    width: '340px',
    maxHeight: '40vh',
    overflow: 'auto',
    background: '#102325ed',
    color: '#ede3c4',
    padding: '12px',
    font: '12px/1.4 monospace',
    whiteSpace: 'pre-wrap',
    pointerEvents: 'none',
  });
  document.body.append(overlay);
  const render = () => {
    overlay.dataset.targetIndex = String(index);
    overlay.textContent =
      `АУДИТ НАТИВНОГО ЖУРНАЛА\n${results.filter((r) => r.ok).length}/${targets.length} успешно\n` +
      (targets[index]
        ? `Цель ${index + 1}: ${targets[index].name}\n`
        : 'ЗАВЕРШЕНО\n') +
      results
        .map(
          (r) =>
            `${r.ok ? '✓' : '✗'} ${r.label}${r.error ? ': ' + r.error : ''}`,
        )
        .join('\n');
  };
  const focus = () => {
    const target = targets[index];
    if (!target) {
      station.onActivation = null;
      overlay.dataset.complete = 'true';
      render();
      return;
    }
    target.computeWorldMatrix(true);
    const point = target.getAbsolutePosition();
    app.player.position.copyFrom(point.add(new B.Vector3(0, 0, 1.35)));
    app.player.position.y = 0;
    const direction = point.subtract(
      app.player.position.add(new B.Vector3(0, 1.65, 0)),
    );
    app.player.forward.set(direction.x, 0, direction.z).normalize();
    app.player.pitch = Math.atan2(
      direction.y,
      Math.hypot(direction.x, direction.z),
    );
    app.player.inputEnabled = true;
    app.player.update(0);
    render();
  };
  station.onActivation = ({ mesh, command, before }) => {
    if (pending) return;
    pending = true;
    let error = mesh !== targets[index] ? 'нажата соседняя клавиша' : '';
    const check = (valid, message) => {
      if (!valid) error += (error ? '; ' : '') + message;
    };
    if (command.type === 'char')
      check(
        station.draft[before.field] === before[before.field] + command.value,
        'символ не напечатан',
      );
    if (command.type === 'backspace')
      check(
        station.draft[before.field] === before[before.field].slice(0, -1),
        'забой не выполнен',
      );
    if (command.type === 'focus') check(station.focused, 'ввод не включён');
    if (command.type === 'exit') check(!station.focused, 'ввод не выключен');
    if (command.type === 'submit')
      check(
        station.store.entries.length === before.entries + 1,
        station.message,
      );
    for (const [type, field] of [
      ['role', 'journal'],
      ['kind', 'kind'],
      ['status', 'status'],
    ])
      if (command.type === type)
        check(station.draft[field] !== before[field], `не переключён ${field}`);
    if (command.type === 'field')
      check(station.field !== before.field, 'не переключено поле');
    if (command.type === 'cartogram')
      check(
        !!station.printCartogram !== before.cartogram,
        'не изменён вид распечатки',
      );
    if (command.type === 'export')
      check(station.message.includes('Выгружены'), 'выгрузка не запущена');
    if (command.type === 'page')
      check(station.page >= 0, 'неверная страница книги');
    if (command.type === 'tape')
      check(station.tapePage >= 0, 'неверная страница ленты');
    results.push({ label: targets[index].name, ok: !error, error });
    window.setTimeout(() => {
      index++;
      pending = false;
      focus();
    }, 180);
  };
  app.reactor.setHints(false);
  focus();
  return { results, targets };
}
