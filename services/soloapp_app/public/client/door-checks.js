// Local-only geometry/lifecycle check. Uses the real Player movement path, not teleport callbacks.
export function runDoorChecks(app) {
  const { reactor, player, network } = app;
  const B = window.BABYLON;
  const results = [];
  const originalClock = reactor.door.sync.clock;
  let time = originalClock();
  const step = (dt) => {
    time += dt * 1000;
    reactor.update(dt);
  };
  const output = document.createElement('pre');
  output.id = 'door-check-results';
  Object.assign(output.style, {
    position: 'fixed',
    left: '16px',
    top: '150px',
    zIndex: '30',
    padding: '16px',
    background: '#102526',
    color: 'white',
    maxWidth: '70vw',
    whiteSpace: 'pre-wrap',
  });
  document.body.append(output);
  const check = (name, value) => {
    results.push(`${value ? 'PASS' : 'FAIL'}: ${name}`);
    output.textContent = results.join('\n');
    if (!value) throw Error(name);
  };
  try {
    check(
      'local test does not use an authenticated world',
      !network.auth.token,
    );
    reactor.door.sync.clock = () => time;
    if (reactor.active) reactor.leave();
    for (let i = 0; i < 40; i++) step(0.05);
    const root = reactor.portalRoot;
    const outside = B.Vector3.TransformCoordinates(
      new B.Vector3(0, 0, 3.3),
      root.computeWorldMatrix(true),
    );
    outside
      .normalize()
      .scaleInPlace(reactor.terrain.radius(outside.asArray()) + 0.12);
    player.setMap('planet', outside.asArray());
    player.forward.copyFrom(
      B.Vector3.TransformNormal(new B.Vector3(0, 0, -1), root.getWorldMatrix()),
    );
    const walkUntil = (destination) => {
      for (let i = 0; i < 240 && player.worldMap !== destination; i++) {
        player.inputEnabled = true;
        player.gamepadMove = { x: 0, y: 1 };
        player.update(1 / 60);
        step(1 / 60);
      }
      player.gamepadMove = null;
    };
    walkUntil('rbmk-training-room');
    check(
      'walking through planet doorway enters the control room',
      reactor.active && player.worldMap === 'rbmk-training-room',
    );
    check('passage closes the shared door', !reactor.door.sync.open);
    for (let i = 0; i < 40; i++) step(0.05);
    check(
      'arrival cannot bounce back or reopen the door',
      reactor.active && !reactor.door.sync.open,
    );
    check(
      'both door leaves animate closed',
      reactor.door.views.every((v) =>
        v.leaves.every(
          (leaf) => Math.abs(Math.abs(leaf.node.position.x) - 0.55) < 0.001,
        ),
      ),
    );
    player.forward.set(0, 0, 1);
    walkUntil('planet');
    check(
      'walking through room doorway returns to planet',
      !reactor.active && player.worldMap === 'planet',
    );
    for (let i = 0; i < 40; i++) step(0.05);
    check(
      'return closes the same door and stays on the planet',
      !reactor.door.sync.open && !reactor.active,
    );
    // Finish facing the visible planet door for screenshot review.
    player.forward.copyFrom(
      B.Vector3.TransformNormal(new B.Vector3(0, 0, -1), root.getWorldMatrix()),
    );
    player.update(0);
    return { passed: true, results };
  } catch (error) {
    output.textContent += `\nERROR: ${error.message}`;
    return { passed: false, results, error: error.message };
  } finally {
    reactor.door.sync.clock = originalClock;
    reactor.door.sync.retryAfter = originalClock();
    player.gamepadMove = null;
  }
}
