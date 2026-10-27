// AI-endpoint route throttles (W0.8). The @Throttle decorator writes per-named
// throttler metadata onto the handler function (THROTTLER:LIMIT<name> /
// THROTTLER:TTL<name>, @nestjs/throttler v6). Reflecting it off the real
// controller prototype proves the caps are applied to the live endpoints without
// booting the app or its DI graph.

import 'reflect-metadata';
import { describe, expect, test } from '@jest/globals';
import { EngagementController } from './engagement.controller.js';

const LIMIT_KEY = (name: string) => `THROTTLER:LIMIT${name}`;

const proto = EngagementController.prototype as unknown as Record<string, unknown>;
const longLimit = (fn: unknown): number | undefined =>
  Reflect.getMetadata(LIMIT_KEY('long'), fn as object);
describe('AI endpoint per-route throttles (W0.8)', () => {
  test('talking-points: 40 per minute', () => {
    expect(longLimit(proto.generateTalkingPoints)).toBe(40);
  });

  test('a non-AI endpoint carries no per-route long override (uses the global limit)', () => {
    // outreachInsights is a cheap read — it must NOT inherit an AI cap.
    expect(longLimit(proto.outreachInsights)).toBeUndefined();
  });
});
