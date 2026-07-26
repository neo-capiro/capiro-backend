import {
  applyEntailmentGate,
  resolveEntailmentMode,
  type EntailmentSection,
} from './entailment-gate.js';
import { AlertMemoService, HELD_MEMO_MESSAGE } from './alert-memo.service.js';
import type { AlertMemoAlertInput } from './alert-memo.types.js';

/**
 * §4.7 (Gate C g-6). `verifyGrounded` proves a paragraph CITES a real claim id; it does
 * not prove the cited claim ENTAILS the paragraph. This gate adds that second check.
 *
 * The single most important test here is case 1: with MERI_ENTAILMENT_MODE unset, ZERO
 * fetches occur and the sections come back identical. This ships dark, and the default-off
 * lock is what makes that claim checkable rather than asserted.
 */

const CLAIMS = [
  { id: 'c1', text: 'Official action (2026-07-18): Ordered to be Reported by the Yeas and Nays: 32 - 12.' },
  { id: 'c2', text: 'Bill: H.R. 8800 — Hypersonic Capability Acceleration Act' },
];

const sections = (): EntailmentSection[] => [
  {
    heading: 'Bottom line',
    // Prose with no numeric tokens → does NOT auto-pass, goes to the judge.
    paragraphs: [{ text: 'The committee has cleared the bill for floor action.', claimIds: ['c1'] }],
  },
  {
    heading: 'What happened',
    paragraphs: [{ text: 'The measure advanced on a bipartisan basis.', claimIds: ['c2'] }],
  },
];

const logger = { warn: jest.fn() };
const CRED = { apiKey: 'k', model: 'claude-sonnet-5' };

function judgeResponse(verdicts: Array<{ i: number; entailed: boolean; reason?: string }>) {
  return {
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ verdicts }) }],
      usage: { input_tokens: 100, output_tokens: 30 },
    }),
  } as Response;
}

describe('resolveEntailmentMode', () => {
  it('defaults to off for anything that is not shadow or enforce', () => {
    for (const v of [undefined, '', 'OFF', 'nonsense', 'true', '1']) {
      expect(resolveEntailmentMode(v)).toBe('off');
    }
    expect(resolveEntailmentMode('shadow')).toBe('shadow');
    expect(resolveEntailmentMode('ENFORCE')).toBe('enforce');
    expect(resolveEntailmentMode(' enforce ')).toBe('enforce');
  });
});

describe('applyEntailmentGate', () => {
  const originalFetch = global.fetch;
  const originalMode = process.env.MERI_ENTAILMENT_MODE;
  beforeEach(() => logger.warn.mockClear());
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalMode === undefined) delete process.env.MERI_ENTAILMENT_MODE;
    else process.env.MERI_ENTAILMENT_MODE = originalMode;
  });

  // Case 1 — the default-off lock.
  it('makes NO fetch and returns sections identical when the env var is unset', async () => {
    delete process.env.MERI_ENTAILMENT_MODE;
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const input = sections();

    const r = await applyEntailmentGate({ sections: input, claims: CLAIMS, cred: CRED, logger });

    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(r.sections).toBe(input);
    expect(r.findings).toEqual([]);
    expect(r.held).toBe(false);
    expect(r.usage).toEqual([]);
  });

  // Case 2
  it('under SHADOW, logs a finding but leaves the sections untouched', async () => {
    process.env.MERI_ENTAILMENT_MODE = 'shadow';
    global.fetch = jest.fn(async () =>
      judgeResponse([
        { i: 0, entailed: false, reason: 'c1 records a committee vote, not floor clearance.' },
        { i: 1, entailed: true },
      ]),
    ) as unknown as typeof fetch;
    const input = sections();

    const r = await applyEntailmentGate({ sections: input, claims: CLAIMS, cred: CRED, logger });

    expect(r.sections).toBe(input); // byte-identical output under shadow
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.reason).toContain('committee vote');
    expect(r.held).toBe(false);
  });

  // Case 3
  it('under ENFORCE, drops the non-entailed paragraph and keeps the other', async () => {
    process.env.MERI_ENTAILMENT_MODE = 'enforce';
    global.fetch = jest.fn(async () =>
      judgeResponse([
        { i: 0, entailed: false, reason: 'not supported' },
        { i: 1, entailed: true },
      ]),
    ) as unknown as typeof fetch;

    const r = await applyEntailmentGate({ sections: sections(), claims: CLAIMS, cred: CRED, logger });

    expect(r.sections).toHaveLength(1);
    expect(r.sections[0]!.heading).toBe('What happened');
    expect(r.sections[0]!.paragraphs[0]!.text).toBe('The measure advanced on a bipartisan basis.');
    expect(r.held).toBe(false);
  });

  // Case 4
  it('under ENFORCE, an all-dropped generation yields no sections and held:true', async () => {
    process.env.MERI_ENTAILMENT_MODE = 'enforce';
    global.fetch = jest.fn(async () =>
      judgeResponse([
        { i: 0, entailed: false, reason: 'no' },
        { i: 1, entailed: false, reason: 'no' },
      ]),
    ) as unknown as typeof fetch;

    const r = await applyEntailmentGate({ sections: sections(), claims: CLAIMS, cred: CRED, logger });

    expect(r.sections).toEqual([]);
    expect(r.held).toBe(true);
    expect(r.findings).toHaveLength(2);
  });

  // Case 5 — the deterministic pre-filter.
  it('auto-passes every paragraph whose numbers all appear in its cited claims — ZERO fetches', async () => {
    process.env.MERI_ENTAILMENT_MODE = 'enforce';
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const numeric: EntailmentSection[] = [
      {
        heading: 'What happened',
        // Every number here appears verbatim in c1.
        paragraphs: [{ text: 'Reported 32 - 12 on 2026-07-18.', claimIds: ['c1'] }],
      },
    ];

    const r = await applyEntailmentGate({ sections: numeric, claims: CLAIMS, cred: CRED, logger });

    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(r.sections).toBe(numeric);
    expect(r.held).toBe(false);
  });

  it('does NOT auto-pass a paragraph whose number is absent from its cited claims', async () => {
    process.env.MERI_ENTAILMENT_MODE = 'enforce';
    const fetchMock = jest.fn(async () => judgeResponse([{ i: 0, entailed: false, reason: 'fabricated tally' }]));
    global.fetch = fetchMock as unknown as typeof fetch;
    const fabricated: EntailmentSection[] = [
      { heading: 'What happened', paragraphs: [{ text: 'Reported 41 - 3.', claimIds: ['c1'] }] },
    ];

    const r = await applyEntailmentGate({ sections: fabricated, claims: CLAIMS, cred: CRED, logger });

    expect(fetchMock).toHaveBeenCalledTimes(1); // the fabricated tally reached the judge
    expect(r.sections).toEqual([]);
    expect(r.held).toBe(true);
  });

  // Case 6 — three separate fail-open cases.
  it('fails open when the fetch throws', async () => {
    process.env.MERI_ENTAILMENT_MODE = 'enforce';
    global.fetch = jest.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const input = sections();

    const r = await applyEntailmentGate({ sections: input, claims: CLAIMS, cred: CRED, logger });

    expect(r.sections).toBe(input);
    expect(r.held).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('fails open when the response is not OK (timeout/abort included)', async () => {
    process.env.MERI_ENTAILMENT_MODE = 'enforce';
    global.fetch = jest.fn(async () => ({ ok: false, json: async () => ({ error: 'overloaded' }) }) as Response) as unknown as typeof fetch;
    const input = sections();

    const r = await applyEntailmentGate({ sections: input, claims: CLAIMS, cred: CRED, logger });

    expect(r.sections).toBe(input);
    expect(r.held).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('fails open when the body is unparseable prose', async () => {
    process.env.MERI_ENTAILMENT_MODE = 'enforce';
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'I am unable to comply.' }] }),
    }) as Response) as unknown as typeof fetch;
    const input = sections();

    const r = await applyEntailmentGate({ sections: input, claims: CLAIMS, cred: CRED, logger });

    // No verdicts parsed → nothing judged unsupported → sections survive untouched.
    expect(r.sections).toBe(input);
    expect(r.findings).toEqual([]);
    expect(r.held).toBe(false);
  });

  it('treats a verdict with a missing/fuzzy entailed field as NOT entailed', async () => {
    process.env.MERI_ENTAILMENT_MODE = 'enforce';
    global.fetch = jest.fn(async () =>
      judgeResponse([
        { i: 0, entailed: 'yes' as unknown as boolean },
        { i: 1, entailed: true },
      ]),
    ) as unknown as typeof fetch;

    const r = await applyEntailmentGate({ sections: sections(), claims: CLAIMS, cred: CRED, logger });

    // A permissive judge is worse than none — 'yes' is not `true`.
    expect(r.findings).toHaveLength(1);
    expect(r.sections).toHaveLength(1);
  });

  // Case 7
  it('sends temperature 0, an AbortController signal, and the strict judge system prompt', async () => {
    process.env.MERI_ENTAILMENT_MODE = 'shadow';
    const fetchMock = jest.fn(async (_u: string, init: { body: string; signal?: AbortSignal }) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return judgeResponse([{ i: 0, entailed: true }, { i: 1, entailed: true }]);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await applyEntailmentGate({ sections: sections(), claims: CLAIMS, cred: CRED, logger });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(1500);
    expect(body.system).toContain('strict entailment judge');
    expect(body.system).toContain('Default to entailed=false when uncertain');
    // The prompt carries ONLY the claims each paragraph cites, as its allowed evidence.
    expect(body.messages[0].content).toContain('EVIDENCE it may rest on:');
    expect(body.messages[0].content).toContain('c1:');
  });

  // §4 edge case 8
  it('chunks a large memo into batches of 10 and logs the chunk count', async () => {
    process.env.MERI_ENTAILMENT_MODE = 'shadow';
    const fetchMock = jest.fn(async () => judgeResponse([{ i: 0, entailed: true }]));
    global.fetch = fetchMock as unknown as typeof fetch;
    const big: EntailmentSection[] = [
      {
        heading: 'Bottom line',
        paragraphs: Array.from({ length: 25 }, (_, i) => ({
          text: `Qualitative assertion number ${'x'.repeat(i % 3)} with no figures.`,
          claimIds: ['c1'],
        })),
      },
    ];

    await applyEntailmentGate({ sections: big, claims: CLAIMS, cred: CRED, logger });

    expect(fetchMock).toHaveBeenCalledTimes(3); // 25 paragraphs → 10 + 10 + 5
    expect(logger.warn.mock.calls.flat().join(' ')).toContain('splitting into 3 chunk(s)');
  });

  it('returns the raw provider responses so the caller can meter the call separately', async () => {
    process.env.MERI_ENTAILMENT_MODE = 'shadow';
    global.fetch = jest.fn(async () =>
      judgeResponse([{ i: 0, entailed: true }, { i: 1, entailed: true }]),
    ) as unknown as typeof fetch;

    const r = await applyEntailmentGate({ sections: sections(), claims: CLAIMS, cred: CRED, logger });

    expect(r.usage).toHaveLength(1);
    expect((r.usage[0] as { usage: { input_tokens: number } }).usage.input_tokens).toBe(100);
  });

  it('ignores an out-of-range verdict index rather than mis-assigning it', async () => {
    process.env.MERI_ENTAILMENT_MODE = 'enforce';
    global.fetch = jest.fn(async () =>
      judgeResponse([{ i: 99, entailed: false, reason: 'bogus index' }]),
    ) as unknown as typeof fetch;

    const r = await applyEntailmentGate({ sections: sections(), claims: CLAIMS, cred: CRED, logger });

    expect(r.findings).toEqual([]);
    expect(r.held).toBe(false);
  });
});

/**
 * Case 8 — the end-to-end proof that phase g composes with Gate A. An all-dropped
 * generation under enforce must: fall through to the deterministic scaffold with
 * lowConfidence, set held:true, NOT auto-file to the client's Documents, emit a
 * review_request, meter the judge call as its OWN workflow, and then be REJECTED by
 * Gate A's saveEdited locks.
 */
describe('generate() + saveEdited under MERI_ENTAILMENT_MODE=enforce (composes with Gate A)', () => {
  const originalFetch = global.fetch;
  const originalMode = process.env.MERI_ENTAILMENT_MODE;
  const originalAuditor = process.env.MERI_AUDITOR_MODE;
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalMode === undefined) delete process.env.MERI_ENTAILMENT_MODE;
    else process.env.MERI_ENTAILMENT_MODE = originalMode;
    if (originalAuditor === undefined) delete process.env.MERI_AUDITOR_MODE;
    else process.env.MERI_AUDITOR_MODE = originalAuditor;
  });

  const ALERT: AlertMemoAlertInput = {
    alertId: 'alert-1',
    sourceType: 'bill',
    title: 'H.R. 8800: Reported by committee',
    whyItMatters: 'Affects the client.',
    billDisplayNum: 'H.R. 8800',
    actionText: 'Ordered to be Reported by the Yeas and Nays: 32 - 12.',
    actionDate: '2026-07-18',
    url: 'https://congress.gov/bill/hr8800',
  };

  function makeDeps() {
    const aiUsageEvents: Array<{ data: Record<string, unknown> }> = [];
    const reviewRequests: unknown[] = [];
    const prisma = {
      withTenant: jest.fn(async (_t: string, fn: (tx: unknown) => unknown) =>
        fn({
          aiUsageEvent: {
            create: jest.fn(async (a: { data: Record<string, unknown> }) => {
              aiUsageEvents.push(a);
              return a;
            }),
          },
          meriAuditLedger: { create: jest.fn(async (a: unknown) => a), findFirst: jest.fn(async () => null) },
          reviewRequest: { findMany: jest.fn(async () => reviewRequests) },
        }),
      ),
    };
    const credentials = {
      resolveProvider: jest.fn(async () => ({ apiKey: 'k', model: 'claude-sonnet-5', usedTenantKey: true })),
    };
    const contextCompiler = {
      compile: jest.fn(async () => ({ packetId: 'p', rendered: [], items: [], exclusions: [] })),
    };
    const engagement = {
      createAttachmentFromBuffer: jest.fn(async () => ({ id: 'att-1', fileName: 'memo.docx' })),
      deleteAttachment: jest.fn(async () => undefined),
      billTruthBlock: jest.fn(async () => null),
    };
    const reviews = {
      createSystem: jest.fn(async () => 'rr-1'),
      hasOpenForSubject: jest.fn(async () => true),
    };
    return {
      service: new AlertMemoService(
        credentials as never,
        contextCompiler as never,
        engagement as never,
        prisma as never,
        reviews as never,
      ),
      engagement,
      reviews,
      aiUsageEvents,
    };
  }

  /** First call = the memo generation; any call carrying the judge prompt = the gate. */
  function wireFetch() {
    global.fetch = jest.fn(async (_u: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { system: string };
      if (body.system.includes('strict entailment judge')) {
        return {
          ok: true,
          json: async () => ({
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  verdicts: [{ i: 0, entailed: false, reason: 'c1 does not support this.' }],
                }),
              },
            ],
            usage: { input_tokens: 90, output_tokens: 20 },
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                sections: [
                  {
                    heading: 'Bottom line',
                    paragraphs: [
                      { text: 'The bill is certain to become law this fall.', claimIds: ['c1'] },
                    ],
                  },
                ],
              }),
            },
          ],
          usage: { input_tokens: 400, output_tokens: 150 },
        }),
      } as Response;
    }) as unknown as typeof fetch;
  }

  it('holds the memo, scaffolds it, does not file it, and meters the judge separately', async () => {
    process.env.MERI_ENTAILMENT_MODE = 'enforce';
    delete process.env.MERI_AUDITOR_MODE; // the auditor stays OFF — this hold is the gate's own
    const { service, engagement, reviews, aiUsageEvents } = makeDeps();
    wireFetch();

    const r = await service.generate({ tenantId: 't1', userId: 'u1' } as never, 'client-1', ALERT, 'Acme');

    // The unsupported paragraph never reaches the client.
    expect(r.markdown).not.toContain('certain to become law');
    // All paragraphs dropped -> deterministic scaffold + lowConfidence.
    expect(r.lowConfidence).toBe(true);
    // ...and the memo is HELD, so it is NOT auto-filed.
    expect(r.held).toBe(true);
    expect(r.document).toBeNull();
    expect(engagement.createAttachmentFromBuffer).not.toHaveBeenCalled();
    expect(r.heldReason).toContain('Entailment gate');
    // G4: a hold becomes a pending review_request a reviewer can act on.
    expect(reviews.createSystem).toHaveBeenCalledTimes(1);
    // g-4: the analyst can see WHICH sentence was withheld and why.
    expect(r.entailmentDropped?.[0]?.text).toContain('certain to become law');
    expect(r.entailmentDropped?.[0]?.reason).toContain('does not support');

    // §4.9: the second LLM call is metered as its OWN workflow, on the tenant's key.
    const workflows = aiUsageEvents.map((e) => e.data.workflow);
    expect(workflows).toContain('alert_memo');
    expect(workflows).toContain('alert_memo_entailment');
    const entail = aiUsageEvents.find((e) => e.data.workflow === 'alert_memo_entailment')!;
    expect(entail.data).toMatchObject({ inputTokens: 90, outputTokens: 20, usedTenantKey: true });
  });

  it("then Gate A's saveEdited locks REJECT filing that held memo", async () => {
    process.env.MERI_ENTAILMENT_MODE = 'enforce';
    const { service } = makeDeps(); // reviews.hasOpenForSubject -> true (L1)

    await expect(
      service.saveEdited({ tenantId: 't1', userId: 'u1', role: 'standard_user' } as never, 'client-1', {
        title: 'Client memo — H.R. 8800',
        markdown: '# Client memo\n\nScaffolded body.',
        clientName: 'Acme',
        alertId: 'alert-1',
      }),
    ).rejects.toThrow(HELD_MEMO_MESSAGE);
  });

  it('with the gate OFF the same generation files normally (nothing changed by default)', async () => {
    delete process.env.MERI_ENTAILMENT_MODE;
    delete process.env.MERI_AUDITOR_MODE;
    const { service, engagement, aiUsageEvents } = makeDeps();
    wireFetch();

    const r = await service.generate({ tenantId: 't1', userId: 'u1' } as never, 'client-1', ALERT, 'Acme');

    expect(r.held).toBe(false);
    expect(r.lowConfidence).toBe(false);
    expect(r.markdown).toContain('certain to become law'); // untouched: the gate never ran
    expect(engagement.createAttachmentFromBuffer).toHaveBeenCalled();
    expect(aiUsageEvents.map((e) => e.data.workflow)).not.toContain('alert_memo_entailment');
  });
});
