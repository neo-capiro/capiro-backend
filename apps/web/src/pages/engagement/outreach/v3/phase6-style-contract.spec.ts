import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const source = (name: string) => readFileSync(path.join(DIR, name), 'utf8');

describe('Outreach V3 style loading contract', () => {
  it('loads the shared planning surface stylesheet from a production module', () => {
    const possibleLoaders = [
      source('TargetWorkspaceEntry.tsx'),
      source('ContextReviewSurface.tsx'),
      source('context-review-surface.css'),
      source('OutreachV3Route.tsx'),
      source('CurrentDecisionSurface.tsx'),
    ].join('\n');
    expect(possibleLoaders).toContain('planning-surfaces.css');
  });

  it('ports the example-placeholder and required-but-empty field treatments to vNext', () => {
    const base = source('outreach-v3.css');
    // outreach-decision-vnext.css is the :where()-scoped port of this file; the
    // treatments are what tell an exemplar from a saved value, so os.capiro.ai
    // cannot be allowed to lose them while app.capiro.ai keeps them.
    const ported = readFileSync(
      path.join(DIR, '../../../../vnext/pages/engagement/outreach-decision-vnext.css'),
      'utf8',
    );
    for (const rule of [
      '.ov3-field input::placeholder',
      '.ov3-field textarea::placeholder',
      '.ov3-field.is-unfilled input',
      '.ov3-field.is-filled em',
    ]) {
      expect(base).toContain(`\n${rule}`);
      expect(ported).toContain(`\n:where(.capiro-vnext-root .engagement-vnext) ${rule}`);
    }
  });

  it('keeps desktop, tablet, and mobile responsive rules in the accepted Phase 6 styles', () => {
    const planning = source('planning-surfaces.css');
    const base = source('outreach-v3.css');
    expect(planning).toContain('@media (max-width: 1180px)');
    expect(planning).toContain('@media (max-width: 760px)');
    expect(base).toMatch(/@media\s*\(max-width:\s*760px\)/);
  });
});