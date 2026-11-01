import { encodeWav, SAMPLE_RATE } from './speech-audio.js';
import { operations } from './generated/api.js';

// Local microphone only. A silence boundary produces one bounded, isolated turn.
export class ProfessorVoiceTurn {
  constructor({
    request,
    onResult,
    onState = () => {},
    onError,
    onSpeechStart = () => true,
  }) {
    Object.assign(this, { request, onResult, onState, onError, onSpeechStart });
    this.buffer = new Float32Array(8 * SAMPLE_RATE);
    this.length = this.silence = this.voiced = 0;
    this.busy = this.cancelled = false;
    this.chain = Promise.resolve();
  }
  push(samples) {
    if (this.cancelled || this.busy) return;
    for (let start = 0; start < samples.length; start += 320) {
      const part = samples.subarray(start, start + 320);
      const energy =
        part.reduce((sum, value) => sum + value * value, 0) / part.length;
      const speaking = energy >= 0.000064;
      if (!this.length && (!speaking || !this.onSpeechStart())) continue;
      const size = Math.min(part.length, this.buffer.length - this.length);
      this.buffer.set(part.subarray(0, size), this.length);
      this.length += size;
      this.silence = speaking ? 0 : this.silence + size;
      if (speaking) this.voiced += size;
      if (
        this.length === this.buffer.length ||
        this.silence >= 0.8 * SAMPLE_RATE
      ) {
        this.flush();
        if (this.busy) return;
      }
    }
  }
  flush() {
    if (this.cancelled || this.busy) return;
    const samples = this.buffer.slice(0, this.length);
    const voiced = this.voiced;
    this.buffer.fill(0);
    this.length = this.silence = this.voiced = 0;
    if (voiced < SAMPLE_RATE / 4) {
      this.onState('');
      return;
    }
    this.busy = true;
    this.abort = new AbortController();
    this.onState('Думаю…');
    this.chain = Promise.resolve()
      .then(() => this.request(samples, this.abort.signal))
      .then(async (result) => {
        if (!this.cancelled) await this.onResult(result);
      })
      .catch((error) => {
        if (!this.cancelled) this.onError(error);
      })
      .finally(() => {
        samples.fill(0);
        this.busy = false;
        if (!this.cancelled) this.onState('');
      });
  }
  finish() {
    this.flush();
    return this.chain;
  }
  cancel() {
    this.cancelled = true;
    this.abort?.abort();
    this.buffer.fill(0);
  }
}

export async function askProfessor(samples, token, signal) {
  return askAudio(
    samples,
    token,
    signal,
    operations.professor_respond.path,
    'Профессор',
  );
}

export async function askEngineer(samples, token, signal) {
  return askAudio(
    samples,
    token,
    signal,
    operations.engineer_respond.path,
    'Главный инженер',
  );
}

async function askAudio(samples, token, signal, path, speaker) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav', Authorization: `Bearer ${token}` },
    body: encodeWav(samples),
    signal: AbortSignal.any([signal, AbortSignal.timeout(190000)]),
    credentials: 'omit',
    cache: 'no-store',
  });
  if (!response.ok)
    throw Error(
      response.status === 429
        ? `${speaker} занят. Повторите вопрос через несколько секунд.`
        : `${speaker} временно недоступен. Попробуйте ещё раз.`,
    );
  const data = await response.json();
  if (
    typeof data.transcript !== 'string' ||
    typeof data.answer !== 'string' ||
    typeof data.audio_base64 !== 'string' ||
    data.audio_base64.length > 6 * 1024 * 1024
  )
    throw Error('Некорректный ответ сервера');
  return data;
}
