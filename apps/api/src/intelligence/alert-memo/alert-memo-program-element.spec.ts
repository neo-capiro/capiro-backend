import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AlertMemoService } from './alert-memo.service.js';
import { AlertMemoAlertDto } from './alert-memo.controller.js';
import type { AlertMemoAlertInput } from './alert-memo.types.js';

/**
 * P0-08 (Gate C b-18). A Program Element alert used to be offered the BILL-shaped memo
 * as its PRIMARY action: `canMemo` did not exclude program_element, and the web mapper
 * downgraded sourceType to 'bill' without mapping a single PE field. The result was a
 * memo about a funding movement that contained no PE code, no fiscal year, no
 * budget-stage, and no dollar figures — every fact the alert card displayed was dropped.
 *
 * These tests lock the PE claim builder, the PE prompt selection, the PE title/headings,
 * and the arithmetic contract (every figure pre-computed by code, byte-identical to the
 * card's formatter).
 */

const PE: NonNullable<AlertMemoAlertInput['programElement']> = {
  peCode: '0603286F',
  title: 'Hypersonics Prototyping',
  fiscalYear: 2027,
  deltaType: 'pb_increase',
  deltaTypeLabel: "President's Budget increase",
  fromRef: 'FY26 PB',
  toRef: 'FY27 PB',
  amountFromMillions: 250,
  amountToMillions: 1234.5,
  deltaMillions: 984.5,
  deltaPct: 393.8,
  href: '/program-elements/0603286F',
};

const PE_ALERT: AlertMemoAlertInput = {
  alertId: 'alert-pe-1',
  sourceType: 'program_element',
  title: "0603286F: FY27 President's Budget increases funding",
  whyItMatters: '0603286F is on this client\'s watchlist under "Hypersonics".',
  sourceRef: '0603286F',
  actionText: 'PB27 increases 0603286F relative to PB26.',
  actionDate: '2026-07-20',
  programElement: PE,
};

function makeDeps(opts: { billTruthBlock?: () => Promise<unknown> } = {}) {
  const aiUsageEvents: unknown[] = [];
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({
        aiUsageEvent: {
          create: jest.fn(async (args: unknown) => {
            aiUsageEvents.push(args);
            return args;
          }),
        },
        meriAuditLedger: { create: jest.fn(async (args: unknown) => args) },
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
    compile: jest.fn(async () => ({ packetId: 'pkt-1', rendered: [], items: [], exclusions: [] })),
  };
  const engagement = {
    createAttachmentFromBuffer: jest.fn(async () => ({ id: 'att-1', fileName: 'memo.docx' })),
    deleteAttachment: jest.fn(async () => undefined),
    billTruthBlock: jest.fn(opts.billTruthBlock ?? (async () => null)),
  };
  const reviews = { createSystem: jest.fn(async () => 'rr-1'), hasOpenForSubject: jest.fn(async () => false) };
  const service = new AlertMemoService(
    credentials as never,
    contextCompiler as never,
    engagement as never,
    prisma as never,
    reviews as never,
  );
  return { service, engagement, aiUsageEvents };
}

function anthropicTextResponse(sections: unknown) {
  return {
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ sections }) }],
      usage: { input_tokens: 400, output_tokens: 150 },
    }),
  } as Response;
}

const PE_SECTIONS = [
  { heading: 'Bottom line', paragraphs: [{ text: 'PB27 raises this line materially.', claimIds: ['c1'] }] },
  { heading: 'Budget movement', paragraphs: [{ text: 'Funding rises across the two budget documents.', claimIds: ['c1'] }] },
];

/** Captures the outbound request body so the prompt + system can be asserted. */
function captureFetch(sections: unknown = PE_SECTIONS) {
  const mock = jest.fn(async (_url: string, init: { body: string }) => {
    void init;
    return anthropicTextResponse(sections);
  });
  global.fetch = mock as unknown as typeof fetch;
  return {
    body: () => JSON.parse(mock.mock.calls[0]![1].body) as { system: string; messages: Array<{ content: string }> },
    prompt: () => JSON.parse(mock.mock.calls[0]![1].body).messages[0].content as string,
    mock,
  };
}

const CTX = { tenantId: 't1', userId: 'u1' } as never;

describe('AlertMemoService.generate — Program Element memo (P0-08)', () => {
  const originalFetch = global.fetch;
  const originalAuditorMode = process.env.MERI_AUDITOR_MODE;
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalAuditorMode === undefined) delete process.env.MERI_AUDITOR_MODE;
    else process.env.MERI_AUDITOR_MODE = originalAuditorMode;
    jest.restoreAllMocks();
  });

  // Case 8
  it('grounds the memo in PE claims and uses the PE system prompt', async () => {
    const { service } = makeDeps();
    const cap = captureFetch();

    const result = await service.generate(CTX, 'client-1', PE_ALERT, 'Acme Defense');

    const prompt = cap.prompt();
    expect(prompt).toContain('Program Element: 0603286F — Hypersonics Prototyping');
    expect(prompt).toContain('Fiscal year: FY27 (FY2027)');
    expect(prompt).toContain("Budget-stage movement: President's Budget increase");
    expect(prompt).toContain('Source comparison: from FY26 PB to FY27 PB');
    expect(prompt).toContain('Funding: $250M → $1.2B');

    // The PE prompt, not the federal-bill one.
    const system = cap.body().system;
    expect(system).toContain('senior defense-budget government-affairs strategist');
    expect(system).toContain('NEVER compute or restate arithmetic');
    expect(system).toContain('Distinguish AUTHORIZATION (NDAA) from APPROPRIATION');
    expect(system).not.toContain('senior federal government-affairs strategist');

    // Case: the title leads with the PE code, not the raw headline.
    expect(result.title).toBe('Client memo — 0603286F — Hypersonics Prototyping');
  });

  // Case 9 — the figures must match fmtMillionsShort byte for byte.
  it('formats every dollar figure exactly as the feed card does', async () => {
    const { service } = makeDeps();
    const cap = captureFetch();

    await service.generate(
      CTX,
      'client-1',
      {
        ...PE_ALERT,
        programElement: {
          ...PE,
          amountFromMillions: 250.5,
          amountToMillions: 1234.5,
          deltaMillions: 984,
          deltaPct: null,
        },
      },
      'Acme Defense',
    );

    const prompt = cap.prompt();
    expect(prompt).toContain('Funding: $250.5M → $1.2B (delta $984M)');
    expect(prompt).not.toContain('NaN');
    expect(prompt).not.toContain('undefined');
  });

  it('renders a null amount as "unknown", never as a fabricated number', async () => {
    const { service } = makeDeps();
    const cap = captureFetch();

    await service.generate(
      CTX,
      'client-1',
      {
        ...PE_ALERT,
        programElement: { ...PE, amountFromMillions: null, amountToMillions: 250, deltaMillions: null, deltaPct: null },
      },
      'Acme Defense',
    );

    expect(cap.prompt()).toContain('Funding: unknown → $250M');
  });

  // Case 10
  it('never calls the live bill re-query for a PE alert (sourceRef is a PE code)', async () => {
    const billTruthBlock = jest.fn(async () => null);
    const { service } = makeDeps({ billTruthBlock });
    captureFetch();

    await service.generate(CTX, 'client-1', PE_ALERT, 'Acme Defense');

    expect(billTruthBlock).not.toHaveBeenCalled();
  });

  // Case 11
  it('requests the PE section list, never the bill headings', async () => {
    const { service } = makeDeps();
    const cap = captureFetch();

    await service.generate(CTX, 'client-1', PE_ALERT, 'Acme Defense');

    const prompt = cap.prompt();
    for (const heading of [
      'Bottom line',
      'Budget movement',
      'Authorization vs appropriation context',
      'Client program alignment',
      'Committee & program-office targets',
      'Recommended engagement',
    ]) {
      expect(prompt).toContain(heading);
    }
    expect(prompt).not.toContain('What happened');
    expect(prompt).not.toContain('Talking points');
  });

  it('a failed PE generation scaffolds with PE headings, not "What happened"', async () => {
    const { service } = makeDeps();
    global.fetch = jest.fn(async () => ({ ok: false, json: async () => ({ error: 'boom' }) }) as Response);

    const result = await service.generate(CTX, 'client-1', PE_ALERT, 'Acme Defense');

    expect(result.lowConfidence).toBe(true);
    const headings = result.sections.map((s) => s.heading);
    expect(headings).toContain('Budget movement');
    expect(headings).not.toContain('What happened');
    const allText = result.sections.flatMap((s) => s.paragraphs.map((p) => p.text)).join(' ');
    expect(allText).toContain('$250M → $1.2B');
  });

  // Case 12
  it('generates from a PE alert carrying ONLY a peCode, with no undefined or NaN', async () => {
    const { service } = makeDeps();
    const cap = captureFetch();

    const result = await service.generate(
      CTX,
      'client-1',
      {
        alertId: 'alert-pe-2',
        sourceType: 'program_element',
        title: '0603286F changed',
        programElement: { peCode: '0603286F' },
      },
      'Acme Defense',
    );

    const prompt = cap.prompt();
    expect(prompt).toContain('Program Element: 0603286F');
    expect(prompt).not.toContain('undefined');
    expect(prompt).not.toContain('NaN');
    expect(prompt).not.toContain('Funding:'); // no amounts → no funding claim at all
    expect(result.title).toBe('Client memo — 0603286F');
  });

  // §4 edge case 5 — a zero delta is a real fact.
  it('emits a funding claim for a ZERO delta ("no change at this stage")', async () => {
    const { service } = makeDeps();
    const cap = captureFetch();

    await service.generate(
      CTX,
      'client-1',
      {
        ...PE_ALERT,
        programElement: { ...PE, amountFromMillions: 250, amountToMillions: 250, deltaMillions: 0, deltaPct: 0 },
      },
      'Acme Defense',
    );

    expect(cap.prompt()).toContain('Funding: $250M → $250M (delta $0M, 0.0%)');
  });

  // §4 edge case 6 — a from-zero baseline must never render Infinity%.
  it('says "new start (no prior baseline)" instead of Infinity% on a from-zero baseline', async () => {
    const { service } = makeDeps();
    const cap = captureFetch();

    await service.generate(
      CTX,
      'client-1',
      {
        ...PE_ALERT,
        programElement: {
          ...PE,
          amountFromMillions: 0,
          amountToMillions: 250,
          deltaMillions: 250,
          deltaPct: Infinity,
        },
      },
      'Acme Defense',
    );

    const prompt = cap.prompt();
    expect(prompt).toContain('new start (no prior baseline)');
    expect(prompt).not.toContain('Infinity');
  });

  // §4 edge case 7 — an unverified figure must say so, and the prompt must not launder it.
  it('carries an "unverified" verification state into the fact sheet verbatim', async () => {
    const { service } = makeDeps();
    const cap = captureFetch();

    await service.generate(
      CTX,
      'client-1',
      { ...PE_ALERT, programElement: { ...PE, verification: 'unverified', linkedRef: 'FY27 NDAA §221' } },
      'Acme Defense',
    );

    const prompt = cap.prompt();
    expect(prompt).toContain('Verification state of these figures: unverified');
    expect(prompt).toContain('Linked authority: FY27 NDAA §221');
  });

  it('a BILL alert still uses the federal prompt and the original section list (regression lock)', async () => {
    const { service } = makeDeps();
    const cap = captureFetch([
      { heading: 'Bottom line', paragraphs: [{ text: 'Grounded.', claimIds: ['c1'] }] },
    ]);

    await service.generate(
      CTX,
      'client-1',
      {
        alertId: 'alert-bill-1',
        sourceType: 'bill',
        title: 'H.R. 8800: Rule granted',
        billDisplayNum: 'H.R. 8800',
        billTitle: 'National Defense Manufacturing Act',
      },
      'Acme Defense',
    );

    expect(cap.body().system).toContain('senior federal government-affairs strategist');
    const prompt = cap.prompt();
    expect(prompt).toContain(
      'Bottom line, What happened, Why it matters, Recommended actions, Talking points',
    );
    expect(prompt).not.toContain('Budget movement');
  });
});

// Case 13
describe('AlertMemoAlertDto — sourceType widening (P0-08)', () => {
  const valid = (over: Record<string, unknown> = {}) => ({
    alertId: 'alert-pe-1',
    sourceType: 'program_element',
    title: 'PE moved',
    programElement: { peCode: '0603286F', fiscalYear: 2027, amountToMillions: 250 },
    ...over,
  });

  it('accepts sourceType "program_element" with a nested PE block', () => {
    const errors = validateSync(plainToInstance(AlertMemoAlertDto, valid()), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors).toHaveLength(0);
  });

  // state_bill and regulation were rejected when this test was written; §4.5 (phase d)
  // deliberately widened the allow-list to include them, each with its own template and
  // prompt. The invariant under test is unchanged: an UNKNOWN value is still rejected.
  it('still REJECTS an unknown sourceType (the allow-list was widened, not removed)', () => {
    for (const sourceType of ['martian_decree', 'not_a_source', 'BILL', '', null]) {
      const errors = validateSync(plainToInstance(AlertMemoAlertDto, valid({ sourceType })), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects a PE block missing its peCode, and an unknown key inside it', () => {
    expect(
      validateSync(plainToInstance(AlertMemoAlertDto, valid({ programElement: { fiscalYear: 2027 } })), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateSync(
        plainToInstance(AlertMemoAlertDto, valid({ programElement: { peCode: 'x', bogus: 1 } })),
        { whitelist: true, forbidNonWhitelisted: true },
      ).length,
    ).toBeGreaterThan(0);
  });

  it('still accepts the three original sourceTypes', () => {
    for (const sourceType of ['bill', 'hearing', 'combined']) {
      const errors = validateSync(
        plainToInstance(AlertMemoAlertDto, {
          alertId: 'a1',
          sourceType,
          title: 'T',
        }),
        { whitelist: true, forbidNonWhitelisted: true },
      );
      expect(errors).toHaveLength(0);
    }
  });
});
