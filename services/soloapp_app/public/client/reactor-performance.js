// Opt-in localhost diagnostic. Measures a warm room without changing its model.
export function measureReactorPerformance(app) {
  const B = window.BABYLON;
  const { scene, engine, reactor } = app;
  const output = document.createElement('pre');
  output.id = 'reactor-performance';
  output.style.cssText =
    'position:fixed;top:100px;left:12px;z-index:2000;background:#102b30;color:white;padding:12px;font:12px monospace;pointer-events:none';
  output.textContent = 'Performance: warming up…';
  document.body.append(output);
  const instrumentation = new B.SceneInstrumentation(scene);
  instrumentation.captureFrameTime = true;
  instrumentation.captureActiveMeshesEvaluationTime = true;
  const timings = {};
  const restore = [];
  let recording = false;
  for (const [name, object, method] of [
    ['model', reactor.model, 'step'],
    ['console', reactor.physicalConsole, 'sync'],
    ['journal', reactor.journal, 'draw'],
    ['hover', reactor, 'updateHover'],
    ['workers', reactor.workers, 'update'],
  ]) {
    const original = object[method];
    timings[name] = 0;
    object[method] = function (...args) {
      const start = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        if (recording) timings[name] += performance.now() - start;
      }
    };
    restore.push(() => (object[method] = original));
  }
  let uploads = 0;
  const update = B.DynamicTexture.prototype.update;
  B.DynamicTexture.prototype.update = function (...args) {
    if (recording) uploads++;
    return update.apply(this, args);
  };
  restore.push(() => (B.DynamicTexture.prototype.update = update));
  const frames = [];
  let calls = 0;
  let renderMs = 0;
  let evaluationMs = 0;
  const start = performance.now();
  let previous = 0;
  const observer = scene.onAfterRenderObservable.add(() => {
    const now = performance.now();
    if (now - start < 5000) return;
    recording = true;
    if (previous) {
      frames.push(now - previous);
      calls += instrumentation.drawCallsCounter.current;
      renderMs += instrumentation.frameTimeCounter.current;
      evaluationMs += instrumentation.activeMeshesEvaluationTimeCounter.current;
    }
    previous = now;
    if (now - start < 13000 || !frames.length) return;
    recording = false;
    scene.onAfterRenderObservable.remove(observer);
    instrumentation.dispose();
    restore.forEach((fn) => fn());
    const duration = frames.reduce((sum, ms) => sum + ms, 0);
    const round = (n) => Math.round(n * 100) / 100;
    frames.sort((a, b) => a - b);
    const report = {
      quality: app.quality.high ? 'high' : 'low',
      resolution: [engine.getRenderWidth(), engine.getRenderHeight()],
      fps: round((1000 * frames.length) / duration),
      frameP95Ms: round(frames[Math.floor(frames.length * 0.95)]),
      drawCalls: round(calls / frames.length),
      sceneRenderMs: round(renderMs / frames.length),
      meshEvaluationMs: round(evaluationMs / frames.length),
      textureUploadsPerSecond: round((1000 * uploads) / duration),
      cpuMsPerFrame: Object.fromEntries(
        Object.entries(timings).map(([key, ms]) => [
          key,
          round(ms / frames.length),
        ]),
      ),
      roomMeshes: reactor.root.getChildMeshes().length,
      activeMeshes: scene.getActiveMeshes().length,
    };
    output.textContent = JSON.stringify(report, null, 2);
    output.dataset.complete = 'true';
  });
}
