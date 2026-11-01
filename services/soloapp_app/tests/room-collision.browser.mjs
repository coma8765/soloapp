import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname } from 'node:path';

const { chromium } = await import(
  process.env.SOLOAPP_PLAYWRIGHT_MODULE || 'playwright'
);
const root = fileURLToPath(new URL('../public/', import.meta.url));
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
  if (!file.startsWith(resolve(root) + sep)) return res.writeHead(403).end();
  try {
    const bytes = await readFile(file);
    res.setHeader(
      'Content-Type',
      {
        '.js': 'text/javascript',
        '.html': 'text/html',
        '.css': 'text/css',
        '.json': 'application/json',
      }[extname(file)] || 'application/octet-stream',
    );
    res.end(bytes);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch({
    channel: process.env.SOLOAPP_BROWSER_CHANNEL || 'chrome',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?reactor-test=1`);
  await page.waitForFunction(
    () => window.planetApp?.reactor.active,
    undefined,
    { timeout: 90000 },
  );
  const report = await page.evaluate(async () => {
    const { reactor: room, player } = planetApp;
    await player.avatar.ready;
    const B = BABYLON;
    const engine = player.scene.getEngine();
    engine.stopRenderLoop();
    room.instructor.stop();
    // Test furniture independently of randomly positioned workers.
    player.roomPeople = () => [];
    player.inputEnabled = true;
    const cabinets = room.physicalConsole.colliders.filter((m) =>
      /(?:desk|auxiliary|wall) cabinet/.test(m.name),
    );
    const checks = [];
    for (const mode of ['gamepad', 'touch', 'xr']) {
      for (const mesh of cabinets) {
        const wall = mesh.name.includes('wall cabinet');
        const matrix = mesh.parent.computeWorldMatrix(true);
        const inverse = B.Matrix.Invert(matrix);
        const start = wall ? 1 : 2.2;
        player.position.copyFrom(
          B.Vector3.TransformCoordinates(new B.Vector3(0, 0, start), matrix),
        );
        player.forward.copyFrom(
          B.Vector3.TransformNormal(
            new B.Vector3(0, 0, -1),
            matrix,
          ).normalize(),
        );
        player.xr = mode === 'xr';
        player.gamepadMove = mode === 'gamepad' ? { x: 0, y: 1 } : null;
        player.touchMove = mode === 'touch' ? { x: 0, y: 1 } : null;
        player.update(
          mode === 'xr' ? 2.2 : 1,
          mode === 'xr' ? player.forward.clone() : null,
        );
        const p = B.Vector3.TransformCoordinates(player.position, inverse);
        checks.push({
          mode,
          name: mesh.name,
          z: p.z,
          min: wall ? 0.52 : 1.35,
          start,
        });
        if (!wall && mode === 'gamepad') {
          const eye = player.camera.position;
          const buttons = room.physicalConsole.buttons.filter((b) =>
            b.isDescendantOf(mesh.parent),
          );
          const reachable = buttons.some((b) => {
            const target = b.getAbsolutePosition();
            const hit = player.scene.pickWithRay(
              new B.Ray(eye, target.subtract(eye).normalize(), 8),
              (m) => room.interactiveMesh(m),
            );
            return hit?.pickedMesh === b;
          });
          if (buttons.length) checks.at(-1).reachable = reachable;
        }
      }
    }
    const tableChecks = [];
    const tableMatrix = room.journal.root.computeWorldMatrix(true);
    const tableInverse = B.Matrix.Invert(tableMatrix);
    for (const mode of ['gamepad', 'touch', 'xr']) {
      for (const [axis, half] of [
        ['x', 2.2],
        ['z', 0.85],
      ]) {
        for (const sign of [-1, 1]) {
          const start = B.Vector3.Zero();
          start[axis] = sign * (half + 1);
          const direction = B.Vector3.Zero();
          direction[axis] = -sign;
          player.position.copyFrom(
            B.Vector3.TransformCoordinates(start, tableMatrix),
          );
          player.forward.copyFrom(
            B.Vector3.TransformNormal(direction, tableMatrix).normalize(),
          );
          player.xr = mode === 'xr';
          player.gamepadMove = mode === 'gamepad' ? { x: 0, y: 1 } : null;
          player.touchMove = mode === 'touch' ? { x: 0, y: 1 } : null;
          player.update(
            mode === 'xr' ? 2.2 : 1,
            mode === 'xr' ? player.forward.clone() : null,
          );
          const local = B.Vector3.TransformCoordinates(
            player.position,
            tableInverse,
          );
          tableChecks.push({
            mode,
            axis,
            sign,
            distance: sign * local[axis],
            expected: half + 0.35,
          });
        }
      }
    }
    player.xr = false;
    player.gamepadMove = null;
    player.touchMove = null;
    const passageStart = new B.Vector3(2.7, 0, 2);
    player.position.copyFrom(
      B.Vector3.TransformCoordinates(passageStart, tableMatrix),
    );
    player.forward.copyFrom(
      B.Vector3.TransformNormal(new B.Vector3(0, 0, -1), tableMatrix),
    );
    player.gamepadMove = { x: 0, y: 1 };
    player.update(4 / 5.5);
    const passage = B.Vector3.TransformCoordinates(
      player.position,
      tableInverse,
    ).z;
    player.gamepadMove = null;
    room.focusJournal('machine');
    player.update(0);
    const eye = player.camera.position;
    const journalReachable = room.journal.keys.some((key) => {
      const target = key.getAbsolutePosition();
      const hit = player.scene.pickWithRay(
        new B.Ray(eye, target.subtract(eye).normalize(), 8),
        (mesh) => room.interactiveMesh(mesh),
      );
      return hit?.pickedMesh === key;
    });
    player.position.set(0, 0, 3);
    player.update(0);
    room.togglePhysical();
    const separateRoom = player.roomColliders !== room.colliders;
    room.togglePhysical();
    const restored = player.roomColliders === room.colliders;
    player.position.set(0, 0, -4);
    player.forward.set(0, 0, -1);
    player.pitch = -0.12;
    player.update(0);
    player.scene.render();
    return {
      colliders: room.physicalConsole.colliders.length,
      cabinets: cabinets.length,
      checks,
      tableChecks,
      passage,
      journalReachable,
      separateRoom,
      restored,
    };
  });
  for (const check of report.tableChecks)
    assert(
      Math.abs(check.distance - check.expected) < 0.001,
      JSON.stringify(check),
    );
  assert(
    Math.abs(report.passage + 2) < 0.001,
    'passage beside journal table stays open',
  );
  assert(
    report.journalReachable,
    'journal keys remain reachable from the focus position',
  );
  assert.equal(
    report.colliders,
    26,
    '9 wall cabinets, 8 cabinets + 8 sloped tops, and journal table',
  );
  assert.equal(report.cabinets, 17);
  for (const check of report.checks) {
    assert(
      check.z >= check.min - 0.001 && check.z < check.start - 0.1,
      JSON.stringify(check),
    );
    if ('reachable' in check)
      assert(check.reachable, `buttons still reachable: ${check.name}`);
  }
  assert(
    report.separateRoom && report.restored,
    'map switches replace the collision set',
  );
  assert.deepEqual(errors, []);
  if (process.env.SOLOAPP_COLLISION_SCREENSHOT)
    await page.screenshot({ path: process.env.SOLOAPP_COLLISION_SCREENSHOT });
  console.log(
    JSON.stringify({
      colliders: report.colliders,
      movementChecks: report.checks.length,
      tableChecks: report.tableChecks.length,
      journalReachable: report.journalReachable,
      modes: ['gamepad', 'touch', 'xr'],
      buttonsReachable: true,
      mapSwitch: true,
    }),
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
