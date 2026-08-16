import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  AppendKnowledgeAssertionInput,
  KnowledgeAssertionRecord,
} from '../knowledge.types.js';
import { KnowledgeAssertionService } from './knowledge-assertion.service.js';

export type ContradictKnowledgeAssertionInput = Omit<
  AppendKnowledgeAssertionInput,
  'contradictsAssertionId' | 'conflictStatus' | 'conflictGroupId'
> & {
  contradictsAssertionId: string;
  conflictGroupId?: string;
};

/** Represents disagreement by appending a linked assertion; it never overwrites truth. */
@Injectable()
export class AssertionConflictService {
  constructor(private readonly assertions: KnowledgeAssertionService) {}

  async contradict(
    tenantId: string,
    input: ContradictKnowledgeAssertionInput,
  ): Promise<KnowledgeAssertionRecord> {
    const target = await this.assertions.findById(tenantId, input.contradictsAssertionId);
    if (!target) throw new NotFoundException('Contradicted KnowledgeAssertion not found.');

    return this.assertions.append(tenantId, {
      ...input,
      conflictStatus: 'confirmed',
      conflictGroupId: input.conflictGroupId ?? target.conflictGroupId ?? randomUUID(),
    });
  }
}
