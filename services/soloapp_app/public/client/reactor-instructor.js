import { LocalAvatar } from './local-avatar.js';
import { npcLabel } from './npc-label.js';
import { isReactorMap } from '../shared/room.js';
import {
  InstructorSession,
  VoiceActivity,
  quickStartLines,
} from './instructor-session.js';

const B = window.BABYLON;
const source = new URL('../assets/training/QUICK_START.md', import.meta.url);

export class ReactorInstructor {
  constructor(room) {
    this.room = room;
    this.enabled = true;
    this.announcementActive = false;
    this.commandRevision = 0;
    this.lastActivation = -Infinity;
    this.lastRequest = -Infinity;
    this.lastVoice = -Infinity;
    this.buildStation();
    this.buildCaptions();
    this.ready = this.load();
    this.timer = setInterval(() => this.tick(), 200);
    this.onGesture = () => {
      void this.context?.resume().catch(() => {});
    };
    document.addEventListener('pointerdown', this.onGesture);
    document.addEventListener('keydown', this.onGesture);
    this.onVisibility = () => {
      if (document.hidden) {
        this.stop();
        this.closeMonitor();
      } else if (this.room.active && this.session?.state)
        this.present(this.session.state);
    };
    document.addEventListener('visibilitychange', this.onVisibility);
    room.root.onDisposeObservable.addOnce(() => this.dispose());
  }

  async load() {
    try {
      const response = await fetch(source);
      if (!response.ok) throw Error('QUICK_START.md недоступен');
      const lines = quickStartLines(await response.text());
      if (!lines.length) throw Error('В QUICK_START.md нет реплик');
      if (this.disposed) return false;
      this.session = new InstructorSession({
        lines,
        clock: () => performance.now(),
        sessionId: () => crypto.randomUUID(),
        publish: (state) => this.send({ kind: 'state', state }),
        present: (state) => this.present(state),
      });
      if (this.room.active) this.enter();
      return true;
    } catch (error) {
      this.caption(
        error.message + '. Нажмите кнопку инструктора для повторной загрузки.',
      );
      return false;
    }
  }

  buildStation() {
    const room = this.room;
    const body = room.material('copier ivory', '#dddccb');
    const dark = room.material('copier graphite', '#333c42');
    const paper = room.material('copier paper', '#fff8df');
    const glass = room.material('copier glass', '#7faeb5');
    const origin = new B.TransformNode('Instructor copier station', room.scene);
    origin.parent = room.root;
    origin.position.set(5.5, 0, 7.6);
    room.box(
      'Copier cabinet',
      [1.25, 0.95, 0.85],
      [0, 0.48, 0],
      body,
      origin,
      true,
    );
    for (const y of [0.25, 0.53]) {
      room.box(
        'Copier paper drawer',
        [1.12, 0.23, 0.03],
        [0, y, -0.44],
        dark,
        origin,
      );
      room.box(
        'Copier drawer handle',
        [0.3, 0.035, 0.06],
        [0, y + 0.05, -0.47],
        body,
        origin,
      );
    }
    room.box(
      'Copier scanner glass',
      [1.13, 0.035, 0.76],
      [0, 0.98, 0],
      glass,
      origin,
    );
    const lid = room.box(
      'Copier raised scanner lid',
      [1.2, 0.07, 0.76],
      [0, 1.15, 0.11],
      body,
      origin,
    );
    lid.rotation.x = -0.3;
    room.box(
      'Copier output tray',
      [0.4, 0.05, 0.7],
      [-0.77, 0.7, 0],
      dark,
      origin,
    );
    room.box(
      'Copier printed quick start pages',
      [0.3, 0.055, 0.43],
      [-0.78, 0.75, -0.04],
      paper,
      origin,
    );
    const button = room.box(
      'Instructor speech button',
      [0.3, 0.1, 0.19],
      [0.35, 1.03, -0.43],
      glass,
      origin,
    );
    button.metadata = { rbmkInstructor: true };
    button.isPickable = true;
    this.avatar = new LocalAvatar(room.scene, 'scientist');
    this.avatar.root.name = 'Scientist instructor';
    this.avatar.root.parent = room.root;
    this.avatar.root.position.set(3.95, 0, 7.5);
    this.nameLabel = npcLabel(room.scene, this.avatar.root, 'Главный инженер');
    room.box(
      'Instructor standing collider',
      [0.65, 1.8, 0.65],
      [3.95, 0.9, 7.5],
      dark,
      room.root,
      true,
    ).visibility = 0;
    this.screen = B.MeshBuilder.CreatePlane(
      'Instructor subtitles and speech toggle',
      { width: 3.8, height: 1.9 },
      room.scene,
    );
    this.screen.parent = room.root;
    this.screen.position.set(4.9, 2.85, 7.55);
    this.screen.rotation.y = Math.PI;
    this.screen.metadata = { rbmkInstructor: true };
    this.texture = new B.DynamicTexture(
      'Instructor captions',
      { width: 1024, height: 512 },
      room.scene,
      false,
    );
    const screenMaterial = room.material(
      'Instructor caption board',
      '#ffffff',
      true,
    );
    screenMaterial.diffuseTexture = this.texture;
    screenMaterial.emissiveTexture = this.texture;
    screenMaterial.backFaceCulling = false;
    this.screen.material = screenMaterial;
  }

  buildCaptions() {
    this.panel = document.createElement('section');
    this.panel.id = 'reactor-instructor';
    this.panel.hidden = true;
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.onclick = () => this.toggle();
    this.button.textContent = 'Инструктор · звук включён';
    this.button.setAttribute('aria-pressed', 'true');
    this.subtitle = document.createElement('p');
    this.subtitle.setAttribute('role', 'status');
    const link = document.createElement('a');
    link.href = source.href;
    link.textContent = 'Текст QUICK_START.md';
    link.target = '_blank';
    link.rel = 'noopener';
    this.panel.append(this.button, link, this.subtitle);
    document.body.append(this.panel);
    this.caption(
      'Главный инженер у копировального аппарата · вводный инструктаж через 5 секунд после входа.',
    );
  }

  caption(text) {
    this.subtitle.textContent = text;
    const ctx = this.texture.getContext();
    ctx.fillStyle = '#152f37';
    ctx.fillRect(0, 0, 1024, 512);
    ctx.fillStyle = '#e9efcc';
    ctx.font = 'bold 34px sans-serif';
    ctx.fillText('ГЛАВНЫЙ ИНЖЕНЕР · ИНСТРУКТАЖ', 30, 50);
    ctx.font = '27px sans-serif';
    let line = '',
      y = 105;
    for (const word of text.split(/\s+/)) {
      if (ctx.measureText(line + word).width > 950) {
        ctx.fillText(line, 30, y);
        y += 37;
        line = '';
      }
      line += word + ' ';
    }
    ctx.fillText(line, 30, y);
    ctx.font = '24px sans-serif';
    ctx.fillStyle = '#8ed5ce';
    ctx.fillText(
      this.button.textContent + ' · выбрать табло: переключить',
      30,
      480,
    );
    this.texture.update();
  }

  members() {
    const network = this.room.network;
    return new Set([
      network?.id || 0,
      ...[...(network?.remotes || [])]
        .filter(([, remote]) => isReactorMap(remote.state?.map))
        .map(([id]) => id),
    ]);
  }

  send(message) {
    this.room.network?.broadcastControl({ type: 'instructor', ...message });
  }

  receive(peer, message) {
    if (!this.room.active || !this.session || !this.members().has(peer)) return;
    if (message.kind === 'request') {
      const state = this.session.snapshot();
      if (state)
        this.room.network.sendControl(peer, {
          type: 'instructor',
          kind: 'state',
          state,
        });
    } else if (message.kind === 'state') {
      this.session.receive(message.state, peer === this.room.teamLeader());
    } else if (
      message.kind === 'voice' &&
      typeof message.active === 'boolean'
    ) {
      this.session.voice(peer, message.active);
    }
  }

  enter() {
    this.session?.reset();
    this.lastRequest = -Infinity;
    this.caption(
      'Инструктаж начнётся через 5 секунд. Главный инженер стоит у копировального аппарата за пультами справа.',
    );
    this.send({ kind: 'request' });
  }

  leave() {
    this.closeMonitor();
    this.stop();
    this.session?.reset();
    this.panel.hidden = true;
  }

  control(label, actor) {
    if (!this.room.active || !this.session) return;
    this.session.leader =
      this.room.teamLeader() === (this.room.network?.id || 0);
    this.session.control(label, actor);
  }

  serverControl(record, label, actor) {
    if (
      !Number.isSafeInteger(record.revision) ||
      record.revision <= this.commandRevision
    )
      return;
    this.commandRevision = record.revision;
    this.control(label, actor);
  }

  activate() {
    const now = performance.now();
    if (now - this.lastActivation < 350) return;
    this.lastActivation = now;
    this.toggle();
  }

  tick() {
    if (!this.room.active || this.disposed) return;
    const now = performance.now();
    if (now - this.lastRequest >= 2000) {
      this.lastRequest = now;
      if (!this.session?.state) this.send({ kind: 'request' });
    }
    this.monitor();
    const leader = this.room.teamLeader() === (this.room.network?.id || 0);
    this.session?.tick(leader, this.members());
    if (!leader && !this.session?.state && now >= this.session?.readyAt) {
      const waiting =
        'Ожидание связи с ведущим инструктажа. Проверьте соединение комнаты.';
      if (this.subtitle.textContent !== waiting) this.caption(waiting);
    }
  }

  update(dt) {
    const visible = this.room.active && !this.room.physicalView;
    if (!visible && this.utterance) this.stop();
    if (visible && this.panel.hidden && this.session?.state)
      this.present(this.session.state);
    this.panel.hidden = !visible;
    this.avatar.update(dt, 0, 0, visible);
  }

  setAnnouncementActive(active) {
    if (this.announcementActive === active) return;
    this.announcementActive = active;
    if (active) this.stop();
    else if (this.room.active && this.session?.state)
      this.present(this.session.state);
  }

  setConversationActive(active) {
    if (this.conversationActive === active) return;
    this.conversationActive = active;
    if (active) this.stop();
    else if (this.room.active && this.session?.state)
      this.present(this.session.state);
  }

  canReplyToVisitor() {
    return (
      this.enabled &&
      !this.announcementActive &&
      !this.conversationActive &&
      !this.workerReply &&
      !this.speaking &&
      !this.session?.voices.size &&
      this.session?.state?.kind !== 'listening'
    );
  }

  replyToVisitor(text, speaker = this.avatar) {
    if (!this.canReplyToVisitor()) return;
    this.present({ kind: 'worker', text, speaker });
  }

  finishWorkerReply() {
    if (!this.workerReply) return;
    this.stop();
    if (this.room.active && this.session?.state)
      this.present(this.session.state);
  }

  present(state) {
    if (this.conversationActive) return;
    // One speech owner: a short local worker reply temporarily yields to chat
    // and announcements, then resumes the current shared instructor sentence.
    if (
      this.enabled &&
      this.workerReply &&
      !['worker', 'listening'].includes(state.kind)
    )
      return;
    this.stop();
    if (state.kind === 'worker') {
      this.workerReply = true;
      this.workerTimeout = setTimeout(() => this.finishWorkerReply(), 4500);
    }
    this.caption(state.text || 'Инструктор · продолжаем вводное занятие…');
    if (
      !this.enabled ||
      this.announcementActive ||
      this.room.physicalView ||
      document.hidden ||
      !['intro', 'comment', 'worker'].includes(state.kind)
    )
      return;
    const synth = window.speechSynthesis;
    if (!synth || !window.SpeechSynthesisUtterance) {
      this.blocked('Озвучка недоступна · читаем субтитры');
      return;
    }
    const utterance = new SpeechSynthesisUtterance(state.text);
    utterance.lang = 'ru-RU';
    utterance.rate = 1;
    const voices = synth
      .getVoices()
      .filter((voice) => /^ru[-_]/i.test(voice.lang));
    utterance.voice =
      voices.find((voice) => voice.localService) || voices[0] || null;
    this.utterance = utterance;
    const speaker = state.kind === 'worker' ? state.speaker : this.avatar;
    this.speechAvatar = speaker;
    const speaking = (active) => {
      if (this.utterance === utterance) speaker?.setSpeaking(active);
    };
    utterance.onpause = () => speaking(false);
    utterance.onresume = () => speaking(true);
    utterance.onstart = () => {
      if (this.utterance !== utterance) return;
      clearTimeout(this.startTimeout);
      this.button.textContent = 'Инструктор · звук включён';
      this.playbackBlocked = false;
      speaking(true);
    };
    utterance.onend = () => {
      if (this.utterance !== utterance) return;
      clearTimeout(this.startTimeout);
      speaking(false);
      this.speechAvatar = null;
      this.utterance = null;
      if (state.kind === 'worker') this.finishWorkerReply();
      else this.session.finished(state.revision);
    };
    utterance.onerror = () => {
      if (this.utterance === utterance)
        this.blocked('Включить голос инструктора');
    };
    this.startTimeout = setTimeout(() => {
      if (this.utterance === utterance)
        this.blocked('Включить голос инструктора');
    }, 2500);
    try {
      synth.speak(utterance);
    } catch {
      this.blocked('Включить голос инструктора');
    }
  }

  blocked(label) {
    this.stop();
    this.playbackBlocked = true;
    this.button.textContent = label;
    this.caption(this.subtitle.textContent);
  }

  stop() {
    clearTimeout(this.workerTimeout);
    this.workerReply = false;
    clearTimeout(this.startTimeout);
    const utterance = this.utterance;
    this.speechAvatar?.setSpeaking(false);
    this.speechAvatar = null;
    this.utterance = null;
    if (utterance) window.speechSynthesis?.cancel();
  }

  toggle() {
    if (!this.session) {
      this.ready = this.load();
      return;
    }
    this.enabled = this.playbackBlocked || !this.enabled;
    this.playbackBlocked = false;
    this.button.textContent = this.enabled
      ? 'Инструктор · звук включён'
      : 'Инструктор · включить звук';
    this.button.setAttribute('aria-pressed', String(this.enabled));
    if (this.session.state) this.present(this.session.state);
    else this.caption(this.subtitle.textContent);
    this.onGesture();
  }

  monitor() {
    // Borrow only the already enabled chat stream. Never request or stop its tracks.
    const stream = !document.hidden && this.room.network?.voice?.stream;
    const live = stream
      ?.getAudioTracks()
      .some((track) => track.readyState === 'live' && track.enabled);
    if (!live) {
      this.closeMonitor();
      return;
    }
    if (this.stream !== stream) {
      this.closeMonitor();
      try {
        this.context = new AudioContext();
        this.stream = stream;
        this.input = this.context.createMediaStreamSource(stream);
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = 1024;
        this.samples = new Float32Array(1024);
        this.input.connect(this.analyser);
        this.detector = new VoiceActivity();
        void this.context.resume().catch(() => {});
      } catch {
        this.closeMonitor();
        return;
      }
    }
    if (this.context.state !== 'running') return;
    this.analyser.getFloatTimeDomainData(this.samples);
    const energy =
      this.samples.reduce((sum, n) => sum + n * n, 0) / this.samples.length;
    const active = this.detector.sample(Math.sqrt(energy), 0.2);
    if (
      active !== this.speaking ||
      (active && performance.now() - this.lastVoice >= 1000)
    ) {
      this.speaking = active;
      this.lastVoice = performance.now();
      if (active) this.stop();
      this.session?.voice(this.room.network?.id || 0, active);
      this.send({ kind: 'voice', active });
    }
  }

  closeMonitor() {
    if (this.speaking) {
      this.session?.voice(this.room.network?.id || 0, false);
      this.send({ kind: 'voice', active: false });
    }
    this.speaking = false;
    this.input?.disconnect();
    void this.context?.close().catch(() => {});
    this.context = null;
    this.input = null;
    this.stream = null;
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.leave();
    this.texture.dispose();
    this.panel.remove();
    document.removeEventListener('pointerdown', this.onGesture);
    document.removeEventListener('keydown', this.onGesture);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }
}
