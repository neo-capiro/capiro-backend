import { LearningSignalCandidateService } from './learning-signal-candidate.service.js';
import { evaluateMemoryCandidate } from '../memory/memory-candidate-rules.js';

jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: jest.fn() }));
jest.mock('../memory/memory-candidate.service.js', () => ({ MemoryCandidateService: jest.fn() }));
jest.mock('./learning-signal-memory-conflict.service.js', () => ({
  LearningSignalMemoryConflictService: jest.fn(),
}));

const tenantId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const findingId = '33333333-3333-4333-8333-333333333333';
const signalId = '44444444-4444-4444-8444-444444444444';

function setup(proposedValue: unknown) {
  const signal = {
    id: signalId,
    tenantId,
    actorUserId: 'actor-1',
    clientId,
    sourceSurface: 'crm.fill_with_meri',
    signalType: 'crm_finding_accepted',
    proposedMemoryLayer: 'client-steering',
    sensitivity: 'normal',
    provenanceKind: 'human_explicit',
    evidenceJsonb: [{ type: 'client_profile_fill_finding', id: findingId }],
    provenanceJsonb: {
      kind: 'capability',
      targetKey: 'capability:test',
      source: 'client_document',
    },
  };
  let outcome: Record<string, unknown> | null = null;
  const queryRaw = jest.fn(async (parts: TemplateStringsArray) =>
    parts.join('').includes('proposed_value_jsonb')
      ? proposedValue === undefined
        ? []
        : [{ proposedValue }]
      : [],
  );
  const tx = {
    $queryRaw: queryRaw,
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
    learningSignal: { findFirst: jest.fn().mockResolvedValue(signal) },
    learningSignalCandidateOutcome: {
      findUnique: jest.fn(async () => outcome),
      create: jest.fn(async ({ data }) => {
        outcome = data;
        return data;
      }),
      findUniqueOrThrow: jest.fn(async () => outcome),
    },
  };
  const prisma = { withTenant: jest.fn(async (_tenant, fn) => fn(tx)) };
  const proposeSaveMemory = jest
    .fn()
    .mockResolvedValue({ status: 'pending', candidateId: 'candidate-1' });
  const findBestActiveMemoryMatch = jest.fn().mockResolvedValue(null);
  const service = new LearningSignalCandidateService(
    prisma as never,
    { proposeSaveMemory } as never,
    { findBestActiveMemoryMatch } as never,
  );
  return { service, tx, queryRaw, proposeSaveMemory, findBestActiveMemoryMatch };
}

describe('learning captures retain actual source facts before governed review', () => {
  const previous = {
    generation: process.env.LEARNING_CANDIDATE_GENERATION,
    tenants: process.env.LEARNING_TENANTS,
  };
  beforeAll(() => {
    process.env.LEARNING_CANDIDATE_GENERATION = 'enabled';
    process.env.LEARNING_TENANTS = tenantId;
  });
  afterAll(() => {
    if (previous.generation === undefined) delete process.env.LEARNING_CANDIDATE_GENERATION;
    else process.env.LEARNING_CANDIDATE_GENERATION = previous.generation;
    if (previous.tenants === undefined) delete process.env.LEARNING_TENANTS;
    else process.env.LEARNING_TENANTS = previous.tenants;
  });

  it.each([
    {
      name: 'FortressHUMS',
      description: 'UH-72 vibration monitoring',
      tags: ['rotorcraft', 'flight test'],
      testAircraft: 2,
    },
    { name: 'Dana Chen', title: 'VP Government Affairs', email: 'dana@example.test' },
    { name: 'Orlando integration laboratory', city: 'Orlando', state: 'FL', zip: '32801' },
  ])(
    'proposes the actual accepted finding for %j with source excerpt and mandatory review',
    async (finding) => {
      const m = setup(finding);
      const result = await m.service.generateForSignal(tenantId, signalId);
      expect(result?.memoryCandidateId).toBe('candidate-1');
      const proposed = m.proposeSaveMemory.mock.calls[0]![2];
      for (const value of Object.values(finding)) {
        expect(proposed.value).toContain(typeof value === 'string' ? value : JSON.stringify(value));
      }
      expect(proposed.sourceExcerpt).toContain(finding.name);
      expect(proposed.sourceId).toBe(signalId);
      expect(proposed.clientId).toBe(clientId);
      expect(m.proposeSaveMemory.mock.calls[0]![4]).toBe('learning_signal');
      expect(
        evaluateMemoryCandidate({ scope: 'client', isAdmin: true, sourceKind: 'learning_signal' })
          .outcome,
      ).toBe('WARN');
      const factQuery = m.queryRaw.mock.calls.find(([parts]) =>
        parts.join('').includes('proposed_value_jsonb'),
      )!;
      expect(factQuery[0].join('')).toContain('AND client_id =');
      expect(factQuery[0].join('')).toContain("status = 'accepted'");
      await m.service.generateForSignal(tenantId, signalId);
      expect(m.proposeSaveMemory).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, {}, null])(
    'records insufficient evidence for a missing fact %j without another metadata-only candidate',
    async (finding) => {
      const m = setup(finding);
      const result = await m.service.generateForSignal(tenantId, signalId);
      expect(result).toMatchObject({
        eligibility: 'insufficient_evidence',
        memoryCandidateId: null,
      });
      expect(m.proposeSaveMemory).not.toHaveBeenCalled();
      expect(m.findBestActiveMemoryMatch).not.toHaveBeenCalled();
    },
  );
});
