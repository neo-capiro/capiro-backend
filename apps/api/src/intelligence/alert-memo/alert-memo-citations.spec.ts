import { AlertMemoService, withClaimAnchors } from './alert-memo.service.js';
import { withClaimAnchors as briefWithClaimAnchors } from './district-brief.service.js';
import type { AlertMemoAlertInput } from './alert-memo.types.js';

/**
 * P1-15 / §4.6 (Gate C c-9). The structured result always carried per-paragraph
 * claimIds, but every DELIVERED surface dropped them: toMarkdown pushed `p.text`,
 * toMemoDocInput mapped `p.text`, and the Workspace path joined `p.text`. The memo the
 * client actually received was therefore strictly less auditable than the object the
 * server held, and the Sources list carried only { claimId, label, url } — no retrieval
 * date and no verification state.
 */

jest.mock('./alert-memo-docx.js', () => {
  const actual = jest.requireActual('./alert-memo-docx.js');
  return { ...actual, renderMemoDocx: jest.fn(async () => Buffer.from('docx-bytes')) };
});
// eslint-disable-next-line import/first
import { renderMemoDocx, type MemoDocInput } from './alert-memo-docx.js';

const ALERT: AlertMemoAlertInput = {
  alertId: 'alert-1',
  sourceType: 'bill',
  title: 'H.R. 8800: Rule granted (floor scheduled)',
  whyItMatters: 'Directly affects defense manufacturing incentives the client relies on.',
  billDisplayNum: 'H.R. 8800',
  billTitle: 'National Defense Manufacturing Act',
  actionText: 'Rules Committee granted a closed rule for floor consideration.',
  actionDate: '2026-07-01',
  committee: 'House Armed Services Committee',
  url: 'https://congress.gov/bill/hr8800',
};

function makeDeps() {
  const prisma = {
    withTenant: jest.fn(async (_t: string, fn: (tx: unknown) => unknown) =>
      fn({
        aiUsageEvent: { create: jest.fn(async (a: unknown) => a) },
        meriAuditLedger: { create: jest.fn(async (a: unknown) => a) },
      }),
    ),
  };
  const credentials = {
    resolveProvider: jest.fn(async () => ({
      apiKey: 'key',
      model: 'claude-sonnet-5',
      usedTenantKey: false,
    })),
  };
  const contextCompiler = {
    compile: jest.fn(async () => ({
      packetId: 'pkt-1',
      rendered: [],
      items: [],
      // §4.6 / c-7: the compiler has always produced this trace; loadSteering discarded it.
      exclusions: [
        { layer: 'client-steering', id: 'mi-9', type: 'client-compass', slug: 'acme', reason: 'superseded' },
        { layer: 'firm-playbook', id: 'mi-8', type: 'playbook', slug: 'firm', reason: 'over-budget' },
      ],
    })),
  };
  const engagement = {
    createAttachmentFromBuffer: jest.fn(async () => ({ id: 'att-1', fileName: 'memo.docx' })),
    deleteAttachment: jest.fn(async () => undefined),
    billTruthBlock: jest.fn(async () => null),
  };
  const reviews = { createSystem: jest.fn(async () => 'rr-1'), hasOpenForSubject: jest.fn(async () => false) };
  const service = new AlertMemoService(
    credentials as never,
    contextCompiler as never,
    engagement as never,
    prisma as never,
    reviews as never,
  );
  return { service };
}

function anthropicTextResponse(sections: unknown) {
  return {
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ sections }) }],
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
  } as Response;
}

const CTX = { tenantId: 't1', userId: 'u1' } as never;
const TODAY = new Date().toISOString().slice(0, 10);

describe('alert memo — paragraph claim anchors (P1-15)', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    (renderMemoDocx as jest.Mock).mockClear();
  });

  // Case 1
  it('appends [c2][c4] immediately after the sentence in the markdown', async () => {
    const { service } = makeDeps();
    global.fetch = jest.fn(async () =>
      anthropicTextResponse([
        {
          heading: 'Bottom line',
          paragraphs: [
            { text: 'The closed rule is stalling floor consideration.', claimIds: ['c2', 'c4'] },
          ],
        },
      ]),
    ) as unknown as typeof fetch;

    const r = await service.generate(CTX, 'client-1', ALERT, 'Acme Corp');

    expect(r.markdown).toContain('The closed rule is stalling floor consideration. [c2][c4]');
    // The anchor is appended at the END, never inserted mid-sentence.
    expect(r.markdown).not.toContain('[c2][c4] The closed rule');
  });

  it('renders one anchor per cited id, in the order the paragraph cited them', async () => {
    const { service } = makeDeps();
    global.fetch = jest.fn(async () =>
      anthropicTextResponse([
        { heading: 'Bottom line', paragraphs: [{ text: 'Three sources agree.', claimIds: ['c3', 'c1', 'c2'] }] },
      ]),
    ) as unknown as typeof fetch;

    const r = await service.generate(CTX, 'client-1', ALERT, 'Acme Corp');
    expect(r.markdown).toContain('Three sources agree. [c3][c1][c2]');
  });

  // Case 6 — verifyGrounded is UNCHANGED, so an uncited paragraph never reaches the
  // renderer; case 2 is only reachable through the scaffold.
  it('still drops a zero-citation paragraph before rendering (verifyGrounded untouched)', async () => {
    const { service } = makeDeps();
    global.fetch = jest.fn(async () =>
      anthropicTextResponse([
        { heading: 'Bottom line', paragraphs: [{ text: 'Ungrounded assertion.', claimIds: [] }] },
      ]),
    ) as unknown as typeof fetch;

    const r = await service.generate(CTX, 'client-1', ALERT, 'Acme Corp');

    expect(r.markdown).not.toContain('Ungrounded assertion');
    expect(r.lowConfidence).toBe(true); // fell through to the scaffold
  });

  // Case 2 — the renderer itself. Reachable in production only via `scaffold`, whose
  // first paragraph legitimately carries [] when there are no claims at all;
  // verifyGrounded drops every other zero-citation paragraph before this point.
  it('adds NO anchor and NO trailing space to a paragraph with an empty claimIds', () => {
    expect(withClaimAnchors('The rule was granted.', [])).toBe('The rule was granted.');
    expect(withClaimAnchors('The rule was granted.', [])).not.toMatch(/\s$/);
    expect(withClaimAnchors('', [])).toBe('');
    expect(withClaimAnchors('Cited.', ['c1'])).toBe('Cited. [c1]');
  });

  it('the scaffold path renders without a literal [] or a dangling space', async () => {
    const { service } = makeDeps();
    global.fetch = jest.fn(async () => ({ ok: false, json: async () => ({ error: 'boom' }) }) as Response) as unknown as typeof fetch;

    const r = await service.generate(
      CTX,
      'client-1',
      { alertId: 'a1', sourceType: 'bill', title: 'A bare headline' },
      'Acme Corp',
    );

    expect(r.lowConfidence).toBe(true);
    expect(r.markdown).not.toContain('[]');
    for (const line of r.markdown.split('\n')) expect(line).not.toMatch(/\S\s$/);
  });

  // Case 4
  it('carries the same anchors into the DOCX paragraphs as into the markdown', async () => {
    const { service } = makeDeps();
    global.fetch = jest.fn(async () =>
      anthropicTextResponse([
        { heading: 'Bottom line', paragraphs: [{ text: 'Floor action is imminent.', claimIds: ['c1', 'c2'] }] },
      ]),
    ) as unknown as typeof fetch;

    await service.generate(CTX, 'client-1', ALERT, 'Acme Corp');

    const docInput = (renderMemoDocx as jest.Mock).mock.calls[0]![0] as MemoDocInput;
    expect(docInput.sections[0]!.paragraphs[0]).toBe('Floor action is imminent. [c1][c2]');
  });
});

describe('alert memo — Sources with retrieval date + verification (§4.6)', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  // Case 3
  it('maps each claim id to label, url, retrieved date, and verification state', async () => {
    const { service } = makeDeps();
    global.fetch = jest.fn(async () =>
      anthropicTextResponse([
        { heading: 'Bottom line', paragraphs: [{ text: 'Grounded.', claimIds: ['c1'] }] },
      ]),
    ) as unknown as typeof fetch;

    const r = await service.generate(CTX, 'client-1', ALERT, 'Acme Corp');

    expect(r.markdown).toContain('## Sources');
    expect(r.markdown).toMatch(
      /- \*\*\[c1\]\*\* .+ — https:\/\/congress\.gov\/bill\/hr8800 · retrieved \d{4}-\d{2}-\d{2} · official/,
    );
    const c1 = r.sources.find((s) => s.claimId === 'c1');
    expect(c1?.retrievedAt).toBe(TODAY);
    expect(c1?.verification).toBe('official');
  });

  it('labels a RELATIVE internal deep link "extracted", never "official"', async () => {
    const { service } = makeDeps();
    global.fetch = jest.fn(async () =>
      anthropicTextResponse([
        { heading: 'Bottom line', paragraphs: [{ text: 'Grounded.', claimIds: ['c1'] }] },
      ]),
    ) as unknown as typeof fetch;

    const r = await service.generate(
      CTX,
      'client-1',
      {
        alertId: 'a-pe',
        sourceType: 'program_element',
        title: 'PE moved',
        programElement: { peCode: '0603286F', href: '/program-elements/0603286F' },
      },
      'Acme Corp',
    );

    expect(r.sources.length).toBeGreaterThan(0);
    for (const s of r.sources) {
      expect(s.verification).toBe('extracted');
    }
    // Never inflated to 'verified' — nothing verifies these today.
    expect(r.sources.every((s) => s.verification !== 'verified')).toBe(true);
  });
});

// Case 5 — the two services are deliberate near-duplicates (c-6 keeps them symmetric
// rather than extracting a shared module). This is the lock that they stay identical.
describe('district brief renders the IDENTICAL anchor format (symmetry lock)', () => {
  it.each([
    ['Text.', []],
    ['Text.', ['c1']],
    ['Text.', ['c2', 'c4']],
    ['', ['c1']],
    ['Multi. Sentence. Paragraph.', ['c1', 'c2', 'c3']],
  ] as Array<[string, string[]]>)('matches for %p / %p', (text, ids) => {
    expect(briefWithClaimAnchors(text, ids)).toBe(withClaimAnchors(text, ids));
  });
});

describe('alert memo — context exclusion trace (§4.6 / c-7)', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns what the compiler withheld and why, instead of discarding it', async () => {
    const { service } = makeDeps();
    global.fetch = jest.fn(async () =>
      anthropicTextResponse([
        { heading: 'Bottom line', paragraphs: [{ text: 'Grounded.', claimIds: ['c1'] }] },
      ]),
    ) as unknown as typeof fetch;

    const r = await service.generate(CTX, 'client-1', ALERT, 'Acme Corp');

    expect(r.contextExcluded).toEqual([
      { title: 'client-compass', reason: 'superseded' },
      { title: 'firm-playbook', reason: 'over-budget' },
    ]);
  });
});
