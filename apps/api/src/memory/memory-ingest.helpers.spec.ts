import {
  emailThreadToItem,
  meetingToItem,
  meriSessionToItem,
  buildPromotionCandidate,
  type EmailThreadInput,
  type MeriSessionInput,
} from './memory-ingest.helpers.js';
import { vaultPathForItem } from './memory-render.helpers.js';
import { renderMemoryItem } from './memory-render.helpers.js';
import { splitDocument, parseFrontmatter, parseSections } from './memory-parse.helpers.js';

const TENANT = '11111111-1111-1111-1111-111111111111';

function emailInput(over: Partial<EmailThreadInput> = {}): EmailThreadInput {
  return {
    tenantId: TENANT,
    threadId: 'thr-1',
    subject: 'Q3 approps strategy',
    clientId: 'acme-corp',
    ownerUserId: 'user-7',
    inScopeDomains: ['acme.com'],
    messageCount: 4,
    lastMessageAt: '2026-06-20T12:00:00.000Z',
    summary: 'Discussed markup timing. [[bill:hr-1234]]',
    wikilinks: ['[[bill:hr-1234]]'],
    ...over,
  };
}

describe('memory ingestion renderers (Phase 2)', () => {
  // #7 + #4: a client-linked thread routes to the client vault, tenant-visible.
  it('routes a client-linked email thread to the client vault (tenant-visible)', () => {
    const item = emailThreadToItem(emailInput());
    expect(item.visibility).toBe('tenant');
    expect(item.clientId).toBe('acme-corp');
    expect(vaultPathForItem(item)).toBe('clients/acme-corp/threads/thr-1.md');
  });

  // #4 + #7: a NON-client thread stays user-private — never widened to a client.
  it('keeps a non-client email thread user-private', () => {
    const item = emailThreadToItem(emailInput({ clientId: null }));
    expect(item.visibility).toBe('user');
    expect(item.ownerUserId).toBe('user-7');
    expect(vaultPathForItem(item)).toBe('users/user-7/threads/thr-1.md');
  });

  // #4: the scoping decision is RECORDED (audit trail), not re-derived.
  it('records the in-scope domains the worker decided', () => {
    const item = emailThreadToItem(emailInput({ inScopeDomains: ['acme.com', 'acme.org'] }));
    const scope = item.sections.find((s) => s.key === 'scope');
    expect(scope?.body).toContain('acme.com');
    expect(scope?.body).toContain('acme.org');
    expect(scope?.owner).toBe('engine');
  });

  // ingested items carry an empty human section for analyst additions.
  it('gives ingested threads a human analyst-notes section', () => {
    const item = emailThreadToItem(emailInput());
    const notes = item.sections.find((s) => s.key === 'analyst-notes');
    expect(notes?.owner).toBe('human');
  });

  // ingested items still round-trip render->parse (consistency with the core).
  it('ingested thread round-trips render->parse->render', () => {
    const item = emailThreadToItem(emailInput());
    const md1 = renderMemoryItem(item);
    const { frontmatter, body } = splitDocument(md1);
    const fm = parseFrontmatter(frontmatter);
    const rebuilt = { ...item, ...fm, ownerUserId: fm.ownerUserId, sections: parseSections(body) };
    expect(renderMemoryItem(rebuilt)).toBe(md1);
  });

  it('routes a meeting under the client meetings/ folder by date+slug', () => {
    const item = meetingToItem({
      tenantId: TENANT,
      meetingId: 'mtg-1',
      clientId: 'acme-corp',
      title: 'Hill Day Prep',
      date: '2026-07-01',
      prep: 'Bring the one-pager.',
      wikilinks: [],
    });
    expect(vaultPathForItem(item)).toBe('clients/acme-corp/meetings/2026-07-01-hill-day-prep.md');
    // prep is engine-owned; debrief is human-owned
    expect(item.sections.find((s) => s.key === 'prep')?.owner).toBe('engine');
    expect(item.sections.find((s) => s.key === 'debrief')?.owner).toBe('human');
  });

  // Gap 4: a tenant-readable debrief is attached as an ENGINE section (so it is
  // never embedded — embeddableText only embeds human sections) and only when
  // debriefBody is provided.
  it('attaches recorded debrief content as an engine section when provided', () => {
    const withBody = meetingToItem({
      tenantId: TENANT,
      meetingId: 'mtg-2',
      clientId: 'acme-corp',
      title: 'Debrief Test',
      date: '2026-07-02',
      prep: 'x',
      wikilinks: [],
      debriefBody: 'Senator was supportive of the FY supplemental.',
    });
    const rec = withBody.sections.find((s) => s.key === 'debrief-recorded');
    expect(rec).toBeDefined();
    expect(rec?.owner).toBe('engine');
    expect(rec?.body).toContain('FY supplemental');
  });

  it('omits the recorded debrief section when no debriefBody is given', () => {
    const noBody = meetingToItem({
      tenantId: TENANT,
      meetingId: 'mtg-3',
      clientId: 'acme-corp',
      title: 'No Debrief',
      date: '2026-07-03',
      prep: 'x',
      wikilinks: [],
    });
    expect(noBody.sections.find((s) => s.key === 'debrief-recorded')).toBeUndefined();
  });

  // §12.1: Meri sessions are ALWAYS user-private — never auto firm-shared.
  it('keeps a Meri session user-private regardless of clientId', () => {
    const mk = (clientId: string | null): MeriSessionInput => ({
      tenantId: TENANT,
      sessionId: 'sess-1',
      ownerUserId: 'user-7',
      clientId,
      title: 'strategy chat',
      endedAt: '2026-06-21T09:00:00.000Z',
      transcriptSummary: 'User asked about markup timing.',
      wikilinks: [],
    });
    expect(meriSessionToItem(mk('acme-corp')).visibility).toBe('user');
    expect(meriSessionToItem(mk(null)).visibility).toBe('user');
    expect(vaultPathForItem(meriSessionToItem(mk('acme-corp')))).toBe(
      'users/user-7/meri/sess-1.md',
    );
  });

  // §12.1: promotion is a distilled candidate carrying provenance, not a transcript dump.
  it('builds a human-gated promotion candidate from a private item', () => {
    const item = meriSessionToItem({
      tenantId: TENANT,
      sessionId: 'sess-1',
      ownerUserId: 'user-7',
      clientId: 'acme-corp',
      title: 'strategy chat',
      endedAt: '2026-06-21T09:00:00.000Z',
      transcriptSummary: 'long transcript...',
      wikilinks: [],
    });
    item.id = 'mem-xyz';
    const cand = buildPromotionCandidate(
      item,
      'client-soul',
      'Acme cares about markup timing, not margins.',
    );
    expect(cand.fromItemId).toBe('mem-xyz');
    expect(cand.targetType).toBe('client-soul');
    expect(cand.targetClientId).toBe('acme-corp');
    expect(cand.distilledText).toContain('markup timing');
  });
});
