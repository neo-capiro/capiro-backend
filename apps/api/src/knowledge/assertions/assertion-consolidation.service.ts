import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  AppendKnowledgeAssertionInput,
  KnowledgeAssertionRecord,
} from '../knowledge.types.js';
import { KnowledgeAssertionService } from './knowledge-assertion.service.js';

export type SupersedeKnowledgeAssertionInput = Omit<
  AppendKnowledgeAssertionInput,
  'supersedesAssertionId'
> & {
  supersedesAssertionId: string;
};

/** Appends a replacement assertion while retaining immutable temporal lineage. */
@Injectable()
export class AssertionConsolidationService {
  constructor(private readonly assertions: KnowledgeAssertionService) {}

  async supersede(
    tenantId: string,
    input: SupersedeKnowledgeAssertionInput,
  ): Promise<KnowledgeAssertionRecord> {
    if (!(await this.assertions.findById(tenantId, input.supersedesAssertionId))) {
      throw new NotFoundException('Superseded KnowledgeAssertion not found.');
    }
    return this.assertions.append(tenantId, input);
  }
}
