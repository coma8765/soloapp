import { fetchAsset } from './asset-cache.js';
import { Terrain, WATER_RADIUS, clamp } from '../shared/world.js';
import { PlanetScene, FishView } from './scene.js';
import { Player } from './player.js';
import { Network } from './network.js';
import { NatureAudio } from './audio.js';
import { VoiceChat } from './voice.js';
import { XRView } from './xr.js';
import { Auth } from './auth.js';
import { AccountPanel } from './account-panel.js';
import { AvatarPreferences } from './avatar-catalog.js';
import { VisualQuality } from './quality.js';
import { Lobby } from './lobby.js';
import { GamepadControls } from './gamepad.js';
import { TouchControls } from './touch.js';
import { WhiteRoom } from './white-room.js';
import { LakeProfessors } from './lake-professors.js';
import { MarineLife } from './marine.js';
import { ProfessorRecorder } from './professor-recorder.js';
import { EngineerConversation } from './engineer-conversation.js';
import { Laboratory } from './laboratory.js';
import { ReactorRoom } from './reactor-room.js';
import { ShiftClock } from './shift-clock.js';
import { setupFullscreen } from './fullscreen.js';
import { keyboardRoomShortcut } from './physical-room-input.js';
import { keyboardQualityShortcut } from './quality-input.js';
const $ = (id) => document.getElementById(id);
async function start() {
  setupFullscreen($('fullscreen'), $('display-status'));
  const auth = new Auth();
  const preferences = new AvatarPreferences();
  const B = window.BABYLON;
  if (!B)
    throw Error(
      'Не удалось загрузить Babylon.js. Перезапустите сервер и обновите страницу.',
    );
  // VisualQuality owns display scaling; avoid applying devicePixelRatio twice on resize.
  const engine = new B.Engine(
    $('world'),
    true,
    { preserveDrawingBuffer: false, stencil: true },
    false,
  );
  const scene = new B.Scene(engine);
  scene.useRightHandedSystem = true;
  const response = await fetchAsset(
    new URL('../assets/world.json', import.meta.url),
  );
  if (!response.ok) throw Error('Данные мира недоступны');
  const data = await response.json();
  const terrain = new Terrain(data),
    planet = new PlanetScene(scene, data),
    player = new Player(scene, terrain, planet, $('world'), preferences.id),
    fish = new FishView(scene, data.fishProfiles),
    sound = new NatureAudio(terrain);
  const quality = new VisualQuality(engine, scene, player, $('quality'));
  const room = new WhiteRoom(scene, player, planet, fish);
  const reactor = new ReactorRoom(scene, terrain, planet, player, $('world'), {
    hints: $('reactor-hints'),
    exit: $('reactor-exit'),
    telemetry: $('reactor-telemetry'),
    dialog: $('reactor-dialog'),
    close: $('reactor-close'),
    title: $('reactor-dialog-title'),
    description: $('reactor-dialog-description'),
    source: $('reactor-source'),
    fields: $('reactor-fields'),
    actions: $('reactor-actions'),
    summary: $('reactor-summary'),
    team: $('reactor-team'),
  });
  if (
    location.hostname === '127.0.0.1' &&
    new URL(location.href).searchParams.has('reactor-test')
  )
    reactor.enter();
  const shiftClock = new ShiftClock(reactor, sound);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) shiftClock.update(Date.now(), false);
  });
  window.addEventListener('pagehide', () =>
    shiftClock.update(Date.now(), false),
  );
  const professorRecorder = new ProfessorRecorder(
    () => {
      $('professor-status').textContent =
        professorRecorder.error ||
        (professorRecorder.enabled
          ? professorRecorder.target === null
            ? 'Микрофон включён · вне зоны профессоров аудио не обрабатывается'
            : '● Запись у озера ' +
              (professorRecorder.target + 1) +
              ' · Whisper сервиса'
          : '');
    },
    () => auth.token,
  );
  const professors = new LakeProfessors(
    scene,
    terrain,
    planet,
    professorRecorder,
  );
  window.addEventListener('pagehide', () => professorRecorder.clear());
  document.addEventListener('visibilitychange', () => syncProfessorVoice());
  const laboratory = new Laboratory(scene, terrain, planet, professors);
  player.structures.push(laboratory);
  let engineer,
    network,
    lobby,
    xr,
    authPanel,
    signingIn = false,
    loggingOut = false;
  async function signIn(message = '') {
    if (authPanel?.settingsOpen) authPanel.closeSettings();
    document.exitPointerLock?.();
    const ready = auth.require(message);
    if (authPanel) authPanel.recenter = true;
    if (signingIn) return;
    signingIn = true;
    await ready;
    signingIn = false;
    lobby.activate();
  }
  const voice = new VoiceChat(() => {
    $('microphone').disabled = !voice.available;
    syncProfessorVoice();
    $('microphone').textContent = voice.pending
      ? 'Отменить запрос микрофона'
      : `N · Микрофон ${voice.enabled ? 'вкл' : 'выкл'}`;
    $('microphone').setAttribute('aria-pressed', String(voice.enabled));
    $('voice-playback').textContent = voice.muted
      ? 'Слышать участников'
      : 'Заглушить участников';
    $('voice-playback').setAttribute('aria-pressed', String(voice.muted));
    $('voice-status').textContent = voice.status;
    $('voice-unlock').hidden = !voice.playbackBlocked;
  });
  function syncProfessorVoice() {
    engineer?.update();
    void professorRecorder.setVoiceStream(
      auth.token && !room.serverId && !reactor.active && !document.hidden
        ? voice.stream
        : null,
    );
  }
  voice.localAllowed = true;
  voice.onChange();
  $('microphone').onclick = () => void voice.toggle();
  $('voice-playback').onclick = () => voice.togglePlayback();
  $('voice-unlock').onclick = () => voice.unlock();
  network = new Network(
    scene,
    player,
    fish,
    planet,
    auth,
    () => {
      lobby?.reset();
      void signIn('Сессия завершена. Прогулка продолжается локально.');
    },
    voice,
  );
  reactor.connectNetwork(network);
  engineer = new EngineerConversation(reactor, voice, () => auth.token);
  lobby = new Lobby(
    auth,
    network,
    async () => {
      let timeout;
      try {
        await Promise.race([
          Promise.all([scene.whenReadyAsync(), room.prepare()]),
          new Promise((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  Error('Подготовка графики заняла слишком много времени.'),
                ),
              30000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    },
    () => {
      void signIn('Сессия завершена. Войдите снова.');
    },
    {
      enter: (server, userId) => {
        professorRecorder.clear();
        room.enter(server, userId);
        voice.localAllowed = false;
        voice.onChange();
        if (authPanel) authPanel.recenter = true;
      },
      leave: () => {
        if (room.serverId) {
          room.leave();
          voice.localAllowed = true;
          voice.onChange();
          if (authPanel) authPanel.recenter = true;
        }
      },
    },
  );
  network.onRoomRequired = () => {
    lobby.show();
    void lobby.poll();
  };
  window.addEventListener('pagehide', () => network.disconnect());
  $('login').onclick = () => {
    void signIn();
  };
  $('logout').onclick = async () => {
    if (loggingOut) return;
    loggingOut = true;
    lobby.reset();
    professorRecorder.clear();
    const message = await auth.logout();
    loggingOut = false;
    void signIn(message);
  };
  let fps = 0;
  function info() {
    if (reactor.active) return reactor.statusText();
    if (room.serverId)
      return `БЕЛАЯ КОМНАТА\n${Math.round(fps)} FPS\n${network.status} · ID ${network.id || '—'}\nИгроки ${network.peers.size + 1} / 8\n${network.worldTransport} · RTT ${network.ping ?? '—'} мс\ntick ${network.worldTick}\nГолос · ${voice.enabled ? 'микрофон вкл' : 'микрофон выкл'} · X`;
    const depth = Math.max(0, WATER_RADIUS - player.position.length());
    return `MICRO / PLANET\n${Math.round(fps)} FPS · ${scene.getActiveMeshes().length} meshes\n${network.status} · ID ${network.id || '—'}\nИгроки ${network.peers.size + 1} / 8 · RTT ${network.ping ?? '—'} мс\nWebRTC RX ${network.rx}\nРыбы · ${network.worldTransport} · tick ${fish.sequence}\n${depth > 0.05 ? 'Глубина ' + depth.toFixed(1) + ' м' : 'На суше'}\nЗвук ${sound.muted ? 'выключен' : 'включён'}\nГолос · ${voice.enabled ? 'микрофон вкл' : 'микрофон выкл'} · X\nПрофессор · ${professorRecorder.enabled ? (professorRecorder.target === null ? 'вне зоны' : 'слушает') : professorRecorder.pending ? 'подключение' : 'ожидание'}${professorRecorder.error ? '\n' + professorRecorder.error : ''}${[
      ...network.remotes,
    ]
      .slice(0, 3)
      .map(
        ([id, r]) =>
          '\n#' +
          id +
          ' · ' +
          (
            Math.acos(
              clamp(
                B.Vector3.Dot(
                  player.position.normalizeToNew(),
                  r.node.position.normalizeToNew(),
                ),
                -1,
                1,
              ),
            ) * 38
          ).toFixed(1) +
          ' м',
      )
      .join('')}`;
  }
  xr = new XRView(scene, player, planet, $('vr'), info);
  xr.reactor = reactor;
  xr.toggleMicrophone = () => void voice.toggle();
  xr.onQualityChange = () => {
    $('vr-quality').textContent = xr.highQuality
      ? 'VR · детально'
      : 'VR · плавно';
    $('vr-quality').setAttribute('aria-pressed', String(xr.highQuality));
  };
  $('vr-quality').onclick = () => xr.toggleQuality();
  xr.onQualityChange();
  const toggleQuality = () => {
    if (document.hidden) return;
    if (xr.active) xr.toggleQuality();
    else quality.toggle();
  };
  $('quality').onclick = toggleQuality;
  window.addEventListener('keydown', (event) => {
    if (!keyboardQualityShortcut(event)) return;
    event.preventDefault();
    toggleQuality();
  });
  if (!auth.token) void signIn();
  else lobby.activate();
  if (reactor.active) {
    $('auth-dialog').close();
    lobby.visible = false;
  }
  $('explore').disabled = false;
  $('explore').textContent = 'Начать исследование ↗';
  const unlock = () => {
    voice.unlock();
    sound
      .start()
      .then(() => shiftClock.prepareAudio())
      .catch(() => {});
  };
  // Unlock on desktop/touch and on the click used to enter immersive VR.
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', (event) => {
    if (!event.repeat) unlock();
  });
  $('vr').addEventListener('click', unlock);
  const explore = () => {
    document.activeElement?.blur();
    if (player.overview) player.toggleOverview();
    unlock();
    if (player.touchEnabled) {
      $('auth-dialog').close();
      lobby.visible = false;
      authPanel?.sync();
    } else if (!xr.active)
      $('world')
        .requestPointerLock?.()
        ?.catch(() => {});
  };
  authPanel = new AccountPanel(
    scene,
    auth,
    player,
    $('world'),
    explore,
    preferences,
  );
  authPanel.lobby = lobby;
  xr.authPanel = authPanel;
  $('settings').onclick = () => authPanel.openSettings();
  const gamepad = new GamepadControls(
    player,
    authPanel,
    xr,
    $('gamepad-status'),
  );
  const touch = new TouchControls(player, authPanel, xr, $('world'), voice);
  const togglePhysical = () => {
    if (
      room.serverId ||
      lobby.countdown ||
      authPanel.settingsOpen ||
      document.hidden
    )
      return false;
    $('auth-dialog').close();
    lobby.visible = false;
    authPanel.controllerFocus = '';
    document.activeElement?.blur();
    const changed = reactor.togglePhysical();
    authPanel.sync();
    authPanel.recenter = true;
    if (xr.active) xr.sync();
    $('physical-room').setAttribute(
      'aria-pressed',
      String(!!reactor.physicalView),
    );
    return changed;
  };
  $('physical-room').onclick = togglePhysical;
  gamepad.togglePhysical = togglePhysical;
  gamepad.toggleQuality = toggleQuality;
  gamepad.activateWorld = () => reactor.activateCenter();
  xr.togglePhysical = togglePhysical;
  window.addEventListener('keydown', (event) => {
    if (keyboardRoomShortcut(event)) {
      event.preventDefault();
      togglePhysical();
    } else if (
      event.code === 'KeyE' &&
      !event.repeat &&
      player.inputEnabled &&
      !event.target.closest?.('input,textarea,select,button,[contenteditable]')
    ) {
      reactor.activateCenter();
    }
  });
  if (
    location.hostname === '127.0.0.1' &&
    new URL(location.href).searchParams.has('physical-test')
  ) {
    reactor.enter();
    togglePhysical();
  }
  const marine = new MarineLife(
    scene,
    terrain,
    planet,
    player,
    $('world'),
    authPanel,
    xr,
    gamepad,
  );
  xr.marine = marine;
  $('servers').onclick = () => {
    if (authPanel.settingsBusy || lobby.countdown) return;
    authPanel.closeSettings();
    document.exitPointerLock?.();
    lobby.show();
    authPanel.recenter = true;
  };
  $('explore').onclick = explore;
  $('auth-walk').onclick = explore;
  $('world').addEventListener('click', unlock);
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === $('world')) {
      $('auth-dialog').close();
      lobby.visible = false;
    } else if (!xr.active && !authPanel.settingsOpen && !reactor.active) {
      if (auth.token) lobby.show();
      else auth.require();
      authPanel.recenter = true;
    }
  });
  $('reconnect').onclick = () => {
    if (auth.token) {
      lobby.reconnect();
      authPanel.recenter = true;
    } else void signIn();
  };
  $('overview').onclick = () => {
    if (!xr.active && !reactor.active) player.toggleOverview();
  };
  $('view').onclick = () => {
    if (!xr.active && !player.overview) player.third = !player.third;
  };
  const mute = () => {
    sound.toggle();
    $('sound').textContent =
      'M · Звук ' + (sound.muted ? 'выключен' : 'включён');
  };
  $('sound').onclick = mute;
  window.addEventListener('keydown', (e) => {
    if (
      player.inputEnabled &&
      !e.target.closest?.('input,textarea,select,button,[contenteditable]') &&
      e.code === 'KeyM' &&
      !e.repeat
    )
      mute();
  });
  window.addEventListener('keydown', (e) => {
    if (
      player.inputEnabled &&
      !e.target.closest?.('input,textarea,select,button,[contenteditable]') &&
      e.code === 'KeyN' &&
      !e.repeat
    )
      void voice.toggle();
  });
  window.addEventListener('resize', () => engine.resize());
  // Deliberate read-only diagnostics for local smoke tests and troubleshooting.
  window.planetApp = {
    engine,
    scene,
    terrain,
    planet,
    player,
    fish,
    network,
    xr,
    sound,
    shiftClock,
    engineer,
    voice,
    authPanel,
    quality,
    lobby,
    gamepad,
    touch,
    room,
    reactor,
    professors,
    marine,
    professorRecorder,
    laboratory,
  };
  if (
    location.hostname === '127.0.0.1' &&
    reactor.physicalView &&
    new URL(location.href).searchParams.has('physical-audit')
  ) {
    const { runPhysicalSystemChecks } =
      await import('./physical-system-checks.js');
    window.physicalSystemChecks = runPhysicalSystemChecks(window.planetApp);
  }
  if (
    location.hostname === '127.0.0.1' &&
    new URL(location.href).searchParams.has('reactor-audit')
  ) {
    const { startRbmkPhysicalAudit } = await import('./rbmk-physical-audit.js');
    window.rbmkPhysicalAudit = startRbmkPhysicalAudit(window.planetApp);
  }
  if (
    location.hostname === '127.0.0.1' &&
    reactor.active &&
    new URL(location.href).searchParams.has('reactor-journal-audit')
  ) {
    const { startRbmkJournalAudit } = await import('./rbmk-journal-audit.js');
    startRbmkJournalAudit(window.planetApp);
  }
  if (
    location.hostname === '127.0.0.1' &&
    new URL(location.href).searchParams.has('shift-clock-audit')
  ) {
    const { startShiftClockChecks } = await import('./shift-clock-checks.js');
    startShiftClockChecks(window.planetApp);
  }
  let previous = performance.now(),
    hudAt = 0,
    reactorWasActive = false;
  if (
    location.hostname === '127.0.0.1' &&
    new URL(location.href).searchParams.has('door-audit')
  ) {
    const { runDoorChecks } = await import('./door-checks.js');
    window.doorChecks = runDoorChecks(window.planetApp);
  }
  engine.runRenderLoop(() => {
    const now = performance.now(),
      dt = Math.min((now - previous) / 1000, 0.05);
    previous = now;
    player.inputEnabled =
      !lobby.countdown && !authPanel.settingsOpen && !reactor.uiOpen;
    if (lobby.countdown) {
      player.keys.clear();
      player.speed = 0;
      if (document.pointerLockElement) document.exitPointerLock?.();
    }
    authPanel.sync();
    gamepad.update(dt);
    touch.update();
    player.update(dt, xr.input());
    reactor.update(dt);
    shiftClock.update(
      Date.now(),
      !document.hidden &&
        (!xr.active ||
          xr.helper.sessionManager.session.visibilityState === 'visible'),
    );
    reactor.instructor.setAnnouncementActive(!!shiftClock.source);
    if (reactor.active !== reactorWasActive) {
      reactorWasActive = reactor.active;
      professorRecorder.clear();
      syncProfessorVoice();
      authPanel.recenter = true;
    }
    xr.sync();
    network.update(dt);
    if (!room.serverId && !reactor.active) fish.update(dt);
    if (!reactor.active) planet.updateActor('local', player.position, dt);
    authPanel.sync();
    document.body.classList.toggle(
      'in-room',
      !!room.serverId || reactor.active,
    );
    document.body.classList.toggle('counting-down', lobby.countdown);
    document.body.classList.toggle(
      'lobby-open',
      !!auth.token && authPanel.visible,
    );
    $('servers').hidden = !auth.token;
    const camera = scene.activeCamera;
    camera.computeWorldMatrix();
    planet.update(dt, camera);
    professors.update(dt, player, camera, !room.serverId && !reactor.active);
    if (!reactor.active) {
      marine.update(dt);
      laboratory.update(player.position);
    }
    const underwater =
      !room.serverId &&
      !reactor.active &&
      !player.overview &&
      camera.globalPosition.length() < WATER_RADIUS;
    sound.update(player, underwater);
    $('underwater').style.display = underwater ? 'block' : 'none';
    document.body.classList.toggle(
      'playing',
      (document.pointerLockElement === $('world') ||
        (gamepad.active && !authPanel.visible) ||
        touch.active) &&
        !player.overview,
    );
    document.body.classList.toggle('overview', player.overview);
    if (now > hudAt) {
      hudAt = now + 250;
      fps = engine.getFps();
      $('connection').textContent =
        network.status + (network.id ? ' · #' + network.id : '');
      $('overview').disabled = reactor.active;
      $('overview').querySelector('span').textContent = reactor.active
        ? reactor.physicalView
          ? 'Физическая система'
          : 'Учебный БЩУ'
        : room.serverId
          ? 'Обзор комнаты'
          : 'Вся планета';
      $('world').setAttribute(
        'aria-label',
        reactor.active
          ? reactor.physicalView
            ? 'Комната физических процессов ВВЭР-1200'
            : 'Учебный блочный щит управления ВВЭР-1200'
          : room.serverId
            ? 'Белая комната'
            : 'Трёхмерная микропланета',
      );
      if (auth.token && lobby.current?.state !== 'running')
        $('connection').textContent = lobby.countdown
          ? 'Переход через ' + lobby.secondsLeft + ' с'
          : network.status + ' · общая планета';
      $('stats').textContent = !auth.token
        ? `${Math.round(fps)} FPS · только вы\nСинхронизация выключена\nВойдите, чтобы встретить других игроков`
        : `${Math.round(fps)} FPS · ${network.peers.size + 1} / 8 игроков\nPing (RTT) · ${now - network.pingAt < 5000 ? (network.ping ?? '—') : '—'} мс\nWebRTC RX · ${network.rx}\nРыбы · ${network.worldTransport}${fish.sequence >= 0 ? ' · 48' : ' · ожидание'}\n${fish.sequence >= 0 ? 'Снимок ' + fish.sequence : ''}`;
      $('reconnect').textContent = auth.token
        ? 'Переподключиться ↗'
        : 'Войти в общий мир ↗';
      if (auth.token && lobby.current?.state !== 'running')
        $('stats').textContent =
          `${Math.round(fps)} FPS · общая планета\n${network.peers.size + 1} / 8 игроков · RTT ${network.ping ?? '—'} мс\n${network.worldTransport} · tick ${network.worldTick}${lobby.current ? '\nКомната: ' + lobby.current.member_count + ' / 8 участников' : ''}`;
      if (room.serverId)
        $('stats').textContent =
          `${Math.round(fps)} FPS · белая комната\n${network.peers.size + 1} / 8 игроков · RTT ${network.ping ?? '—'} мс\n${network.worldTransport} · tick ${network.worldTick}`;
      if (reactor.active)
        $('stats').textContent =
          `${Math.round(fps)} FPS · ${reactor.physicalView ? 'физическая система' : 'учебный БЩУ ВВЭР-1200'}\nОбщая детерминированная модель\nКоманда · ${reactor.teamSize()} участ.`;
      $('players').textContent = reactor.active
        ? ''
        : [...network.remotes]
            .map(([id, r]) => {
              const dot = B.Vector3.Dot(
                  player.position.normalizeToNew(),
                  r.node.position.normalizeToNew(),
                ),
                angle = Math.acos(clamp(dot, -1, 1)),
                distance = angle * 38,
                peer = network.peers.get(id),
                notes = [];
              if (!room.serverId && angle > 0.32) notes.push('за горизонтом');
              if (!room.serverId && r.node.position.length() < WATER_RADIUS)
                notes.push('в воде');
              if (
                B.Vector3.Dot(
                  r.node.position.subtract(player.position),
                  player.forward,
                ) < 0
              )
                notes.push('сзади');
              if (now - r.last > 3000) notes.push('нет свежей позиции');
              return `#${id} · ${(room.serverId ? B.Vector3.Distance(player.position, r.node.position) : distance).toFixed(1)} м · ${now - peer?.pingAt < 5000 ? (peer?.ping ?? '—') : '—'} мс${notes.length ? '\n' + notes.join(' · ') : ''}`;
            })
            .concat(
              [...network.peers.keys()]
                .filter((id) => !network.remotes.has(id))
                .map((id) => '#' + id + ' · ожидание позиции'),
            )
            .join('\n');
      const depth = Math.max(0, WATER_RADIUS - player.position.length());
      $('location').textContent = player.overview
        ? 'Вся планета · Tab — вернуться'
        : depth > 0.05
          ? `${underwater ? 'Под водой' : 'В воде'} · глубина ${depth.toFixed(1)} м`
          : `${player.third ? 'Третье лицо' : 'Первое лицо'} · озеро впереди`;
      if (room.serverId)
        $('location').textContent = player.overview
          ? 'Обзор комнаты · Tab — вернуться'
          : `Белая комната · ${player.third ? 'третье' : 'первое'} лицо`;
      if (reactor.active)
        $('location').textContent = reactor.physicalView
          ? 'Физическая система · P / L1+R1 / оба grip — в БЩУ · E / A / триггер — нажать'
          : 'Учебный БЩУ · P / L1+R1 / оба grip — физическая система';
      $('physical-room').setAttribute(
        'aria-pressed',
        String(!!reactor.physicalView),
      );
      $('physical-room').textContent = reactor.physicalView
        ? 'P · Вернуться в БЩУ'
        : 'P · Физическая система';
      $('physical-room').disabled =
        !!room.serverId || !!lobby.countdown || authPanel.settingsOpen;
    }
    scene.render();
  });
}
start().catch((error) => {
  console.error(error);
  $('fatal').hidden = false;
  $('fatal').textContent = 'Не удалось запустить мир\n' + error.message;
  $('welcome').hidden = true;
});
