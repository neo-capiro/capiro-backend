// AI-endpoint route throttles (W0.8). The @Throttle decorator writes per-named
// throttler metadata onto the handler function (THROTTLER:LIMIT<name> /
// THROTTLER:TTL<name>, @nestjs/throttler v6). Reflecting it off the real
// controller prototype proves the caps are applied to the live endpoints without
// booting the app or its DI graph.

import 'reflect-metadata';
import { describe, expect, test } from '@jest/globals';
import { EngagementController } from './engagement.controller.js';

const LIMIT_KEY = (name: string) => `THROTTLER:LIMIT${name}`;
const TTL_KEY = (name: string) => `THROTTLER:TTL${name}`;

const proto = EngagementController.prototype as unknown as Record<string, unknown>;
const longLimit = (fn: unknown): number | undefined =>
  Reflect.getMetadata(LIMIT_KEY('long'), fn as object);
const longTtl = (fn: unknown): number | undefined =>
  Reflect.getMetadata(TTL_KEY('long'), fn as object);
const named = (window: string, fn: unknown): number | undefined =>
  Reflect.getMetadata(`THROTTLER:LIMIT${window}`, fn as object);

describe('AI endpoint per-route throttles (W0.8)', () => {
  test('generate-batch: 120 per minute', () => {
    expect(longLimit(proto.generateBatchEmails)).toBe(120);
    expect(longTtl(proto.generateBatchEmails)).toBe(60_000);
  });

  test('generate-batch does NOT override the per-second "short" or "medium" windows', () => {
    // Landmine guard (the plan's explicit warning): tightening the 30/s `short`
    // window on the fan-out endpoint would 429 the wizard's near-simultaneous
    // per-group POSTs from a single Generate click. Only `long` may be overridden.
    expect(named('short', proto.generateBatchEmails)).toBeUndefined();
    expect(named('medium', proto.generateBatchEmails)).toBeUndefined();
  });

  test('generate-draft: 40 per minute', () => {
    expect(longLimit(proto.generateOutreachDraft)).toBe(40);
    expect(longTtl(proto.generateOutreachDraft)).toBe(60_000);
  });

  test('talking-points: 40 per minute', () => {
    expect(longLimit(proto.generateTalkingPoints)).toBe(40);
  });

  test('template preview: 30 per minute', () => {
    expect(longLimit(proto.previewAiTemplate)).toBe(30);
  });

  test('a non-AI endpoint carries no per-route long override (uses the global limit)', () => {
    // outreachInsights is a cheap read — it must NOT inherit an AI cap.
    expect(longLimit(proto.outreachInsights)).toBeUndefined();
  });
});
