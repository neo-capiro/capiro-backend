import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AlertMemoService, sectionOrderFor } from './alert-memo.service.js';
import { AlertMemoAlertDto } from './alert-memo.controller.js';
import type { AlertMemoAlertInput } from './alert-memo.types.js';

/**
 * §4.5 (Gate C d-4). Before this, ONE bill-shaped template and ONE federal prompt served
 * every source type: a hearing memo had nowhere to put verbatim testimony, a state bill's
 * committee cutoff was invisible, and a regulation memo arrived with null bill fields
 * (which is why `canMemo` excluded state_bill and regulation outright rather than offer a
 * chip that produced a wrong document).
 *
 * The critical regression lock here is case 2: a FEDERAL BILL memo's requested section
 * list must be byte-identical to the single pre-Gate-C SECTION_ORDER.
 */

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
    resolveProvider: jest.fn(async () => ({ apiKey: 'k', model: 'claude-sonnet-5', usedTenantKey: false })),
  };
  const contextCompiler = {
    compile: jest.fn(async () => ({ packetId: 'p', rendered: [], items: [], exclusions: [] })),
  };
  const engagement = {
    createAttachmentFromBuffer: jest.fn(async () => ({ id: 'att-1', fileName: 'memo.docx' })),
    deleteAttachment: jest.fn(async () => undefined),
    billTruthBlock: jest.fn(async () => null),
  };
  const reviews = { createSystem: jest.fn(async () => 'rr-1'), hasOpenForSubject: jest.fn(async () => false) };
  return {
    service: new AlertMemoService(
      credentials as never,
      contextCompiler as never,
      engagement as never,
      prisma as never,
      reviews as never,
    ),
    engagement,
  };
}

function captureFetch(sections: unknown = [
  { heading: 'Bottom line', paragraphs: [{ text: 'Grounded.', claimIds: ['c1'] }] },
]) {
  const mock = jest.fn(async (_u: string, init: { body: string }) => {
    void init;
    return {
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ sections }) }],
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
    } as Response;
  });
  global.fetch = mock as unknown as typeof fetch;
  return {
    body: () => JSON.parse(mock.mock.calls[0]![1].body) as { system: string; messages: Array<{ content: string }> },
    prompt: () => JSON.parse(mock.mock.calls[0]![1].body).messages[0].content as string,
  };
}

const CTX = { tenantId: 't1', userId: 'u1' } as never;

describe('sectionOrderFor — per-source templates (§4.5)', () => {
  // Case 2 — the regression lock on every existing memo.
  it('the bill order is BYTE-IDENTICAL to the pre-Gate-C SECTION_ORDER', () => {
    expect(sectionOrderFor('bill')).toEqual([
      'Bottom line',
      'What happened',
      'Why it matters',
      'Recommended actions',
      'Talking points',
    ]);
    expect(sectionOrderFor('combined')).toEqual(sectionOrderFor('bill'));
  });

  // Case 3
  it('has an entry for every sourceType the DTO accepts', () => {
    for (const t of ['bill', 'hearing', 'combined', 'program_element', 'state_bill', 'regulation']) {
      const errors = validateSync(
        plainToInstance(AlertMemoAlertDto, { alertId: 'a', sourceType: t, title: 'T' }),
        { whitelist: true, forbidNonWhitelisted: true },
      );
      expect(errors).toHaveLength(0); // the DTO accepts it...
      expect(sectionOrderFor(t).length).toBeGreaterThan(0); // ...so a template must exist
    }
  });

  it('falls back to the bill order for an unknown sourceType, never an empty list', () => {
    expect(sectionOrderFor('martian_decree')).toEqual(sectionOrderFor('bill'));
    expect(sectionOrderFor('')).toEqual(sectionOrderFor('bill'));
  });

  it('gives each non-bill source its own distinct order', () => {
    expect(sectionOrderFor('hearing')).toContain('Verbatim quotes');
    expect(sectionOrderFor('state_bill')).toContain('Deadline & crossover risk');
    expect(sectionOrderFor('regulation')).toContain('Comment & effective deadlines');
    expect(sectionOrderFor('program_element')).toContain('Budget movement');
  });
});

describe('hearing template (§4.5 d-3)', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  // Case 1
  it('requests Verbatim quotes, uses the hearing prompt, and carries both quotes as claims', async () => {
    const { service } = makeDeps();
    const cap = captureFetch();

    await service.generate(
      CTX,
      'client-1',
      {
        alertId: 'a-h',
        sourceType: 'hearing',
        title: 'FY27 posture hearing',
        hearingTitle: 'FY27 posture hearing',
        committee: 'House Armed Services Committee',
        quotes: [
          { text: 'We must accelerate hypersonic prototyping.', speaker: 'Sen. Example' },
          { text: 'The budget request is insufficient.', speaker: 'Rep. Other' },
        ],
      },
      'Acme Defense',
    );

    const prompt = cap.prompt();
    expect(prompt).toContain('Verbatim quotes');
    expect(prompt).toContain('Speaker relevance');
    expect(prompt).toContain('Commitments & questions');
    expect(prompt).toContain('Hearing statement — Sen. Example: "We must accelerate hypersonic prototyping."');
    expect(prompt).toContain('Hearing statement — Rep. Other: "The budget request is insufficient."');

    const system = cap.body().system;
    expect(system).toContain('CHARACTER-EXACT');
    expect(system).toContain('Never paraphrase inside quotation marks');
  });
});

describe('state_bill template (§4.5 d-2 full feature)', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const STATE_ALERT: AlertMemoAlertInput = {
    alertId: 'a-sb',
    sourceType: 'state_bill',
    title: 'CA AB 1234: 5 day(s) until its committeeCutoff (2026-08-01).',
    billDisplayNum: 'CA AB 1234',
    billTitle: 'Advanced Manufacturing Incentive Act',
    actionText: 'Referred to Assembly Appropriations.',
    actionDate: '2026-07-20',
    jurisdiction: 'CA',
    deadline: { cutoffType: 'committeeCutoff', cutoffDate: '2026-08-01', daysUntil: 5 },
    url: 'https://leginfo.legislature.ca.gov/ab1234',
  };

  it('uses the state prompt and grounds the jurisdiction + the deadline as claims', async () => {
    const { service } = makeDeps();
    const cap = captureFetch();

    await service.generate(CTX, 'client-1', STATE_ALERT, 'Acme Defense');

    const prompt = cap.prompt();
    expect(prompt).toContain('this is STATE legislation in CA, not federal legislation');
    expect(prompt).toContain(
      'Procedural deadline: deadline type committeeCutoff, date 2026-08-01, 5 day(s) remaining as of this alert.',
    );
    expect(prompt).toContain('Deadline & crossover risk');
    expect(prompt).not.toContain('What happened');

    const system = cap.body().system;
    expect(system).toContain('senior STATE government-affairs strategist');
    expect(system).toContain('never call a state chamber "Congress"');
  });

  it('says the deadline posture is unestablished rather than inventing one when absent', async () => {
    const { service } = makeDeps();
    const cap = captureFetch();

    await service.generate(
      CTX,
      'client-1',
      { ...STATE_ALERT, deadline: null },
      'Acme Defense',
    );

    expect(cap.prompt()).not.toContain('Procedural deadline:');
    expect(cap.body().system).toContain('say the deadline posture is not established');
  });

  it('a failed generation scaffolds with STATE headings, not federal bill headings', async () => {
    const { service } = makeDeps();
    global.fetch = jest.fn(async () => ({ ok: false, json: async () => ({ e: 1 }) }) as Response) as unknown as typeof fetch;

    const r = await service.generate(CTX, 'client-1', STATE_ALERT, 'Acme Defense');

    expect(r.lowConfidence).toBe(true);
    const headings = r.sections.map((s) => s.heading);
    expect(headings).toContain('State procedural update');
    expect(headings).toContain('Deadline & crossover risk');
    expect(headings).not.toContain('What happened');
  });
});

describe('regulation template (§4.5 d-2 full feature)', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const REG_ALERT: AlertMemoAlertInput = {
    alertId: 'a-reg',
    sourceType: 'regulation',
    title: 'EPA proposes new emissions standards',
    sourceRef: '2026-01234',
    actionText: 'EPA proposes to revise the NSPS for stationary turbines.',
    actionDate: '2026-07-15',
    url: 'https://www.federalregister.gov/documents/2026/07/15/2026-01234',
    regulation: {
      ruleTitle: 'Standards of Performance for Stationary Combustion Turbines',
      agency: 'Environmental Protection Agency',
      ruleType: 'Proposed Rule',
      commentEndDate: '2026-09-15',
      docketId: 'EPA-HQ-OAR-2026-0001',
      url: 'https://www.federalregister.gov/documents/2026/07/15/2026-01234',
    },
  };

  it('uses the regulation prompt and grounds agency, type, docket, and the comment deadline', async () => {
    const { service } = makeDeps();
    const cap = captureFetch();

    const r = await service.generate(CTX, 'client-1', REG_ALERT, 'Acme Defense');

    const prompt = cap.prompt();
    expect(prompt).toContain('Regulatory action: Standards of Performance for Stationary Combustion Turbines');
    expect(prompt).toContain('Issuing agency: Environmental Protection Agency');
    expect(prompt).toContain('Document type: Proposed Rule');
    expect(prompt).toContain('Docket: EPA-HQ-OAR-2026-0001');
    expect(prompt).toContain('Public comment period closes: 2026-09-15');
    expect(prompt).toContain('Comment & effective deadlines');

    const system = cap.body().system;
    expect(system).toContain('senior regulatory-affairs strategist');
    expect(system).toContain('Distinguish a PROPOSED rule from a FINAL rule');
    expect(system).toContain('never estimate, extend, or infer a deadline'.replace('never', 'Never'));

    // The title leads with the rule title, not the raw headline.
    expect(r.title).toBe('Client memo — Standards of Performance for Stationary Combustion Turbines');
  });

  it('never calls the live BILL re-query for a regulation (sourceRef is a rule id)', async () => {
    const { service, engagement } = makeDeps();
    captureFetch();

    await service.generate(CTX, 'client-1', REG_ALERT, 'Acme Defense');

    expect(engagement.billTruthBlock).not.toHaveBeenCalled();
  });

  it('a failed generation scaffolds with REGULATION headings', async () => {
    const { service } = makeDeps();
    global.fetch = jest.fn(async () => ({ ok: false, json: async () => ({ e: 1 }) }) as Response) as unknown as typeof fetch;

    const r = await service.generate(CTX, 'client-1', REG_ALERT, 'Acme Defense');

    expect(r.lowConfidence).toBe(true);
    const headings = r.sections.map((s) => s.heading);
    expect(headings).toContain('Rule or action summary');
    expect(headings).toContain('Comment & effective deadlines');
    expect(headings).not.toContain('What happened');
  });

  it('emits no deadline claim at all when the rule carries no dates', async () => {
    const { service } = makeDeps();
    const cap = captureFetch();

    await service.generate(
      CTX,
      'client-1',
      { ...REG_ALERT, regulation: { ...REG_ALERT.regulation, commentEndDate: null } },
      'Acme Defense',
    );

    expect(cap.prompt()).not.toContain('Public comment period closes');
    expect(cap.prompt()).not.toContain('undefined');
  });
});

describe('the FEDERAL bill memo is untouched (regression lock)', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('still uses the federal prompt and the original section list', async () => {
    const { service } = makeDeps();
    const cap = captureFetch();

    await service.generate(
      CTX,
      'client-1',
      {
        alertId: 'a-b',
        sourceType: 'bill',
        title: 'H.R. 8800: Rule granted',
        billDisplayNum: 'H.R. 8800',
        billTitle: 'National Defense Manufacturing Act',
      },
      'Acme Defense',
    );

    expect(cap.body().system).toContain('senior federal government-affairs strategist');
    const prompt = cap.prompt();
    expect(prompt).toContain('Bottom line, What happened, Why it matters, Recommended actions, Talking points');
    // No state/regulation framing leaks into a federal memo.
    expect(prompt).not.toContain('STATE legislation');
    expect(prompt).not.toContain('Issuing agency');
  });
});

describe('AlertMemoAlertDto — state_bill + regulation widening (§4.5)', () => {
  it('accepts state_bill with a deadline block and regulation with a rule block', () => {
    expect(
      validateSync(
        plainToInstance(AlertMemoAlertDto, {
          alertId: 'a',
          sourceType: 'state_bill',
          title: 'T',
          jurisdiction: 'CA',
          deadline: { cutoffType: 'committeeCutoff', cutoffDate: '2026-08-01', daysUntil: 5 },
        }),
        { whitelist: true, forbidNonWhitelisted: true },
      ),
    ).toHaveLength(0);
    expect(
      validateSync(
        plainToInstance(AlertMemoAlertDto, {
          alertId: 'a',
          sourceType: 'regulation',
          title: 'T',
          regulation: { ruleTitle: 'R', agency: 'EPA', ruleType: 'Proposed Rule' },
        }),
        { whitelist: true, forbidNonWhitelisted: true },
      ),
    ).toHaveLength(0);
  });

  it('STILL rejects an unknown sourceType and an unknown key inside a nested block', () => {
    expect(
      validateSync(
        plainToInstance(AlertMemoAlertDto, { alertId: 'a', sourceType: 'martian_decree', title: 'T' }),
        { whitelist: true, forbidNonWhitelisted: true },
      ).length,
    ).toBeGreaterThan(0);
    expect(
      validateSync(
        plainToInstance(AlertMemoAlertDto, {
          alertId: 'a',
          sourceType: 'regulation',
          title: 'T',
          regulation: { ruleTitle: 'R', bogus: 1 },
        }),
        { whitelist: true, forbidNonWhitelisted: true },
      ).length,
    ).toBeGreaterThan(0);
  });
});
