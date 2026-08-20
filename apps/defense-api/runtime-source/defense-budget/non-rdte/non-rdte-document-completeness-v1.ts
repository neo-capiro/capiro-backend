import type { BudgetCycleManifestDocumentV1 } from '../contracts/budget-cycle-manifest-v1.js';
import type {
  BudgetLineKindV1,
  DefenseBudgetExtractionArtifactV1,
} from '../contracts/extraction-artifact-v1.js';

export interface Phase5DocumentCompletenessFindingV1 {
  code: string;
  blocking: boolean;
  message: string;
}

function assertionLineKinds(
  artifact: DefenseBudgetExtractionArtifactV1,
): ReadonlySet<BudgetLineKindV1> {
  const kinds = new Set<BudgetLineKindV1>();
  for (const assertion of artifact.assertions) {
    switch (assertion.assertionKind) {
      case 'procurement_line':
        kinds.add(assertion.parentIdentity.lineKind);
        break;
      case 'om_line':
      case 'milcon_project':
      case 'funding':
      case 'quantity':
      case 'unit_cost':
      case 'narrative':
        kinds.add(assertion.identity.lineKind);
        break;
      case 'relationship':
        kinds.add(assertion.from.lineKind);
        kinds.add(assertion.to.lineKind);
        break;
      default:
        break;
    }
  }
  return kinds;
}

export function inspectPhase5DocumentCompleteness(input: {
  document: BudgetCycleManifestDocumentV1;
  artifact: DefenseBudgetExtractionArtifactV1;
}): Phase5DocumentCompletenessFindingV1[] {
  const { document, artifact } = input;
  const findings: Phase5DocumentCompletenessFindingV1[] = [];
  if (
    artifact.source.manifestDocumentKey !== document.documentKey ||
    artifact.source.family !== document.family ||
    artifact.source.exhibit !== document.exhibit ||
    artifact.source.component !== document.component
  ) {
    findings.push({
      code: 'manifest_artifact_identity_mismatch',
      blocking: true,
      message: `artifact ${artifact.artifactId} does not match manifest document ${document.documentKey}`,
    });
  }
  if (document.required && !document.allowEmpty && artifact.assertions.length === 0) {
    findings.push({
      code: 'required_document_empty',
      blocking: true,
      message: `required document ${document.documentKey} emitted no assertions`,
    });
  }
  if (document.required && artifact.summary.completenessStatus === 'incomplete') {
    findings.push({
      code: 'required_document_incomplete',
      blocking: true,
      message: `required document ${document.documentKey} has incomplete source-fact coverage`,
    });
  }
  const actualKinds = assertionLineKinds(artifact);
  for (const expected of document.expectedLineKinds) {
    if (expected === 'UNKNOWN') continue;
    if (!actualKinds.has(expected)) {
      findings.push({
        code: 'expected_line_kind_missing',
        blocking: document.required,
        message: `${document.documentKey} did not emit expected line kind ${expected}`,
      });
    }
  }
  return findings;
}
