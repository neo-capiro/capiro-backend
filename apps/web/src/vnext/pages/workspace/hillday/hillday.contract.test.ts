/**
 * Hill Day module contract — pins the module's structure and the foundation
 * rules (no raw colour literals in the component CSS, routes wired, prototype
 * copy anchors present so a refactor cannot silently drop a screen).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = resolve(process.cwd(), 'src/vnext/pages/workspace/hillday');

function read(name: string): string {
  return readFileSync(resolve(DIR, name), 'utf8');
}

describe('hillday foundation contract', () => {
  it('component CSS carries no raw colour literals', () => {
    const css = read('hillday.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(css).toContain('.capiro-vnext-root');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/rgba?\s*\(/i);
  });

  it('keeps every palette literal in the token file only', () => {
    const tokens = read('hillday-tokens.css');
    // The ramp exists…
    expect(tokens).toContain('--hd-brand-600: #294e68');
    expect(tokens).toContain('--hd-gray-900: #101828');
    // …and ui.tsx / the surfaces never inline a hex.
    for (const name of ['ui.tsx', 'HillDayLibrary.tsx', 'HillDayWizard.tsx', 'HillDayEditor.tsx', 'DirectoryBrowser.tsx']) {
      const src = read(name).replace(/\/\*[\s\S]*?\*\//g, ' ');
      expect(src).not.toMatch(/#[0-9a-f]{6}\b/i);
    }
  });
});

describe('hillday backend wiring', () => {
  it('reads every surface from the workspace engine, never from fixtures', () => {
    const api = read('api.ts');
    expect(api).toContain("'/workspace-api/hillday'");
    expect(api).toContain('useApi()');
    expect(api).not.toContain('./fixtures');
    const fixtures = read('fixtures.ts');
    for (const gone of ['MEETINGS', 'DIRECTORY', 'THREADS', 'LIBRARY_DOCS', 'CLIENTS: ClientOption']) {
      expect(fixtures).not.toContain(`export const ${gone}`);
    }
    for (const name of ['HillDayLibrary.tsx', 'HillDayWizard.tsx', 'HillDayEditor.tsx']) {
      expect(read(name)).toContain('useHillDayApi()');
    }
  });
});

describe('hillday route wiring', () => {
  it('registers the three surfaces in WorkspaceVNextRoutes', () => {
    const routes = readFileSync(
      resolve(process.cwd(), 'src/vnext/pages/workspace/WorkspaceVNextRoutes.tsx'),
      'utf8',
    );
    expect(routes).toContain("import('./hillday/HillDayLibrary.js')");
    expect(routes).toContain("import('./hillday/HillDayWizard.js')");
    expect(routes).toContain("import('./hillday/HillDayEditor.js')");
    expect(routes).toContain("'/workspace/documents'");
    expect(routes).toContain("'/workspace/documents/new'");
    expect(routes).toContain('HILLDAY_DOC_ROUTE');
    // The dispatcher matches the path itself, so the editor must receive the
    // id as a prop — a bare <HillDayEditor /> never loads a document.
    expect(routes).toContain('<HillDayEditor documentId={hillDayMatch[1]} />');
  });
});

describe('hillday prototype parity anchors', () => {
  it('library: studio banner, recent documents table — no duplicate template picker', () => {
    const lib = read('HillDayLibrary.tsx');
    expect(lib).toContain('Template Studio');
    expect(lib).toContain('Recent documents');
    expect(lib).toContain('Client-ready documents drafted from platform evidence');
    // Template selection is the wizard's own step 1 (/workspace/documents/new)
    // — the library must not re-render the same blueprint grid.
    expect(lib).not.toContain('Start a workflow');
  });

  it('wizard: all six steps and the forward contract', () => {
    const wiz = read('HillDayWizard.tsx');
    expect(wiz).toContain("'Template', 'Sponsor', 'Meetings', 'Resolution', 'Context', 'Generate'");
    expect(wiz).toContain('What are you making?');
    expect(wiz).toContain('Who is the sponsor?');
    expect(wiz).toContain('Which meetings go in the packet?');
    expect(wiz).toContain('Confirm what we resolved');
    expect(wiz).toContain("Add what we don't know");
    expect(wiz).toContain('Generate packet');
    // Four attendee states each carry their affordance.
    expect(wiz).toContain('No Directory match');
    expect(wiz).toContain('Scheduler only');
    expect(wiz).toContain('Office may be stale');
    expect(wiz).toContain('Create Directory record');
    // Carry-over counter contract.
    expect(wiz).toContain('details carried');
  });

  it('editor: cover, summary table, per-section regenerate, quality + sources', () => {
    const ed = read('HillDayEditor.tsx');
    // The cover and glance table live in the extracted first-page component;
    // the editor owns the surrounding canvas and section controls.
    const firstPage = read('HillDayFirstPage.tsx');
    expect(ed).toContain("import { HillDayFirstPage } from './HillDayFirstPage.js'");
    expect(ed).toMatch(/<HillDayFirstPage\s+doc=\{doc\}/);
    expect(firstPage).toContain('The day at a glance');
    expect(firstPage).toContain('role="table" aria-label="The day at a glance"');
    expect(ed).toContain('Focus');
    expect(ed).toContain('Background');
    expect(ed).toContain('Regenerate');
    expect(ed).toContain('As generated ·');
    expect(ed).toContain('Context used');
    expect(ed).toContain('Sources used');
    expect(ed).toContain('Preview as client');
  });

  it('icons: registry carries the prototype-extracted glyph set', () => {
    const icons = read('icons.tsx');
    for (const name of [
      'CalendarCheck01',
      'Calendar2',
      'ClockRewind',
      'SwitchHorizontal01',
      'RefreshCw01',
      'FlipBackward',
      'Stars02',
      'Send01',
    ]) {
      expect(icons).toContain(`  ${name}: {`);
    }
  });
});
