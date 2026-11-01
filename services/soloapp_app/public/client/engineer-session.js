import { REACTOR_MAP } from '../shared/room.js';
export const ENGINEER_POSITION = [3.95, 0, 7.5];
export const QUESTION_RADIUS = 2.5;
export const HEARING_RADIUS = 6.5;
export function nearEngineer(state, radius) {
  return (
    state?.map === REACTOR_MAP &&
    Array.isArray(state.position) &&
    state.position.length === 3 &&
    state.position.every(Number.isFinite) &&
    Math.hypot(...state.position.map((n, i) => n - ENGINEER_POSITION[i])) <=
      radius
  );
}

// Short renewable claims prevent competing answers. A simultaneous voice start
// converges on the lowest peer ID before VAD submits a complete question.
export class EngineerSession {
  constructor(clock = () => performance.now()) {
    this.clock = clock;
    this.turns = new Map();
  }
  receive(peer, message) {
    if (
      !Number.isSafeInteger(peer) ||
      peer < 0 ||
      !message ||
      typeof message.turn !== 'string' ||
      !message.turn ||
      message.turn.length > 80 ||
      !['listening', 'thinking', 'answer', 'idle'].includes(message.stage) ||
      typeof message.text !== 'string' ||
      message.text.length > 1200
    )
      return false;
    if (message.stage === 'idle') {
      if (this.turns.get(peer)?.turn === message.turn) this.turns.delete(peer);
    } else this.turns.set(peer, { ...message, expires: this.clock() + 8000 });
    return true;
  }
  owner(members) {
    for (const [id, turn] of this.turns)
      if (turn.expires <= this.clock() || !members.has(id))
        this.turns.delete(id);
    return this.turns.size ? Math.min(...this.turns.keys()) : null;
  }
}
