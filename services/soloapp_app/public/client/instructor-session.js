// Pure shared narration state. Only the elected room peer advances the script.
export function quickStartLines(markdown) {
  const paragraphs = [];
  let quote = [];
  const flush = () => {
    if (quote.length) paragraphs.push(quote.join(' '));
    quote = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (/^>\s*\S/.test(line)) quote.push(line.replace(/^>\s*/, ''));
    else {
      flush();
      // Panel descriptions and sample dialogue are also explicitly quoted.
      if (
        line.startsWith('|') ||
        line.startsWith('- ') ||
        line.startsWith('Если действие')
      ) {
        const speech = line.match(/«(.+)»/);
        if (speech) paragraphs.push(speech[1]);
      }
    }
  }
  flush();
  // Unfilled examples are for a human facilitator, never live telemetry.
  return paragraphs
    .filter((text) => !text.includes('['))
    .flatMap((text) =>
      (text.match(/[^.!?]+[.!?]+[»”]?|[^.!?]+$/g) || [])
        .map((s) => s.trim())
        .filter(Boolean),
    );
}

export class InstructorSession {
  constructor({ lines, clock, publish, present, sessionId }) {
    Object.assign(this, { lines, clock, publish, present, sessionId });
    this.voices = new Map();
    this.reset();
  }

  reset() {
    this.state = null;
    this.voices.clear();
    this.pending = null;
    this.nextComment = 0;
    this.readyAt = this.clock() + 5000;
    this.deadline = this.readyAt;
    this.lastPublish = -Infinity;
    this.leader = false;
  }

  snapshot() {
    return (
      this.state && {
        ...this.state,
        remaining: Math.max(0, this.deadline - this.clock()),
      }
    );
  }

  receive(snapshot, fromLeader) {
    if (
      !snapshot ||
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < 1 ||
      !Number.isSafeInteger(snapshot.index) ||
      snapshot.index < 0 ||
      snapshot.index > this.lines.length ||
      typeof snapshot.session !== 'string' ||
      snapshot.session.length > 80 ||
      !['waiting', 'intro', 'comment', 'listening', 'done'].includes(
        snapshot.kind,
      ) ||
      typeof snapshot.text !== 'string' ||
      snapshot.text.length > 600 ||
      !Number.isFinite(snapshot.remaining) ||
      snapshot.remaining < 0 ||
      snapshot.remaining > 120000
    )
      return false;
    if (
      this.state &&
      (!fromLeader ||
        (snapshot.session === this.state.session &&
          snapshot.revision < this.state.revision))
    )
      return false;
    const changed =
      !this.state ||
      snapshot.session !== this.state.session ||
      snapshot.revision !== this.state.revision;
    this.state = {
      session: snapshot.session,
      revision: snapshot.revision,
      index: snapshot.index,
      kind: snapshot.kind,
      text: snapshot.text,
    };
    this.pending = null;
    this.deadline = this.clock() + snapshot.remaining;
    if (changed) this.present(this.state);
    return true;
  }

  transition(kind, text = '', delay = 0) {
    this.state = {
      session: this.state?.session || this.sessionId(),
      revision: (this.state?.revision || 0) + 1,
      index: this.state?.index || 0,
      kind,
      text,
    };
    this.deadline = this.clock() + delay;
    this.present(this.state);
    this.publish(this.snapshot());
  }

  speak(kind, text) {
    // Bounded caption dwell time also keeps the room progressing without TTS.
    this.transition(
      kind,
      text,
      Math.min(120000, 4000 + text.split(/\s+/).length * 500),
    );
  }

  finished(revision) {
    if (
      !this.leader ||
      this.state?.revision !== revision ||
      !['intro', 'comment'].includes(this.state.kind)
    )
      return;
    if (this.state.kind === 'intro') this.state.index++;
    this.transition('waiting', '', 800);
  }

  control(label, actor) {
    if (!this.leader || typeof label !== 'string') return;
    // Sliders may emit dozens of values: retain the most recent committed one.
    this.pending = {
      text: `${actor}: ${label}. Проверьте фактический отклик по приборам и доложите результат.`.slice(
        0,
        580,
      ),
      at: this.clock() + 600,
    };
  }

  voice(peer, speaking) {
    if (speaking) {
      this.voices.set(peer, this.clock() + 2500);
    } else this.voices.delete(peer);
  }

  tick(leader, members) {
    this.leader = leader;
    const now = this.clock();
    for (const [id, expires] of this.voices)
      if (expires <= now || !members.has(id)) this.voices.delete(id);
    if (!leader || now < this.readyAt) return;
    if (this.state && now - this.lastPublish >= 1000) {
      this.publish(this.snapshot());
      this.lastPublish = now;
    }
    if (this.voices.size) {
      if (this.state?.kind !== 'listening')
        this.transition(
          'listening',
          'Слушаю участника. Продолжим после доклада.',
        );
      this.deadline = now + 1200;
      return;
    }
    if (this.state?.kind === 'listening' && now < this.deadline) return;
    // Voice activity only pauses narration. The question pipeline owns answers;
    // an energy detector cannot know what the participant said.
    if (this.pending && now >= Math.max(this.pending.at, this.nextComment)) {
      const text = this.pending.text;
      this.pending = null;
      this.speak('comment', text);
      this.nextComment = now + 5000;
      return;
    }
    if (this.state && now < this.deadline) return;
    if (['intro', 'comment'].includes(this.state?.kind)) {
      this.finished(this.state.revision);
      return;
    }
    const index = this.state?.index || 0;
    if (index < this.lines.length) this.speak('intro', this.lines[index]);
    else if (this.state?.kind !== 'done')
      this.transition(
        'done',
        'Вводный инструктаж завершён. Я продолжу комментировать действия команды.',
      );
  }
}

// Hysteresis avoids reacting to brief clicks and pauses within one sentence.
export class VoiceActivity {
  constructor() {
    this.active = false;
    this.loud = 0;
    this.quiet = 0;
  }
  sample(rms, dt) {
    if (rms >= 0.015) {
      this.loud += dt;
      this.quiet = 0;
    } else {
      this.loud = 0;
      this.quiet += dt;
    }
    if (this.loud >= 0.18) this.active = true;
    if (this.quiet >= 0.8) this.active = false;
    return this.active;
  }
}
