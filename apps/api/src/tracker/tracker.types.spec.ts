import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_TRIGGERS } from './tracker.types.js';

/**
 * REGRESSION (2026-07-10, W2.1): this file's DEFAULT_TRIGGERS and
 * apps/intel-api's DEFAULT_TRIGGERS (tracker-watchlist.service.ts) silently
 * diverged (this one was missing fiscalNote/sponsorMomentum/deadline). There
 * is no cross-package TS import between the two apps, so this reads
 * intel-api's source as text (the same static-safety-net pattern used by
 * apps/api/scripts/sync-legiscan-masterlist.spec.ts's table-name check) and
 * diffs the two literal arrays — it fails the moment either list changes
 * without the other being updated to match.
 */
function extractTriggerArray(source: string, constName: string): string[] {
  const re = new RegExp(`${constName}\\s*:\\s*readonly string\\[\\]\\s*=\\s*\\[([\\s\\S]*?)\\]`);
  const match = source.match(re);
  if (!match) throw new Error(`could not find ${constName} array literal`);
  return Array.from(match[1]!.matchAll(/'([a-zA-Z0-9_]+)'/g)).map((m) => m[1]!);
}

describe('DEFAULT_TRIGGERS parity with apps/intel-api (W2.1)', () => {
  it('apps/api and apps/intel-api DEFAULT_TRIGGERS are the same set', () => {
    const intelApiPath = path.join(
      __dirname,
      '../../../intel-api/src/tracker/tracker-watchlist.service.ts',
    );
    const intelApiSource = fs.readFileSync(intelApiPath, 'utf8');
    const intelApiTriggers = extractTriggerArray(intelApiSource, 'DEFAULT_TRIGGERS');

    expect(intelApiTriggers.length).toBeGreaterThan(0); // the extractor itself found something
    expect(new Set(DEFAULT_TRIGGERS)).toEqual(new Set(intelApiTriggers));
  });
});
