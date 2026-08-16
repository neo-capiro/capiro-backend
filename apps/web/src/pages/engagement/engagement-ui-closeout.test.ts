import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolve from the module path itself. `new URL('.', import.meta.url)` does not
// reliably yield a file: URL under this vitest/jsdom setup, which made every
// assertion in this suite fail before it ran.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = (path: string) => readFileSync(resolve(repo, path), 'utf8');

describe('Engagement UI closeout contract', () => {
  it('exposes all four Engagement rail destinations without duplicating canonical Meetings/Reports', () => {
    const manifest = source('src/vnext/adapters/routes/routeManifest.ts');
    expect(manifest).toContain("label: 'Meetings'");
    expect(manifest).toContain("path: '/engagement/meeting-library'");
    expect(manifest).toContain("label: 'Outreach'");
    expect(manifest).toContain("label: 'Reports'");

    const router = source('src/vnext/app/VNextRouter.tsx');
    expect(router).not.toContain('VNextMeetingsWorkspace');
    expect(router).not.toContain('VNextReportsTracker');
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

  it('removes prototype state controls and renders every server preflight check', () => {
    const workspace = source('src/vnext/pages/engagement/VNextOutreachWorkspace.tsx');
    expect(workspace).not.toContain('forcedState');
    expect(workspace).not.toContain('StateInspector');
    expect(workspace).not.toContain('System states');
    expect(workspace).toContain('preflight.checks.map');
    expect(workspace).toContain('14 deterministic checks');
  });

  it('keeps post-send learning reply-backed and governed', () => {
    const workspace = source('src/vnext/pages/engagement/VNextOutreachWorkspace.tsx');
    expect(workspace).toContain('Select a real inbound reply');
    expect(workspace).toContain('Submit for memory review');
    expect(workspace).not.toContain('Priya prefers the technical-briefing framing');
  });

  it('keeps unknown deliveries terminal for automation with no resend path', () => {
    const workspace = source('src/vnext/pages/engagement/VNextOutreachWorkspace.tsx');
    expect(workspace).toContain('Unknown is terminal for automation.');
    expect(workspace).toContain('does not automatically retry or resend');
    // Refreshing reads durable state; it must never become a resend control.
    // (The prose above legitimately contains the word, so assert on controls.)
    expect(workspace).not.toMatch(/resendOutreach|resendIntent|onResend|>\s*Resend/);
  });

  it('states the real test-send guarantee rather than implying a live send', () => {
    const workspace = source('src/vnext/pages/engagement/VNextOutreachWorkspace.tsx');
    expect(workspace).toContain('Send one exact version to your own mailbox');
    expect(workspace).toContain('No target receives anything.');
  });

  it('acknowledging held recipients never claims to unblock them', () => {
    const workspace = source('src/vnext/pages/engagement/VNextOutreachWorkspace.tsx');
    expect(workspace).toContain('This acknowledgment does not remove their blockers or send to them.');
  });

  it('has no dead post-send next actions', () => {
    const workspace = source('src/vnext/pages/engagement/VNextOutreachWorkspace.tsx');
    // /mailbox is not a route anywhere in this app; linking to it was a dead end.
    expect(workspace).not.toContain('href="/mailbox"');
    // Next actions navigate in-app instead of full-reloading the SPA.
    expect(workspace).not.toMatch(/<a className="uui-button" href=/);
    expect(workspace).toContain("navigate('/engagement/outreach')");
    expect(workspace).toContain("navigate('/engagement/meetings?compose=meeting')");
    // ...and the composer deep link is actually honoured by canonical Engagement.
    const engagement = source('src/pages/engagement/EngagementPage.tsx');
    expect(engagement).toContain("searchParams.get('compose') !== 'meeting'");
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

  it('keeps the dialog shell responsive and motion-safe', () => {
    const css = source('src/pages/engagement/meetings/engagement-dialog.css');
    // Bottom sheet on small viewports.
    expect(css).toContain('@media (max-width: 760px)');
    expect(css).toContain('align-items: end');
    expect(css).toContain('env(safe-area-inset-bottom)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
