import { ServiceUnavailableException } from '@nestjs/common';
import type { GenerateSectionResult } from './generation.service.js';
import {
  assessGeneratedSectionsForRelease,
  generationClaimHoldEnforced,
} from './generation-assurance.js';

export interface SingleSectionAssuranceSummary {
  section: string;
  decision: string;
  held: boolean;
  blockerCount: number;
  envelopeHash: string;
}

/**
 * Apply the same Phase 16 claim gate used by generate-all before a standalone
 * generated section leaves Workspace. The authenticated controller establishes
 * the tenant request scope; this helper accepts no browser-supplied tenant,
 * release mode, or verification decision.
 */
export function assertSingleGeneratedSectionRelease(
  result: GenerateSectionResult,
): SingleSectionAssuranceSummary {
  const assessed = assessGeneratedSectionsForRelease({
    generated: [{ section: result.section, html: result.content }],
    sectionCitations: { [result.section]: result.citations },
    requestContext: result.section,
    contextPacketId: result.provenance.contextPacketId,
  });
  const verdict = assessed.verdicts[0];
  if (!verdict) {
    throw new ServiceUnavailableException(
      'Generated section verification produced no release decision. Nothing was returned.',
    );
  }

  if (generationClaimHoldEnforced() && verdict.held) {
    throw new ServiceUnavailableException({
      statusCode: 503,
      code: 'workspace_section_assurance_hold',
      message:
        'This generated section was not returned because required claim verification did not pass. Nothing was applied or saved.',
      section: result.section,
      blockers: verdict.blockers.slice(0, 6),
      envelopeHash: verdict.envelope.hash,
    });
  }

  return {
    section: result.section,
    decision: verdict.decision,
    held: verdict.held,
    blockerCount: verdict.blockers.length,
    envelopeHash: verdict.envelope.hash,
  };
}
