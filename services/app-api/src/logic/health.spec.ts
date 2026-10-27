import { HealthCircuit } from './health.js';

describe('HealthCircuit', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('ignores client errors and excludes after three server errors, then recovers', () => {
    const health = new HealthCircuit();
    for (let i = 0; i < 20; i++) health.record(401, 100);
    expect(health.ready(100)).toBe(true);
    expect(health.record(500, 100)).toBe(false);
    expect(health.record(502, 200)).toBe(false);
    expect(health.record(503, 300)).toBe(true);
    expect(health.ready(15299)).toBe(false);
    expect(health.record(500, 1000)).toBe(false);
    expect(health.ready(15300)).toBe(true);
  });
  it('expires old failures and honors environment settings', () => {
    vi.stubEnv('HEALTH_ERROR_THRESHOLD', '2');
    vi.stubEnv('HEALTH_WINDOW_SECONDS', '1');
    vi.stubEnv('HEALTH_COOLDOWN_SECONDS', '2');
    const health = new HealthCircuit();
    expect(health.record(500, 0)).toBe(false);
    expect(health.record(500, 1000)).toBe(false);
    expect(health.record(500, 1500)).toBe(true);
    expect(health.ready(3499)).toBe(false);
    expect(health.ready(3500)).toBe(true);
  });
  it.each(['0', '-1', '10oops', '3601', '1.5'])('rejects invalid config %s', (value) => {
    vi.stubEnv('HEALTH_COOLDOWN_SECONDS', value);
    expect(() => new HealthCircuit()).toThrow('Invalid health setting');
  });
});
