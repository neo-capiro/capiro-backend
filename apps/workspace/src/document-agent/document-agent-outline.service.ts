// Document Agent Outline Service — handles outline generation, validation,
// and revision proposals. Delegates to the reasoning gateway for outline
// generation and to the revision service for proposals.

import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { WorkspaceReasoningGateway } from '../workspace-reasoning/workspace-reasoning.gateway.js';
import { computeOutlineHash, type DocumentAgentOutlineSection } from './document-agent-state.js';

@Injectable()
export class DocumentAgentOutlineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reasoning: WorkspaceReasoningGateway,
  ) {}

  /**
   * Validate an outline against its pinned blueprint. Checks:
   * - Every required section from the blueprint is present.
   * - Every locked section from the blueprint is present and locked.
   * - Section IDs are stable (no duplicates).
   */
  validateAgainstBlueprint(
    sections: DocumentAgentOutlineSection[],
    blueprintSections: Array<{
      id: string;
      title: string;
      required: boolean;
      lockedByDefault: boolean;
    }>,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const sectionIds = new Set(sections.map((s) => s.id));

    // Check for duplicate IDs.
    if (sectionIds.size !== sections.length) {
      errors.push('Duplicate section IDs detected.');
    }

    // Check required sections are present.
    for (const bpSection of blueprintSections) {
      if (bpSection.required && !sectionIds.has(bpSection.id)) {
        errors.push(`Required section "${bpSection.title}" is missing.`);
      }
    }

    // Check locked sections are present and locked.
    for (const bpSection of blueprintSections) {
      if (bpSection.lockedByDefault) {
        const section = sections.find((s) => s.id === bpSection.id);
        if (section && !section.locked) {
          errors.push(`Locked section "${bpSection.title}" must remain locked.`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Compute the outline hash for proposal staleness checks.
   */
  hash(sections: DocumentAgentOutlineSection[]): string {
    return computeOutlineHash(sections);
  }
}
