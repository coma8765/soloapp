import {
  AvatarPreferences,
  AVATARS,
  AVATAR_STORAGE_KEY,
} from './avatar-catalog.js';
import { Network } from './network.js';
import { LocalAvatar } from './local-avatar.js';
import { AccountPanel } from './account-panel.js';
import { XRView } from './xr.js';
import { RoomShortcut } from './physical-room-input.js';
const B = window.BABYLON;
const output = document.getElementById('results');
function check(condition, message) {
  if (!condition) throw Error(message);
  output.textContent += '\nPASS · ' + message;
}
const memory = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
};

try {
  // Use the real accessible forms; tests never change this origin's stored login
  // or avatar preference and never create accounts on the server.
  const html = await fetch('/').then((response) => response.text());
  const template = new DOMParser().parseFromString(html, 'text/html');
  for (const id of ['auth-dialog', 'settings-dialog'])
    document.getElementById('fixtures').append(template.getElementById(id));
  const storage = memory(),
    preferences = new AvatarPreferences(() => storage);
  check(
    preferences.id === 'scientist' && !preferences.saved,
    'Без сохранения выбран аватар по умолчанию',
  );
  storage.setItem(AVATAR_STORAGE_KEY, 'unknown');
  check(
    new AvatarPreferences(() => storage).id === 'scientist',
    'Неизвестный ID в хранилище безопасно игнорируется',
  );
  for (const id of ['male', 'female', 'uraraka', 'scientist']) {
    storage.setItem(AVATAR_STORAGE_KEY, id);
    check(
      new AvatarPreferences(() => storage).id === id,
      'Ранее сохранённый выбор сохраняет приоритет: ' + id,
    );
  }
  const denied = new AvatarPreferences(() => {
    throw Error('Storage denied');
  });
  check(
    denied.id === 'scientist' &&
      !denied.save('female') &&
      denied.id === 'female',
    'Запрет localStorage оставляет выбор на время сессии',
  );

  const engine = new B.Engine(document.getElementById('canvas'), true);
  const scene = new B.Scene(engine);
  scene.useRightHandedSystem = true;
  const camera = new B.FreeCamera(
    'settings-test-camera',
    new B.Vector3(0, 1.6, 3),
    scene,
  );
  camera.rotationQuaternion = B.Quaternion.Identity();
  camera.minZ = 0.05;
  new B.HemisphericLight('light', new B.Vector3(0, 1, 0), scene);
  const avatar = new LocalAvatar(scene);
  check(
    (await avatar.ready) &&
      avatar.id === 'scientist' &&
      avatar.joints.size === 7,
    'По умолчанию загружен учёный с рабочим скелетом без fallback',
  );
  avatar.update(0, 0, 0, true);
  scene.render();
  const scientistBounds = avatar.model.getHierarchyBoundingVectors(true);
  check(
    Math.abs(scientistBounds.min.y) < 0.001 &&
      Math.abs(scientistBounds.max.y - 1.8) < 0.001 &&
      !avatar.fallback.isEnabled(),
    'Учёный стоит на земле и нормализован до 1,8 м',
  );
  for (const mesh of avatar.container.meshes.filter(
    (mesh) => mesh.getTotalVertices() > 0,
  )) {
    await mesh.material.forceCompilationAsync(mesh);
    check(
      !mesh.material.getEffect()?.getCompilationError() &&
        mesh.material.getActiveTextures().every((texture) => texture.isReady()),
      'Материал и текстуры учёного: ' + mesh.name,
    );
  }
  const idle = avatar.joints.get('thigh_l').node.rotationQuaternion.clone();
  avatar.update(0.2, 3, 0.4, true);
  check(
    Math.abs(
      B.Quaternion.Dot(
        idle,
        avatar.joints.get('thigh_l').node.rotationQuaternion,
      ),
    ) < 0.999,
    'Скелет учёного получает анимацию ходьбы',
  );
  const network = new Network(scene, { worldMap: 'planet' });
  const state = {
    sequence: 1,
    position: [0, 36, 0],
    rotation: [0, 0, 0, 1],
    pitch: 0,
  };
  network.apply(42, state);
  const remote = network.remotes.get(42).avatar;
  check(
    (await remote.ready) && remote.id === 'scientist',
    'Удалённый игрок без выбора получает учёного',
  );
  for (const id of ['female', 'scientist']) {
    network.apply(42, { ...state, sequence: ++state.sequence, avatarId: id });
    check(
      (await remote.ready) && remote.id === id,
      'Удалённый игрок переключает модель: ' + id,
    );
  }
  network.apply(42, { ...state, sequence: ++state.sequence });
  check(
    remote.id === 'scientist',
    'Снимок без avatarId сохраняет модель удалённого игрока',
  );
  remote.root.dispose();
  const player = { avatar, keys: new Set(), inputEnabled: true };
  const auth = {
    token: null,
    registration: true,
    busy: false,
    require() {
      document.getElementById('auth-dialog').show();
    },
    submit() {},
  };
  const panel = new AccountPanel(
    scene,
    auth,
    player,
    document.getElementById('canvas'),
    () => {},
    preferences,
  );
  auth.require();
  panel.sync();
  const sharedMesh = panel.mesh;
  check(
    panel.visible && panel.mode === 'auth',
    'Авторизация отображается на общей 3D-панели',
  );
  auth.token = 'test';
  document.getElementById('auth-dialog').close();
  auth.onSignIn({ registered: true });
  check(
    panel.settingsOpen &&
      panel.onboarding &&
      panel.mesh === sharedMesh &&
      panel.mode === 'settings',
    'После регистрации выбор открывается на той же 3D-поверхности',
  );
  check(!player.inputEnabled, 'Настройки приостанавливают движение');
  const previous = avatar.container;
  panel.chooseAvatar('female');
  await panel.applySettings();
  check(
    avatar.id === 'female' &&
      avatar.skeleton.bones.length === 65 &&
      previous.meshes.every((mesh) => mesh.isDisposed()),
    'Женский аватар заменяет учёного и освобождает прежнюю модель',
  );
  for (const mesh of avatar.container.meshes.filter(
    (mesh) => mesh.getTotalVertices() > 0,
  )) {
    await mesh.material.forceCompilationAsync(mesh);
    check(
      mesh.material.getActiveTextures().every((texture) => texture.isReady()),
      'Материал и текстуры женского аватара: ' + mesh.name,
    );
  }
  check(
    new AvatarPreferences(() => storage).id === 'female' &&
      !panel.settingsOpen &&
      player.inputEnabled,
    'Выбор сохранён, восстанавливается из браузерного хранилища, движение возобновлено',
  );
  const restored = new LocalAvatar(
    scene,
    new AvatarPreferences(() => storage).id,
  );
  check(
    (await restored.ready) && restored.id === 'female',
    'Новый игрок загружает сохранённый аватар',
  );
  restored.root.dispose();
  check(
    scene.skeletons.length === 1,
    'После смены и удаления игрока нет лишних скелетов',
  );
  const first = avatar.select('male'),
    last = avatar.select('female');
  const results = await Promise.all([first, last]);
  check(
    !results[0] &&
      results[1] &&
      avatar.id === 'female' &&
      scene.skeletons.length === 1,
    'При быстрых переключениях применяется последний выбор без утечки моделей',
  );

  panel.openSettings();
  panel.chooseAvatar('male');
  const select = avatar.select.bind(avatar);
  avatar.select = async () => false;
  await panel.applySettings();
  avatar.select = select;
  check(
    panel.settingsOpen &&
      preferences.id === 'female' &&
      avatar.id === 'female' &&
      document
        .getElementById('settings-status')
        .textContent.includes('Не удалось'),
    'Ошибка загрузки не меняет модель и сохранение; доступен повтор',
  );
  await panel.applySettings();
  check(
    avatar.id === 'male' && preferences.id === 'male' && !panel.settingsOpen,
    'Повтор после ошибки успешно применяет выбор',
  );
  panel.preferences = denied;
  panel.openSettings();
  panel.chooseAvatar('female');
  await panel.applySettings();
  check(
    avatar.id === 'female' &&
      panel.settingsOpen &&
      document
        .getElementById('settings-status')
        .textContent.includes('не разрешил'),
    'Ошибка сохранения показана в 3D-настройках, модель работает',
  );
  panel.closeSettings();
  panel.preferences = preferences;

  panel.openSettings();
  panel.chooseAvatar('uraraka');
  await panel.applySettings();
  check(
    avatar.id === 'uraraka' &&
      !avatar.skeleton &&
      !avatar.joints &&
      scene.skeletons.length === 0,
    'Урарака загружается как статический аватар и освобождает предыдущий скелет',
  );
  avatar.update(0.1, 3, 0.4, true);
  scene.render();
  const bounds = avatar.model.getHierarchyBoundingVectors(true);
  check(
    Math.abs(bounds.min.y) < 0.001 &&
      Math.abs(bounds.max.y - 1.8) < 0.001 &&
      bounds.max.x - bounds.min.x < 1,
    'Одна фигура Урараки стоит на земле, нормализована до 1,8 м, фон и боковые позы удалены',
  );
  for (const mesh of avatar.container.meshes.filter(
    (mesh) => mesh.getTotalVertices() > 0,
  )) {
    await mesh.material.forceCompilationAsync(mesh);
    check(
      mesh.material.getActiveTextures().every((texture) => texture.isReady()),
      'Материал и текстуры Урараки: ' + mesh.name,
    );
  }
  const restoredStatic = new LocalAvatar(
    scene,
    new AvatarPreferences(() => storage).id,
  );
  check(
    (await restoredStatic.ready) && restoredStatic.id === 'uraraka',
    'Выбор Урараки сохраняется и восстанавливается',
  );
  restoredStatic.root.dispose();
  check(
    (await avatar.select('male')) &&
      avatar.joints &&
      scene.skeletons.length === 1,
    'После статической модели скелетный аватар снова получает анимацию',
  );
  check(
    (await avatar.select('uraraka')) &&
      !avatar.joints &&
      scene.skeletons.length === 0,
    'Повторное переключение на Урараку очищает скелет и процедурную позу',
  );

  // Exercise the real XR ray conversion and pick routing with synthetic poses.
  panel.xr = true;
  panel.sync();
  const origin = new B.TransformNode('test-xr-origin', scene);
  origin.position.set(4, 5, 6);
  origin.rotationQuaternion = B.Quaternion.RotationAxis(B.Axis.Z, 0.7);
  const source = { targetRaySpace: {} };
  let target = panel.gear;
  const frame = {
    session: { inputSources: [source] },
    getPose() {
      const inverse = origin.computeWorldMatrix(true).clone().invert();
      const position = B.Vector3.TransformCoordinates(
        camera.globalPosition,
        inverse,
      );
      const point = B.Vector3.TransformCoordinates(
        target.getAbsolutePosition(),
        inverse,
      );
      const world = B.Matrix.LookAtRH(position, point, B.Axis.Y).invert();
      const orientation = B.Quaternion.Identity();
      world.decompose(undefined, orientation);
      return { transform: { position, orientation } };
    },
  };
  scene.render();
  panel.gear.computeWorldMatrix(true);
  panel.updateXR(frame, {}, origin);
  check(
    panel.hover === 'settings-gear',
    'VR-луч находит шестерёнку при закрытой панели',
  );
  panel.selectXR({ frame, inputSource: source }, {}, origin);
  check(
    panel.settingsOpen && panel.mesh === sharedMesh,
    'Триггер на шестерёнке открывает тот же компонент настроек',
  );
  panel.chooseAvatar('male');
  panel.sync();
  for (const definition of AVATARS) {
    const choice = panel.targets.find(
      (item) => item.id === 'avatar-' + definition.id,
    );
    check(
      choice && choice.y + choice.h < 735,
      'Выбор не перекрывает статус и кнопки: ' + definition.id,
    );
  }
  const row = panel.targets.find((item) => item.id === 'avatar-uraraka');
  check(
    row.y + row.h < 735,
    'Последний аватар помещается в 3D-панель и не перекрывает статус или кнопки',
  );
  const localTarget = new B.TransformNode('test-settings-target', scene);
  localTarget.parent = panel.mesh;
  localTarget.position.set(
    ((row.x + row.w / 2) / 1024 - 0.5) * 1.25,
    ((0.5 - (row.y + row.h / 2) / 1120) * 1.25 * 1120) / 1024,
    0,
  );
  localTarget.computeWorldMatrix(true);
  target = localTarget;
  panel.selectXR({ frame, inputSource: source }, {}, origin);
  check(
    panel.draft === 'uraraka',
    'VR-луч выбирает последний пункт списка аватаров',
  );
  // B must still work when settings have disabled locomotion.
  const xr = {
    roomShortcut: new RoomShortcut(),
    active: true,
    player,
    authPanel: panel,
    aDown: false,
    bDown: false,
    helper: {
      sessionManager: {
        session: {
          visibilityState: 'visible',
          inputSources: [
            {
              handedness: 'right',
              gamepad: {
                axes: [0, 0, 0, 0],
                buttons: [{}, {}, {}, {}, {}, { pressed: true }],
              },
            },
          ],
        },
      },
    },
  };
  XRView.prototype.input.call(xr);
  check(
    !panel.settingsOpen && player.inputEnabled,
    'B закрывает настройки даже при заблокированном движении',
  );
  check(
    !panel.isInteractiveMesh(panel.mesh) &&
      !panel.targetAt({ hit: true, pickedMesh: panel.mesh }),
    'Закрытая 3D-панель не перехватывает VR-луч и не активирует скрытые кнопки',
  );
  panel.xr = false;
  panel.sync();
  check(!panel.gear.isEnabled(), 'После выхода из VR шестерёнка скрыта');
  avatar.update(0, 0, 0, true);
  engine.runRenderLoop(() => scene.render());
  output.textContent +=
    '\n\nВсе проверки настроек пройдены. Физический шлем проверяется отдельно.';
} catch (error) {
  output.textContent += '\nFAIL · ' + error.message;
  console.error(error);
}
