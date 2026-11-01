// Local-only browser checks against real Babylon geometry and room lifecycle.
export function runPhysicalSystemChecks(app) {
  const { reactor, player, scene } = app;
  const B = window.BABYLON;
  const results = [];
  const check = (name, condition) => {
    results.push({ name, passed: !!condition });
    if (!condition) throw Error(name);
  };
  const snapshot = reactor.model.snapshot();
  try {
    check(
      'physical room is active',
      reactor.physicalView && reactor.physicalRoom.root.isEnabled(),
    );
    check('control room geometry is hidden', !reactor.root.isEnabled());
    const room = reactor.physicalRoom;
    let reachable = 0;
    for (const mesh of room.controls) {
      mesh.computeWorldMatrix(true);
      const center = mesh.getAbsolutePosition();
      const ray = new B.Ray(
        center.add(new B.Vector3(0, 0, 1)),
        new B.Vector3(0, 0, -1),
        2,
      );
      const pick = scene.pickWithRay(ray, (candidate) =>
        reactor.interactiveMesh(candidate),
      );
      if (pick?.pickedMesh === mesh) reachable++;
    }
    check(
      'every 3D button has a reachable ray target',
      reachable === room.controls.length,
    );
    const rodButton = room.controls.find(
      (m) =>
        m.metadata.physicalSystem.control === 'manualRodInsertion' &&
        m.metadata.physicalSystem.delta === 1,
    );
    room.lastActivation = 0;
    check(
      '3D input changes a command',
      room.activate(rodButton) &&
        reactor.model.controls.manualRodInsertion === 50,
    );
    check(
      'command does not teleport the rod',
      reactor.model.rods.manualRodInsertion ===
        snapshot.rods.manualRodInsertion,
    );
    reactor.model.step(0.1);
    check(
      'actual rod travels over time',
      reactor.model.rods.manualRodInsertion > snapshot.rods.manualRodInsertion,
    );
    const beforeSwitch = reactor.model.snapshot();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP' }));
    check(
      'P enters the control room',
      !reactor.physicalView && reactor.root.isEnabled(),
    );
    check(
      'switch preserves the model',
      JSON.stringify(beforeSwitch) === JSON.stringify(reactor.model.snapshot()),
    );
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP' }));
    check(
      'P returns to the physical room',
      reactor.physicalView && room.root.isEnabled(),
    );
    player.toggleOverview();
    check('planet overview cannot replace a room camera', !player.overview);
    check(
      'room owns a separate pose namespace',
      player.worldMap === 'rbmk-physical-system',
    );
  } catch (error) {
    results.push({ name: error.message, passed: false });
  } finally {
    reactor.model.restore(snapshot);
    if (!reactor.physicalView) reactor.togglePhysical();
    reactor.physicalRoom.update(0, true);
  }
  const output = document.createElement('pre');
  output.id = 'physical-system-checks';
  output.setAttribute('role', 'status');
  output.style.cssText =
    'position:fixed;left:12px;top:130px;max-width:580px;background:#102b30;color:#e1f5e8;padding:14px;z-index:1000;font:12px monospace;pointer-events:none';
  output.textContent = results
    .map((r) => `${r.passed ? 'PASS' : 'FAIL'} ${r.name}`)
    .join('\n');
  document.body.append(output);
  return results;
}
