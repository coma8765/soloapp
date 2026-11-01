// Compile lake_professors_test first and pass SOLOAPP_PROFESSOR_AUTHORITY.
// Real C++ authority + Network handlers + Babylon models in two browsers.
// Synthetic transport and HTTP answers; does not exercise live authentication/STT/TTS/PostgreSQL.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname } from 'node:path';
const { chromium } = await import(
  process.env.SOLOAPP_PLAYWRIGHT_MODULE || 'playwright'
);
const binary = process.env.SOLOAPP_PROFESSOR_AUTHORITY;
assert(
  binary,
  'Set SOLOAPP_PROFESSOR_AUTHORITY to the compiled lake_professors_test',
);
const authority = spawn(binary, ['--wire'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
const lines = createInterface({ input: authority.stdout })[
  Symbol.asyncIterator
]();
const root = fileURLToPath(new URL('../public/', import.meta.url));
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/')
    return res
      .setHeader('Content-Type', 'text/html')
      .end(
        '<canvas id="world" width="640" height="480"></canvas><script src="/vendor/babylon.js"></script><script src="/vendor/babylonjs.loaders.min.js"></script>',
      );
  const file = resolve(root, '.' + path);
  if (!file.startsWith(resolve(root) + sep)) return res.writeHead(403).end();
  try {
    res.setHeader(
      'Content-Type',
      { '.js': 'text/javascript', '.json': 'application/json' }[
        extname(file)
      ] || 'application/octet-stream',
    );
    res.end(await readFile(file));
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
  const pages = [await browser.newPage(), await browser.newPage()];
  const errors = [];
  for (const [index, page] of pages.entries()) {
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async (index) => {
      const [{ LakeProfessors }, { LakeProfessorSync }, { Network }] =
        await Promise.all([
          import('/client/lake-professors.js'),
          import('/client/lake-professor-sync.js'),
          import('/client/network.js'),
        ]);
      const B = window.BABYLON;
      const engine = new B.Engine(document.querySelector('canvas'), true);
      const scene = new B.Scene(engine);
      scene.useRightHandedSystem = true;
      const camera = new B.FreeCamera(
        'camera',
        new B.Vector3(index ? -3 : 3, 2, 4),
        scene,
      );
      camera.setTarget(B.Vector3.Zero());
      camera.computeWorldMatrix();
      new B.HemisphericLight('light', B.Vector3.Up(), scene);
      const player = {
        position: new B.Vector3(index ? -3 : 3, 0, 2),
        worldMap: 'planet',
        state(sequence) {
          return {
            type: 'state',
            sequence,
            map: this.worldMap,
            professorTarget: this.professorTarget,
            position: this.position.asArray(),
            rotation: [0, 0, 0, 1],
            pitch: 0,
            speed: 0,
            avatarId: 'male',
          };
        },
      };
      const recorder = {
        enabled: !!index,
        pending: false,
        tracks: new Map(),
        setTarget(id) {
          this.target = id;
        },
        record() {
          return {
            text: 'different local text ' + index,
            answer: 'local answer',
          };
        },
      };
      const network = new Network(
        scene,
        player,
        {},
        { actors: new Map() },
        { token: 'test' },
        () => {},
      );
      const sync = new LakeProfessorSync(network, () => window.localTime);
      window.localTime = index ? 80000 : 100;
      const professors = Object.assign(
        Object.create(LakeProfessors.prototype),
        {
          scene,
          recorder,
          sync,
          guides: [],
          sites: [],
          visible: true,
          nearest: null,
        },
      );
      const site = {
        id: 0,
        position: [0, 0, 0],
        forward: [0, 0, -1],
        up: [0, 1, 0],
        active: true,
        loading: true,
      };
      professors.sites = [site];
      if (!(await professors.loadGuide(site))) throw professors.error;
      window.outgoing = [];
      network.socket = {
        readyState: WebSocket.OPEN,
        send: (raw) => outgoing.push(JSON.parse(raw)),
      };
      network.message({
        type: 'welcome',
        id: index + 1,
        user_id: String(index + 1),
        peers: [],
        world_protocol: 2,
        professor_protocol: 1,
        rtc_config: { iceServers: [] },
      });
      Object.assign(window, {
        network,
        sync,
        professors,
        player,
        scene,
        camera,
      });
      professors.update(0.1, player, camera);
      window.httpCalls = 0;
      window.startQuestion = () => {
        window.question = sync
          .request(
            0,
            () => {
              window.httpCalls++;
              return new Promise((resolve) => {
                window.answerQuestion = () =>
                  resolve({
                    transcript: 'Как устроено озеро?',
                    answer: 'Это небольшой водоём на планете.',
                    audio_base64: '',
                  });
              });
            },
            new AbortController().signal,
          )
          .then(
            () => {
              window.completed = true;
            },
            (e) => {
              window.questionError = e.message;
            },
          );
      };
      scene.render();
    }, index);
  }
  let now = 10000;
  const pump = async () => {
    const players = [],
      messages = [];
    for (const [index, page] of pages.entries()) {
      const { state, outgoing } = await page.evaluate(() => ({
        state: player.state(1),
        outgoing: window.outgoing.splice(0),
      }));
      players.push({ id: index + 1, user_id: String(index + 1), state });
      for (const m of outgoing)
        if (m.type === 'professor_command')
          messages.push({ ...m, from: index + 1, user_id: String(index + 1) });
    }
    authority.stdin.write(JSON.stringify({ players, messages, now }) + '\n');
    const line = await lines.next();
    assert(!line.done, 'authority exited unexpectedly');
    const frame = JSON.parse(line.value);
    for (const [index, page] of pages.entries())
      await page.evaluate(
        ({ frame, id }) => {
          network.message(frame.state);
          for (const reply of frame.replies)
            if (reply.to === id) network.message(reply);
          professors.update(0.1, player, camera);
          scene.render();
        },
        { frame, id: index + 1 },
      );
    return frame;
  };
  const visual = async (page) =>
    page.evaluate(() => {
      professors.update(0.1, player, camera);
      const guide = professors.guides[0];
      return {
        text: guide.state,
        pixels: guide.texture.getContext().canvas.toDataURL(),
        rotation: guide.root.rotationQuaternion.asArray(),
        nod: guide.facing.rotation.x,
        answer: sync.record(0).answer,
      };
    });
  await pump();
  assert.deepEqual(
    await visual(pages[0]),
    await visual(pages[1]),
    'different viewpoints and microphone states share a display and facing direction',
  );
  for (const page of pages) await page.evaluate(() => startQuestion());
  await pump();
  assert.equal(await pages[0].evaluate(() => httpCalls), 1);
  assert.equal(await pages[1].evaluate(() => httpCalls), 0);
  assert.match(
    await pages[1].evaluate(() => questionError),
    /другому участнику/,
  );
  assert.deepEqual(
    await visual(pages[0]),
    await visual(pages[1]),
    'thinking status shared',
  );
  await pages[0].evaluate(() => answerQuestion());
  await pump();
  now += 700;
  await pump();
  const answer = await visual(pages[0]);
  assert.equal(answer.answer, 'Это небольшой водоём на планете.');
  assert.notEqual(answer.nod, 0);
  assert.deepEqual(
    answer,
    await visual(pages[1]),
    'same canvas pixels, orientation and answer animation',
  );
  // A visitor exactly on the professor's vertical axis needs a deterministic fallback.
  await pages[0].evaluate(() => player.position.set(0, 1, 0));
  await pump();
  assert.deepEqual(
    await visual(pages[0]),
    await visual(pages[1]),
    'degenerate facing direction is shared',
  );
  // Late join/reset must recover the existing answer and timeline, not restart animation.
  await pages[1].evaluate(() => {
    sync.receive({ type: 'professor_disconnect' });
    network.message({
      type: 'welcome',
      id: 2,
      user_id: '2',
      peers: [],
      world_protocol: 2,
      professor_protocol: 1,
      rtc_config: { iceServers: [] },
    });
    localTime += 100000;
  });
  await pump();
  assert.deepEqual(
    await visual(pages[0]),
    await visual(pages[1]),
    'late join restores the same animated display',
  );
  // Speaker leaves; the professor faces the remaining participant on both clients.
  await pages[0].evaluate(() => player.position.set(20, 0, 20));
  await pages[0].evaluate(() => professors.update(0.1, player, camera));
  await pump();
  assert.deepEqual(
    await visual(pages[0]),
    await visual(pages[1]),
    'shared focus follows remaining visitor',
  );
  now += 100000;
  await pump();
  assert.equal((await visual(pages[1])).nod, 0);
  assert.equal((await visual(pages[1])).answer, answer.answer);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: two Chromium clients, C++ authority, shared board pixels/rotation/animation, concurrent questions, late join, speaker departure; no page errors',
  );
} finally {
  await browser?.close();
  authority.stdin.end();
  authority.kill();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
