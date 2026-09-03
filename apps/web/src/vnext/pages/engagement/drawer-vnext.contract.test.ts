import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Contract for the drawer's ported `.btn` family (drawer-vnext.css).
 *
 * The Engagement drawer reuses the Meetings prototype's `.btn` classes across
 * 31 call sites, and the only unscoped `.btn` base in the repo lives in
 * theme.css — which main.tsx loads ONLY on the legacy surface. So on
 * os.capiro.ai those buttons were native UA buttons, and a QA pass that
 * repainted `.btn-accent`'s fill on top of them read theme.css's base as if it
 * were live here. These assertions pin the two things that fixed it: the base
 * is defined on this surface, and the primary's fill comes from the module's
 * own token, not the shell's.
 *
 * jsdom applies no stylesheets, so the catchable form is the declared source
 * (same approach as foundation-contract.test.ts and the module's other CSS
 * contracts).
 */
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Declarations only, comments stripped.
 *
 * Every "this must not appear" assertion below names the token or selector it
 * forbids, and the CSS explains at length why that token was the wrong source
 * — so matching raw text would make the explanation itself the failure.
 */
const declarations = readFileSync(
  resolve(webRoot, 'src/vnext/pages/engagement/drawer-vnext.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, ' ');

describe('Engagement drawer button contract', () => {
  it('reads as CSS declarations after comments are stripped', () => {
    // Non-vacuity: a stripping bug must not silently satisfy every not.toMatch.
    expect(declarations).toMatch(/\.capiro-vnext-root \.engagement-vnext \{/);
  });

  it('defines the `.btn` base on this surface instead of relying on theme.css', () => {
    const base = /\.capiro-vnext-root \.engagement-vnext \.btn \{[^}]*\}/.exec(declarations)?.[0];
    expect(base).toBeDefined();
    expect(base!).toMatch(/padding:/);
    expect(base!).toMatch(/border-radius:/);
    expect(base!).toMatch(/background:/);
    expect(base!).toMatch(/font-size:/);
    // `.btn.sm` and `.btn-ghost` are both used in this tree (tab-kit,
    // MeetingDetailPanel), so the whole family has to be here, not just the base.
    expect(declarations).toMatch(/\.engagement-vnext \.btn\.sm \{/);
    expect(declarations).toMatch(/\.engagement-vnext \.btn\.btn-ghost \{/);
  });

  it('scopes every rule under the vNext root so app.capiro.ai is untouched', () => {
    for (const selector of declarations.matchAll(/(^|\})\s*([^{}@]+)\{/g)) {
      expect(selector[2]!.trim()).toMatch(/^\.capiro-vnext-root\b/);
    }
  });

  it('styles the accent button through Engagement’s own primary tokens (UI-parity §1.5)', () => {
    const accent = /\.engagement-vnext \.btn\.btn-accent \{[^}]*\}/.exec(declarations)?.[0];
    expect(accent).toBeDefined();
    expect(accent!).toMatch(/background: var\(--eng-primary-fill\)/);
    expect(accent!).toMatch(/box-shadow: var\(--eng-primary-shadow\)/);
    expect(declarations).toMatch(
      /\.engagement-vnext \.btn\.btn-accent:hover:not\(:disabled\) \{[^}]*var\(--eng-primary-fill-hover\)/,
    );
    // One role, one token source: the shell's metal face is byte-identical
    // today, which is exactly why wiring to it went unnoticed.
    expect(declarations).not.toMatch(/--uui-btn-metal/);
  });

  it('keeps the accent button the same height as the Cancel it sits beside', () => {
    const accent = /\.engagement-vnext \.btn\.btn-accent \{[^}]*\}/.exec(declarations)![0];
    // `border: 0` would shrink the primary by two border-widths against the
    // non-accent `.btn` in the same footer (VNextSendMeriModal,
    // VNextMeetingPanelChrome, MeetingDetailPanel, PrepTab, DebriefTab, NotesTab
    // all render a Cancel/primary pair).
    expect(accent).not.toMatch(/border:\s*0/);
    expect(accent).toMatch(/border: 1px solid transparent/);
  });

  it('gives the family a disabled state', () => {
    expect(declarations).toMatch(/\.engagement-vnext \.btn:disabled \{[^}]*cursor: not-allowed/);
  });

  it('no longer restyles every `.btn` in the module through a blanket radius rule', () => {
    // The QA pass shipped `.engagement-vnext :is(.btn, .ant-btn)`, which reached
    // all 31 buttons in the module (Meetings, Library, Reports) to give 12 of
    // them a radius. Nothing under `.engagement-vnext` is antd — the vNext tree
    // imports none — so both `.ant-btn` halves were dead as well.
    expect(declarations).not.toMatch(/:is\(/);
    expect(declarations).not.toMatch(/\.ant-btn/);
  });
});
