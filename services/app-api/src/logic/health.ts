import { Injectable } from '@nestjs/common';

function setting(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 3600)
    throw new Error(`Invalid health setting: ${name}`);
  return Number(value);
}

/** Bounded sliding window, matching the auth process health circuit. */
@Injectable()
export class HealthCircuit {
  private readonly threshold = setting('HEALTH_ERROR_THRESHOLD', 3);
  private readonly window = setting('HEALTH_WINDOW_SECONDS', 10) * 1000;
  private readonly cooldown = setting('HEALTH_COOLDOWN_SECONDS', 15) * 1000;
  private errors: number[] = [];
  private excludedUntil = 0;

  record(status: number, now = performance.now()): boolean {
    if (status < 500 || status > 599 || now < this.excludedUntil) return false;
    this.errors = this.errors.filter((time) => now - time < this.window);
    this.errors.push(now);
    if (this.errors.length < this.threshold) return false;
    this.errors = [];
    this.excludedUntil = now + this.cooldown;
    return true;
  }

  ready(now = performance.now()): boolean {
    return now >= this.excludedUntil;
  }
}
