// Identity and administrator capability are accepted only from the WSS server.
// Numeric peer IDs remain transport keys; they are never display names.
export class Participants {
  constructor() {
    this.reset();
  }
  reset() {
    this.admin = false;
    this.players = new Map();
    this.updatedAt = -Infinity;
  }
  accept(message, now = performance.now()) {
    if (!Array.isArray(message.players)) return;
    this.admin = message.admin === true;
    this.updatedAt = now;
    this.players = new Map(
      message.players
        .filter((p) => Number.isSafeInteger(p.id) && p.id > 0)
        .map((p) => [
          p.id,
          {
            email: typeof p.email === 'string' ? p.email.slice(0, 128) : '',
            ping: this.admin ? metric(p.ping, 5000) : null,
            fps: this.admin ? metric(p.fps, 1000) : null,
          },
        ]),
    );
  }
  label(id) {
    return this.players.get(id)?.email || 'Участник';
  }
  rows(now = performance.now()) {
    if (!this.admin) return [];
    const fresh = now - this.updatedAt < 5000;
    return [...this.players].map(([id, p]) => ({
      id,
      email: this.label(id),
      ping: fresh ? p.ping : null,
      fps: fresh ? p.fps : null,
    }));
  }
  text(now = performance.now()) {
    return this.rows(now)
      .map((p) => `${p.email} · ${p.ping ?? '—'} мс · ${p.fps ?? '—'} FPS`)
      .join('\n');
  }
}
function metric(value, max) {
  return Number.isFinite(value) && value >= 0 && value <= max
    ? Math.round(value)
    : null;
}

export function renderParticipants(section, participants, now) {
  section.hidden = !participants.admin;
  const panel = section.closest('aside');
  panel?.classList.toggle('admin-metrics', participants.admin);
  if (panel) {
    const toolbar = document.getElementById('toolbar');
    const top = Math.max(
      91,
      (toolbar?.getBoundingClientRect().bottom || 0) + 12,
    );
    panel.style.top = participants.admin ? `${top}px` : '';
    panel.style.maxHeight = participants.admin
      ? `calc(100dvh - ${top + 100}px)`
      : '';
  }
  const body = section.querySelector('tbody');
  const rows = participants.rows(now);
  // Keep email strings as text, never HTML (including legacy account names).
  body.replaceChildren(
    ...rows.map((player) => {
      const row = document.createElement('tr');
      for (const value of [
        player.email,
        player.ping ?? '—',
        player.fps ?? '—',
      ]) {
        const cell = document.createElement('td');
        cell.textContent = String(value);
        row.append(cell);
      }
      return row;
    }),
  );
}
