import { MeriToolsService } from './meri-tools.service.js';
import { evaluateMemoryCandidate } from '../memory/memory-candidate-rules.js';

const firmReason =
  'Firm-wide memory remains pending until an authorized administrator approves it. An authorized administrator may approve their own proposal.';
const clientReason =
  'Client-scope memory remains pending until authorized approval. An authorized administrator may approve their own proposal; other reviewers must be different from the proposer and satisfy the existing grant and assignment requirements.';
const firmMessage =
  "I've proposed this as firm-wide memory. It remains pending until an authorized administrator approves it; an authorized administrator may approve their own proposal. I can save it as your personal memory right now instead — just say so.";
const clientMessage =
  "I've proposed this as client-scope memory. It remains pending until authorized approval. An authorized administrator may approve their own proposal; other reviewers must be different from the proposer and satisfy the existing grant and assignment requirements. I can save it as your personal memory right now instead — just say so.";

describe('approved memory policy wording without authorization changes', () => {
  it.each(['firm', 'client'] as const)(
    'retains pending %s creation for ordinary and administrator proposers',
    (scope) => {
      for (const isAdmin of [false, true]) {
        expect(evaluateMemoryCandidate({ scope, isAdmin })).toEqual({
          outcome: 'WARN',
          ruleId: `memory.${scope}.requires_approval`,
          reason: scope === 'firm' ? firmReason : clientReason,
        });
      }
    },
  );

  it.each([
    ['firm', 'standard_user'],
    ['firm', 'user_admin'],
    ['firm', 'capiro_admin'],
    ['client', 'standard_user'],
    ['client', 'user_admin'],
    ['client', 'capiro_admin'],
  ])(
    'keeps the %s pending receipt and offers personal memory without saving it (role=%s)',
    async (scope, role) => {
      const proposeSaveMemory = jest.fn(async () => ({
        status: 'pending',
        candidateId: 'candidate-synthetic',
      }));
      const service = Object.create(MeriToolsService.prototype) as any;
      service.memoryCandidates = { proposeSaveMemory };
      service.logger = { log: jest.fn() };
      const result = await service.saveMemory(
        { tenantId: 'tenant-synthetic', userId: 'actor-synthetic', role },
        {
          scope,
          content: 'Synthetic policy note',
          key: 'synthetic-key',
          clientId: 'client-synthetic',
        },
      );
      expect(result).toEqual({
        saved: false,
        scope,
        candidateId: 'candidate-synthetic',
        message: scope === 'firm' ? firmMessage : clientMessage,
      });
      expect(proposeSaveMemory).toHaveBeenCalledTimes(1);
      expect(proposeSaveMemory).toHaveBeenCalledWith(
        'tenant-synthetic',
        'actor-synthetic',
        expect.objectContaining({ scope }),
        role !== 'standard_user',
      );
    },
  );
});
