import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const creation = readFileSync(
  resolve(__dirname, './WorkspaceQuickDraftCreation.tsx'),
  'utf8',
);
const routes = readFileSync(
  resolve(__dirname, '../WorkspaceVNextRoutes.tsx'),
  'utf8',
);

describe('Workspace two-screen quick-draft contract (aggregate intake)', () => {
  it('routes new documents to the quick-draft intake, gated by the two-step capability', () => {
    expect(routes).toContain("import('./creation/WorkspaceQuickDraftCreation.js')");
    // The stabilized flow is the deliberate capability-OFF fallback; both
    // routes coexist and CreationRoute picks one based on getTwoStepDraftCapability.
    expect(routes).toContain('getTwoStepDraftCapability');
    expect(routes).toContain('CreationRoute');
    expect(creation).not.toContain('CreationStep');
    expect(creation).not.toContain("setStep('type')");
  });

  it('keeps goal, templates, and all four source groups on the same screen', () => {
    expect(creation).toContain('What should this document accomplish?');
    expect(creation).toContain('Choose a submission template');
    expect(creation).toContain('Relevant context');
    expect(creation).toContain('Client saved documents');
    expect(creation).toContain('Sample documents');
    expect(creation).toContain('Capiro context');
    expect(creation).toContain("navigate('/workspace/studio')");
  });

  it('submits a single aggregate intake request and never runs the old multi-step chain', () => {
    expect(creation).toContain("from './intake-client.js'");
    expect(creation).toContain('submitIntake');
    expect(creation).toContain('crypto.randomUUID');

    // The old createDraft → initializeAgent → generateFromIntake chain is gone.
    expect(creation).not.toContain("from './quick-draft-client.js'");
    expect(creation).not.toContain('generateFromIntake');
    expect(creation).not.toContain('api.createDraft');
    expect(creation).not.toContain('api.initializeAgent');

    // The browser never reads file bodies; only pasted text is sent as content.
    expect(creation).not.toContain('file.text()');
    expect(creation).not.toContain('.text()');
    // Only server attachment ids are referenced — never browser-authored bodies.
    expect(creation).toContain('factualAttachmentIds');
    expect(creation).toContain('sampleAttachmentIds');
    expect(creation).toContain('pastedContext');
    expect(creation).toContain('pastedSample');
  });

  it('uploads through the attachment pipeline and reports real upload states', () => {
    expect(creation).toContain('/api/engagement/attachments/upload-url');
    expect(creation).toContain('/api/engagement/attachments/confirm');
    expect(creation).toContain('/api/engagement/attachments/');
    expect(creation).toContain("status: 'uploading'");
    expect(creation).toContain("status: 'scanning'");
    expect(creation).toContain("status: 'extracting'");
    expect(creation).toContain("status: 'ready'");
    expect(creation).toContain("status: 'failed'");
  });

  it('shows only enabled Capiro context domains and gates the disabled ones', () => {
    expect(creation).toContain("'client-profile'");
    expect(creation).toContain("'institutional-memory'");
    expect(creation).toContain("'strategies'");
    expect(creation).toContain("'relationships'");
    expect(creation).toContain("'activity'");
    expect(creation).toContain("'mailbox'");
    expect(creation).toContain("'client-files'");
    expect(creation).toContain('Not available yet');
    // Disabled domains are never default-selected.
    expect(creation).toContain("new Set(['client-profile'])");
  });

  it('uses the governed Max endpoint and separates samples from facts', () => {
    expect(creation).toContain('MAX REASONING');
    expect(creation).toContain('STYLE ONLY');
  });

  it('redirects to the editor immediately after the 202 response', () => {
    expect(creation).toContain('navigate(`/workspace/${response.draftId}`');
    expect(creation).toContain('replace: true');
    expect(creation).toContain('Opening editor');
  });

  it('suppresses double submission of the generate action', () => {
    expect(creation).toContain('submitting');
  });
});
