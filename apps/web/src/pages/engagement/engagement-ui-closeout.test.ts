import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolve from the module path itself. `new URL('.', import.meta.url)` does not
// reliably yield a file: URL under this vitest/jsdom setup, which made every
// assertion in this suite fail before it ran.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = (path: string) => readFileSync(resolve(repo, path), 'utf8');

/**
 * Source text with comments removed.
 *
 * A "this string must not appear" assertion has to read code only: the file
 * that fixed a defect almost always names the defect in the comment explaining
 * the fix, so matching raw source makes the explanation itself the failure.
 */
const code = (path: string) =>
  source(path)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('Engagement UI closeout contract', () => {
  it('exposes all four Engagement rail destinations without duplicating canonical Meetings/Reports', () => {
    const manifest = source('src/vnext/adapters/routes/routeManifest.ts');
    expect(manifest).toContain("label: 'Meetings'");
    expect(manifest).toContain("path: '/engagement/meeting-library'");
    expect(manifest).toContain("label: 'Outreach'");
    expect(manifest).toContain("label: 'Reports'");

    const router = source('src/vnext/app/VNextRouter.tsx');
    expect(router).not.toContain('VNextMeetingsWorkspace');
    // Reports phase (2026-08-16): VNextReportsTracker now ships for real —
    // wired deliberately into VNextEngagementRoutes.tsx (below), never into
    // VNextRouter.tsx directly, same architectural boundary every other
    // per-destination vNext component (VNextMeetingsWorkspace,
    // VNextMeetingLibrary, VNextOutreachWorkspace) already respects. This
    // assertion originally existed to catch an *accidental* premature/
    // bypassing wire-up before Reports had a real component; now that the
    // wire-up is real and deliberate, it continues to guard the same
    // boundary (VNextRouter.tsx only ever knows about VNextEngagementRoutes
    // as a whole) rather than blocking the shipped feature.
    expect(router).not.toContain('VNextReportsTracker');
    const engagementRoutes = source('src/vnext/pages/engagement/VNextEngagementRoutes.tsx');
    expect(engagementRoutes).toContain('VNextReportsTracker');
  });

  it('ships the complete production window inventory through one dialog shell', () => {
    const engagement = source('src/pages/engagement/EngagementPage.tsx');
    const detail = source('src/pages/engagement/meetings/MeetingDetailPanel.tsx');
    const prep = source('src/pages/engagement/meetings/PrepTab.tsx');
    const notes = source('src/pages/engagement/meetings/NotesTab.tsx');
    const debrief = source('src/pages/engagement/meetings/DebriefTab.tsx');
    const sendMeri = source('src/pages/engagement/meetings/SendMeriModal.tsx');
    const share = source('src/pages/engagement/meetings/ShareConfirmation.tsx');

    expect(engagement).toContain('New meeting');
    expect(engagement).toContain('rootClassName="redesign"');
    expect(sendMeri).toContain('Send Meri to take notes');
    expect(share).toContain('Share');
    expect(detail).toContain('title="Client assignment"');
    expect(detail).toContain('title="Attendees"');
    expect(prep).toContain('title="Edit prep"');
    expect(notes).toContain('title="Edit meeting notes"');
    expect(debrief).toContain('title="Edit debrief"');
    expect(debrief).toContain('title="Transcript and attachments"');
    expect(engagement).toContain('Add target office');
    expect(engagement).toContain('Target office · linked meetings');
    expect(engagement).toContain('No meetings are linked to this target office yet.');
  });

  /*
   * The seven assertions below used to read `VNextOutreachWorkspace.tsx`, the
   * seven-step planning rail that the prototype-parity rebuild replaced. Their
   * SUBJECTS moved — preflight and the send gate to the Send step, the send
   * record to `outreach-send-record.tsx` — but the guarantees are the same
   * ones, so they follow the code rather than being deleted with the file.
   * Where the prototype supplies its own words for a promise, those are the
   * words asserted; see docs/engagement-vnext/OUTREACH-PROTOTYPE-PARITY.md.
   */
  it('renders the real server preflight checks and never a prototype state switch', () => {
    const send = source('src/vnext/pages/engagement/outreach-step-send.tsx');
    expect(send).not.toContain('forcedState');
    expect(send).not.toContain('StateInspector');
    expect(send).not.toContain('System states');
    // The rows come from the server's own check list.
    expect(send).toContain('preflight?.result.checks');
    // The prototype hardcodes "Fourteen checks". The heading counts what the
    // server actually returned, which is what `COUNT_WORDS` is indexed by.
    const sendCode = code('src/vnext/pages/engagement/outreach-step-send.tsx');
    // A stripper that removed everything would make the next assertion pass
    // for the wrong reason.
    expect(sendCode).toContain('COUNT_WORDS[checkCount]');
    expect(sendCode).not.toContain('The prototype hard-codes');
    expect(sendCode).not.toMatch(/Fourteen checks|14 deterministic checks/);
    expect(send).toContain('COUNT_WORDS[checkCount]');
  });

  it('keeps the real production states without a debug switch', () => {
    const builder = source('src/vnext/pages/engagement/VNextOutreachCampaignBuilder.tsx');
    const route = source('src/pages/engagement/outreach/v3/OutreachV3CompleteRoute.tsx');
    expect(builder).toContain('isBootstrapping'); // loading
    expect(builder).toContain('This campaign could not be loaded'); // session error
    expect(route).toContain('connectionWarning'); // mailbox disconnected
    // A failed WRITE must not be reported as a failed load — that would throw
    // away everything the user had typed on the step.
    expect(builder).toContain('errorMessage && !session');
  });

  it('keeps post-send learning reply-backed and governed', () => {
    const record = source('src/vnext/pages/engagement/outreach-send-record.tsx');
    expect(record).toContain('Select a real inbound reply');
    expect(record).toContain('Submitted for governed review. Nothing was auto-committed.');
    expect(record).toContain('Required before activation');
    // No invented example of what Meri "learned".
    expect(record).not.toContain('Priya prefers the technical-briefing framing');
  });

  it('keeps unknown deliveries terminal for automation with no resend path', () => {
    const record = source('src/vnext/pages/engagement/outreach-send-record.tsx');
    const model = source('src/vnext/pages/engagement/outreach-send-record-model.ts');
    expect(record).toContain('Unknown is never silently treated as delivered, and nothing retries itself.');
    // Terminal in the model too, or the record polls an outcome forever.
    expect(model).toContain("'delivery_unknown'");
    // Refreshing reads durable state; it must never become a resend control.
    expect(record).not.toMatch(/resendOutreach|resendIntent|onResend|>\s*Resend/);
  });

  it('states the real test-send guarantee rather than implying a live send', () => {
    const send = source('src/vnext/pages/engagement/outreach-step-send.tsx');
    expect(send).toContain('Send one to yourself first');
    expect(send).toContain('The selected exact version goes only to your own connected mailbox.');
  });

  it('tells the truth about held recipients without gating the send on a checkbox', () => {
    const send = source('src/vnext/pages/engagement/outreach-step-send.tsx');
    // The disclosure is the part that matters, and it survives: the held list
    // says what happens, and the confirm dialog restates it at the
    // irreversible moment.
    expect(send).toContain('They are held out of this send and receive nothing.');
    expect(send).toContain('will remain held. They will not receive an email.');
    // A group is one shared email, so "they receive nothing" would be false —
    // the held-out recipient is on the address line of a message the rest get.
    expect(send).toContain('A group cannot hold one recipient out of a message the others receive.');
    // The acknowledgement checkbox is deliberately gone. The server could only
    // ever check that the client had sent `true`, never persisted it, and
    // dropped held recipients from the envelope either way — so it withheld
    // Send and forced a second preflight round-trip without protecting anyone.
    expect(send).not.toContain('I understand those recipients will not be contacted');
    expect(send).not.toContain('acknowledgeHeldOut');
  });

  it('has no dead post-send next actions', () => {
    const record = source('src/vnext/pages/engagement/outreach-send-record.tsx');
    // /mailbox is not a route anywhere in this app; linking to it was a dead end.
    expect(record).not.toContain('href="/mailbox"');
    // Next actions are buttons that do something in-app, not full page loads.
    expect(record).not.toMatch(/<a className="ov3p1-button" href=/);
    // The one control with no backend says so in its own copy rather than
    // pretending to have created something.
    expect(record).toContain('No campaign was created from this control.');
  });

  it('gives every shared production window a loading and error state', () => {
    const dialog = source('src/pages/engagement/meetings/EngagementDialog.tsx');
    // The primitive owns these so no caller can silently omit them.
    expect(dialog).toContain('role="alert"');
    expect(dialog).toContain('role="status"');
    expect(dialog).toContain('aria-busy');
    expect(dialog).toContain('aria-modal="true"');
    // Closing is refused while a mutation is in flight or edits are unsaved.
    expect(dialog).toContain('if (state.busy) return;');
    expect(dialog).toContain('window.confirm');

    // Each promoted window feeds real mutation state into those slots.
    for (const file of [
      'src/pages/engagement/meetings/MeetingDetailPanel.tsx',
      'src/pages/engagement/meetings/PrepTab.tsx',
      'src/pages/engagement/meetings/NotesTab.tsx',
      'src/pages/engagement/meetings/DebriefTab.tsx',
    ]) {
      expect(source(file)).toMatch(/error=\{[a-zA-Z]+\.isError/);
    }
  });

  it('resolves the Engagement accent through its own literal navy ramp, not the shell tokens', () => {
    // Product override (2026-08-16): Engagement gets its own vNext-only fork
    // on the mockup's literal navy (#294E68), unlike Strategies/Dashboard/
    // LegiWatch, which resolved this same mockup-navy-vs-shell-indigo
    // divergence by unifying on the shell's indigo brand tokens. This is a
    // confirmed, intentional per-module exception — lock it in so it isn't
    // mistaken for a regression back to the shell ramp later.
    for (const path of [
      'src/vnext/pages/engagement/engagement.css',
      'src/vnext/pages/engagement/engagement-ui-closeout.css',
    ]) {
      const css = source(path);
      expect(css).toMatch(/--eng-accent:\s*#294e68/i);
      expect(css).toMatch(/--eng-accent-hover:\s*#1f3d52/i);
      expect(css).toMatch(/--eng-accent-soft:\s*#edf3f7/i);
      expect(css).toMatch(/--eng-accent-border:\s*#c3d5e1/i);
      expect(css).not.toMatch(/--eng-accent:\s*var\(--uui-brand-solid/i);
    }
    // Focus ring — SUPERSEDED 2026-08-17 by ENGAGEMENT-UI-PARITY.md §1.6,
    // which specifies `:focus-visible { outline: 2px solid #4A7A9B }` for
    // this module. The previous contract here was "focus rings stay
    // shell-consistent" (i.e. `var(--uui-focus-ring)`, the shell's #4E5BA6
    // indigo). That is the same mockup-navy-vs-shell-indigo call the accent
    // ramp above already resolved in the mockup's favour for Engagement
    // specifically, so the ring now follows the accent rather than splitting
    // from it. Locked to the literal so a silent revert to the shell token is
    // still caught.
    expect(source('src/vnext/pages/engagement/engagement.css')).toMatch(
      /outline:\s*2px solid #4a7a9b/i,
    );
    expect(source('src/vnext/pages/engagement/engagement.css')).not.toMatch(
      /outline:\s*2px solid var\(--uui-focus-ring/i,
    );
  });

  it('wires Engagement mono type through the shared IBM Plex Mono token', () => {
    // Every other reskinned vNext screen (Workspace, Program Elements,
    // LegiWatch, Client CRM, Meri) renders IBM Plex Mono the same way: the
    // face itself loads once, globally, via the existing <link> in
    // index.html (fonts.googleapis.com) — no module owns its own webfont
    // infrastructure. Engagement now follows that exact precedent instead of
    // the bare system-mono stack it used to fall back to.
    const css = source('src/vnext/pages/engagement/engagement.css');
    expect(css).toContain('--eng-font-mono: var(--capiro-type-family-mono)');

    const tokens = source('src/vnext/foundations/tokens.css');
    expect(tokens).toContain("--capiro-type-family-mono: 'IBM Plex Mono'");

    // Engagement itself still ships no NEW webfont-loading mechanism of its
    // own — every file here only references the shared token above.
    for (const file of [
      'src/vnext/pages/engagement/engagement.css',
      'src/vnext/pages/engagement/engagement-dialog.css',
      'src/pages/engagement/engagement-ui-closeout.css',
      'src/vnext/pages/engagement/engagement-ui-closeout.css',
    ]) {
      expect(source(file)).not.toContain('fonts.googleapis.com');
    }
  });

  it('keeps the dialog shell responsive and motion-safe', () => {
    const css = source('src/vnext/pages/engagement/engagement-dialog.css');
    // Bottom sheet on small viewports, at the SHELL's mobile boundary.
    // This asserted 760px, 19px short of the canonical 779px
    // (foundations/responsive.css: mobile is `max-width: 779px`, named from
    // `--capiro-bp-mobile: 780px`). Between 760 and 779 the dialog had already
    // become a bottom sheet while the shell was still rendering its desktop
    // layout behind it.
    expect(css).toContain('@media (max-width: 779px)');
    expect(css).not.toContain('max-width: 760px');
    expect(css).toContain('align-items: end');
    expect(css).toContain('env(safe-area-inset-bottom)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
