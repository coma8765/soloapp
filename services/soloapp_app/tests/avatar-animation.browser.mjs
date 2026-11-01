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
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/animation-test.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<canvas id="canvas" width="400" height="500"></canvas><script src="/vendor/babylon.js"></script><script src="/vendor/babylonjs.loaders.min.js"></script>',
    }),
  );
  await page.goto(
    `http://127.0.0.1:${server.address().port}/animation-test.html`,
  );
  const report = await page.evaluate(async () => {
    const { LocalAvatar } = await import('/client/local-avatar.js');
    const B = BABYLON;
    const engine = new B.Engine(document.getElementById('canvas'), true);
    const scene = new B.Scene(engine);
    scene.useRightHandedSystem = true;
    const camera = new B.FreeCamera('camera', new B.Vector3(0, 1, -3), scene);
    camera.setTarget(new B.Vector3(0, 1, 0));
    new B.HemisphericLight('light', new B.Vector3(0, 1, -1), scene);
    const avatar = new LocalAvatar(scene);
    const models = [];
    for (const id of ['scientist', 'male', 'female']) {
      if (!(await avatar.select(id))) throw Error(String(avatar.error));
      avatar.update(0, 0, 0, true);
      await scene.whenReadyAsync();
      scene.render();
      const root = avatar.root.position.asArray();
      const rootRotation = avatar.root.rotationQuaternion.asArray();
      const samples = [];
      for (let frame = 0; frame < 240; frame++) {
        avatar.update(1 / 60, 0.7, 0, true);
        // Foot positions prove that the leg actually lifts; rotating a bone
        // around its own length would change its quaternion but fail this check.
        const position = (name) => {
          const node = avatar.joints.get(name).node;
          node.computeWorldMatrix(true);
          return node.getAbsolutePosition().asArray();
        };
        const angle = (name) => {
          const joint = avatar.joints.get(name);
          return (
            2 *
            Math.acos(
              Math.min(
                1,
                Math.abs(
                  B.Quaternion.Dot(joint.rest, joint.node.rotationQuaternion),
                ),
              ),
            )
          );
        };
        samples.push({
          left: position('foot_l'),
          right: position('foot_r'),
          hand: position('hand_l'),
          knee: angle('calf_l'),
          elbow: angle('lowerarm_l'),
          grounded: Math.min(
            ...avatar.groundReferences.map(({ node, y }) => {
              node.computeWorldMatrix(true);
              return node.getAbsolutePosition().y - y;
            }),
          ),
        });
      }
      for (let frame = 0; frame < 120; frame++)
        avatar.update(1 / 60, 0, 0, true);
      const range = (values) => Math.max(...values) - Math.min(...values);
      models.push({
        id,
        rootUnchanged:
          JSON.stringify(root) ===
            JSON.stringify(avatar.root.position.asArray()) &&
          JSON.stringify(rootRotation) ===
            JSON.stringify(avatar.root.rotationQuaternion.asArray()),
        footLift: range(samples.map((s) => s.left[1])),
        handSwing: range(samples.map((s) => s.hand[2])),
        kneeFlex: range(samples.map((s) => s.knee)),
        elbowFlex: range(samples.map((s) => s.elbow)),
        alternating:
          samples.some((s) => s.left[1] > s.right[1] + 0.06) &&
          samples.some((s) => s.right[1] > s.left[1] + 0.06),
        groundError: Math.max(...samples.map((s) => Math.abs(s.grounded))),
        stoppedStride: avatar.stride,
      });
    }
    // Switching the model mid-step must measure its neutral foot height, and
    // grounding must use local up even when the player's planet frame is tilted.
    avatar.update(0.1, 3, 0, true);
    avatar.root.position.set(2, 7, -3);
    avatar.root.rotationQuaternion.copyFrom(
      B.Quaternion.RotationYawPitchRoll(0.4, 0.6, -0.2),
    );
    await avatar.select('scientist');
    const other = new LocalAvatar(scene, 'scientist');
    await other.ready;
    const neutralGround = avatar.groundReferences.every(
      (reference, index) =>
        Math.abs(reference.y - other.groundReferences[index].y) < 0.001,
    );
    avatar.update(0.05, 0.7, 0, true);
    const inverseRoot = avatar.root.computeWorldMatrix(true).clone().invert();
    const tiltedGround = Math.min(
      ...avatar.groundReferences.map(({ node, y }) => {
        node.computeWorldMatrix(true);
        return (
          B.Vector3.TransformCoordinates(
            node.getAbsolutePosition(),
            inverseRoot,
          ).y - y
        );
      }),
    );
    avatar.setSpeaking(true);
    const mouth = [];
    for (let i = 0; i < 120; i++) {
      avatar.update(1 / 60, 0, 0, true);
      mouth.push(avatar.mouthTargets.map((target) => target.influence));
    }
    const independent = other.mouthTargets.every(
      (target) => target.influence === 0,
    );
    avatar.setSpeaking(false);
    const closedImmediately = avatar.mouthTargets.every(
      (target) => target.influence === 0,
    );
    avatar.setSpeaking(true);
    avatar.update(0.05, 0, 0, true);
    avatar.update(0, 0, 0, false);
    const hiddenClosed =
      !avatar.speaking &&
      avatar.mouthTargets.every((target) => target.influence === 0);
    await avatar.select('uraraka');
    avatar.setSpeaking(true);
    avatar.update(0.016, 0.7, 0, true);
    const staticPreserved = !avatar.joints && avatar.mouthTargets.length === 0;
    engine.dispose();
    return {
      models,
      mouth,
      neutralGround,
      tiltedGround,
      independent,
      closedImmediately,
      hiddenClosed,
      staticPreserved,
    };
  });
  for (const model of report.models) {
    assert(model.rootUnchanged && model.alternating, JSON.stringify(model));
    assert(
      model.footLift > 0.08 && model.handSwing > 0.08,
      JSON.stringify(model),
    );
    assert(
      model.kneeFlex > 0.5 && model.elbowFlex > 0.1,
      JSON.stringify(model),
    );
    assert(
      model.groundError < 0.002 && model.stoppedStride < 0.001,
      JSON.stringify(model),
    );
  }
  assert(
    report.mouth.every(
      (weights) =>
        weights.length === 4 &&
        weights.every((w) => w >= 0 && w <= 1 && w === weights[0]),
    ),
  );
  assert(report.mouth.some((weights) => weights[0] > 0.6));
  assert(report.mouth.filter((weights) => weights[0] === 0).length > 20);
  assert(report.neutralGround && Math.abs(report.tiltedGround) < 0.002);
  assert(
    report.independent &&
      report.closedImmediately &&
      report.hiddenClosed &&
      report.staticPreserved,
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: actual scientist/male/female rigs, alternating knees, elbow and hand motion, foot grounding, unchanged collision root, stop blending, independent jaw morphs, speech closures and static avatar',
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
