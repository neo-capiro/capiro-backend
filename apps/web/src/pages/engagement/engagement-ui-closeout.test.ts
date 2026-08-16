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
});
