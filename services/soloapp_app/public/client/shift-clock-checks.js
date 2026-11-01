import { SHIFT_INTERVAL_MS, ShiftSchedule, clockFace } from './shift-clock.js';

// Explicit localhost-only integration/visual checks; no production clock override.
export function startShiftClockChecks(app) {
  const { reactor, shiftClock: clock, sound, player } = app;
  const panel = document.createElement('section');
  panel.style.cssText =
    'position:fixed;left:12px;top:100px;z-index:3000;background:#102b30;color:#e1f5e8;padding:12px;max-width:400px';
  const output = document.createElement('pre');
  output.setAttribute('role', 'status');
  const result = (name, passed) => {
    output.textContent += `${passed ? 'PASS' : 'FAIL'} ${name}\n`;
  };
  const button = (text, click) => {
    const node = document.createElement('button');
    node.textContent = text;
    node.onclick = click;
    panel.append(node);
  };
  const focus = (physical) => {
    if (!reactor.active) reactor.enter();
    if (!!reactor.physicalView !== physical) reactor.togglePhysical();
    const now = Date.now();
    clock.update(now);
    const root = physical ? reactor.physicalRoom.root : reactor.root;
    const entry = clock.faces.get(root);
    result(
      '3D clock displays real local time',
      entry.last.includes(clockFace(now).time),
    );
    entry.mesh.computeWorldMatrix(true);
    const outward = entry.mesh.getDirection(window.BABYLON.Axis.Z);
    player.position.copyFrom(entry.mesh.position.add(outward.scale(7)));
    player.position.y = 0;
    player.forward.copyFrom(outward.negate());
    player.pitch = Math.atan2(entry.mesh.position.y - 1.65, 7);
    player.update(0);
  };
  button('Часы БЩУ', () => focus(false));
  button('Часы физической комнаты', () => focus(true));
  button('Проверить объявление', async () => {
    try {
      await sound.start();
      await clock.prepareAudio();
      result(
        'recording decoded by real Web Audio',
        clock.buffer?.duration > 0.5,
      );
      if (!clock.buffer) return;
      const saved = clock.schedule;
      const boundary =
        Math.floor(Date.now() / SHIFT_INTERVAL_MS) * SHIFT_INTERVAL_MS;
      try {
        clock.schedule = new ShiftSchedule(boundary - 1);
        clock.update(boundary - 1);
        clock.update(boundary);
        const source = clock.source;
        result(
          'ten-minute boundary starts the recording',
          source?.buffer === clock.buffer,
        );
        clock.update(boundary + 1);
        result(
          'next frame does not restart the recording',
          source === clock.source,
        );
      } finally {
        clock.schedule = saved;
      }
    } catch (error) {
      result(error.message, false);
    }
  });
  panel.append(output);
  document.body.append(panel);
  focus(false);
}
