import { ServiceUnavailableException } from '@nestjs/common';

export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function parseHcmBalance(raw: unknown): number {
  const n = Number(raw);
  if (!isFinite(n) || n < 0) {
    throw new ServiceUnavailableException('HCM returned invalid balance');
  }
  return n;
}
