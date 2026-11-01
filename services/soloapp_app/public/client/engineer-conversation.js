import { ProfessorRecorder } from './professor-recorder.js';
import { askEngineer } from './professor-voice.js';
import {
  EngineerSession,
  QUESTION_RADIUS,
  HEARING_RADIUS,
  nearEngineer,
} from './engineer-session.js';

export class EngineerConversation {
  constructor(room, voice, getToken) {
    Object.assign(this, { room, voice, getToken });
    this.session = new EngineerSession();
    this.lastPublish = -Infinity;
    this.recorder = new ProfessorRecorder(() => this.draw(), getToken, {
      request: async (samples, token, signal) => {
        if (!this.localTurn || this.owner !== this.id)
          throw Error(
            'Инженер отвечает другому участнику. Повторите вопрос после ответа.',
          );
        return askEngineer(samples, token, signal);
      },
      onSpeechStart: () => this.claim(),
      onState: (status) => {
        if (status && this.localTurn)
          this.publish('thinking', 'Ищу ответ в документации…');
        else if (!status) this.endTurn();
      },
      playResult: async (result, signal) => {
        if (!this.localTurn || this.owner !== this.id || signal?.aborted)
          return;
        this.publish('answer', result.answer);
        this.draw();
        if (result.audio_base64)
          await voice.npc.playWav(result.audio_base64, signal);
      },
      onCancel: () => this.endTurn(),
    });
    room.network.onEngineerMessage = (peer, message) => {
      const remote = room.network.remotes.get(peer)?.state;
      if (
        !room.active ||
        (message.stage !== 'idle' && !nearEngineer(remote, QUESTION_RADIUS + 1))
      )
        return;
      if (this.session.receive(peer, message)) this.update();
    };
    this.onHide = () => {
      if (document.hidden) this.update();
    };
    this.onLeave = () => {
      this.recorder.clear();
      this.endTurn();
    };
    document.addEventListener('visibilitychange', this.onHide);
    window.addEventListener('pagehide', this.onLeave);
    room.root.onDisposeObservable.addOnce(() => this.dispose());
  }
  get id() {
    return this.room.network.id || 0;
  }
  claim() {
    if (
      !this.near ||
      !this.getToken() ||
      this.voice.muted ||
      (this.owner !== null && this.owner !== this.id)
    )
      return false;
    if (!this.localTurn) {
      this.localTurn = crypto.randomUUID();
      this.publish('listening', 'Слушаю вопрос…');
    }
    return true;
  }
  publish(stage, text = '') {
    if (!this.localTurn) return;
    const message = {
      type: 'engineer',
      turn: this.localTurn,
      stage,
      text: text.slice(0, 1200),
    };
    this.session.receive(this.id, message);
    this.room.network.broadcastControl(message);
    this.lastPublish = performance.now();
    this.owner = this.session.owner(this.members);
  }
  endTurn() {
    if (!this.localTurn) return;
    this.publish('idle');
    this.localTurn = null;
    this.voice.npc.stop();
    this.room.instructor.avatar.setSpeaking(false);
  }
  update() {
    if (this.disposed) return;
    const room = this.room,
      network = room.network;
    const state = {
      map: room.player.worldMap,
      position: room.player.position.asArray(),
    };
    const visible = room.active && !room.physicalView && !document.hidden;
    this.near =
      visible &&
      nearEngineer(state, this.near ? QUESTION_RADIUS + 0.7 : QUESTION_RADIUS);
    const hearing = visible && nearEngineer(state, HEARING_RADIUS);
    const nearby = new Set(
      [...network.remotes]
        .filter(([, remote]) => nearEngineer(remote.state, HEARING_RADIUS))
        .map(([id]) => id),
    );
    this.members = new Set([this.id, ...nearby]);
    this.owner = this.session.owner(this.members);
    if (
      this.localTurn &&
      (!this.near || this.owner !== this.id || !this.getToken())
    )
      this.endTurn();
    if (this.localTurn && performance.now() - this.lastPublish > 2000) {
      const turn = this.session.turns.get(this.id);
      if (turn) this.publish(turn.stage, turn.text);
    }
    const enabled =
      this.near &&
      this.getToken() &&
      !this.voice.muted &&
      (this.owner === null || this.owner === this.id);
    this.recorder.setTarget(enabled ? 0 : null);
    void this.recorder.setVoiceStream(enabled ? this.voice.stream : null);
    this.owner = this.session.owner(this.members);
    this.voice.npc.setAudience(hearing, nearby, this.owner, this.id);
    const active =
      hearing && (this.owner !== null || (enabled && this.recorder.enabled));
    if (active || this.room.instructor.conversationActive) {
      const npc = this.voice.npc;
      const receiver = npc.receivers.get(this.owner);
      const audible =
        this.owner === this.id
          ? npc.source && npc.context?.state === 'running'
          : receiver &&
            !receiver.blocked &&
            !receiver.audio.paused &&
            !receiver.audio.muted;
      this.room.instructor.avatar.setSpeaking(
        Boolean(
          active &&
          !this.voice.muted &&
          audible &&
          this.session.turns.get(this.owner)?.stage === 'answer',
        ),
      );
    }
    this.room.instructor.setConversationActive(active);
    this.draw();
  }
  draw() {
    if (
      !this.room.active ||
      this.room.physicalView ||
      !this.room.instructor.conversationActive
    )
      return;
    const record = this.recorder.record(0),
      turn = this.session.turns.get(this.owner);
    const text =
      turn?.text ||
      this.recorder.error ||
      record.answer ||
      'Главный инженер слушает включённый микрофон voice chat. Задайте вопрос и сделайте паузу.';
    if (text !== this.room.instructor.subtitle.textContent) {
      this.lastCaption = text;
      this.room.instructor.caption(text);
    }
  }
  dispose() {
    this.disposed = true;
    this.recorder.clear();
    this.endTurn();
    this.session.turns.clear();
    document.removeEventListener('visibilitychange', this.onHide);
    window.removeEventListener('pagehide', this.onLeave);
  }
}
