import { operations } from './generated/api.js';
export async function request(name, body, token) {
  const op = operations[name];
  if (!op || op.websocket) throw Error('Unknown HTTP operation');
  const response = await fetch(op.path, {
    method: op.method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(op.timeout),
    cache: 'no-store',
    credentials: 'omit',
  });
  const data =
    response.status === 204 ? null : await response.json().catch(() => null);
  if (!op.success.includes(response.status)) {
    const error = Error(data?.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}
export async function login(email, password, registration) {
  const body = { username: email.trim().toLowerCase(), password };
  if (registration) await request('auth_register', body);
  const session = await request('auth_login', body);
  return {
    token: session.access_token,
    expires_at: Math.floor(Date.now() / 1000) + session.expires_in,
    user: { id: session.user_id, email: body.username },
  };
}
export const signalPath = operations.signal.path;
