/**
 * Defense Budget vNext — no-fixture-fallback contract (task §22).
 *
 * The `Capiro Defense Budget - Untitled UI.dc.html` prototype is visual
 * reference only; its embedded fixture array (13 programs, e.g. PE
 * `0605053A` "Ground Robotics", client "Overland AI") never shipped into this
 * repo, and this test keeps it that way — both by import-path shape and by
 * scanning for the prototype's own literal identifiers leaking into
 * production source.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MODULE_ROOT = join(__dirname);
const SUSPICIOUS_IMPORT = /from\s+['"][^'"]*(fixture|prototype|\.dc\.html)[^'"]*['"]/i;

// Literal identifiers that exist ONLY in the prototype's embedded fixture
// array (docs/prototypes/defense-budget-vnext-design.md §7) — real production
// PE codes and client names never coincide with these by construction.
const PROTOTYPE_ONLY_LITERALS = [
  '0605053A', // prototype fixture PE code ("Ground Robotics")
  'Ground Robotics',
  'Overland AI',
  'Aperture Defense',
  'ShiftWave',
  'Boresight',
  'Revere Federal',
  '4868W12002',
  'Robotics & Applique Systems',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|css)$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('Defense Budget vNext — production code never imports or embeds prototype fixtures', () => {
  const files = walk(MODULE_ROOT);

  it('found source files to scan (the walk itself is not silently empty)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('no file imports from a fixture/prototype-shaped module path', () => {
    const offenders = files.filter((f) => SUSPICIOUS_IMPORT.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no file embeds a literal identifier that exists only in the prototype fixture', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const literal of PROTOTYPE_ONLY_LITERALS) {
        if (source.includes(literal)) {
          offenders.push(`${file}: ${literal}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
