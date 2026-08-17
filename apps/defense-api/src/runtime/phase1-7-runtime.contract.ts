import { createHash } from 'node:crypto';

export type Phase17Stage =
  | 'source_profile'
  | 'parser_artifact'
  | 'semantic_extraction'
  | 'phase2_verification'
  | 'projection_plan'
  | 'phase6_certification'
  | 'phase7_eligibility'
  | 'promotion_inspection'
  | 'outbox_status';

export interface Phase17Artifact {
  readonly stage: Phase17Stage;
  readonly artifactId: string;
  readonly sha256: string;
  readonly schemaVersion: string;
  readonly artifactRef?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface Phase17RunInput {
  readonly runId: string;
  readonly cycleId: string;
  readonly fiscalYear: number;
  readonly sourceDocumentId: string;
  readonly sourceSha256: string;
  readonly sourceFamily: string;
  readonly requestedBy: string;
  readonly parserProvider: string;
  readonly parserVersion: string;
}

export interface Phase17RunResult {
  readonly mode: 'inspect_only';
  readonly runId: string;
  readonly cycleId: string;
  readonly fiscalYear: number;
  readonly sourceDocumentId: string;
  readonly artifacts: readonly Phase17Artifact[];
  readonly lineageSha256: string;
  readonly canonicalMutationAttempted: false;
}

export interface Phase17RuntimePorts {
  resolveSourceProfile(input: Phase17RunInput): Promise<Phase17Artifact>;
  parse(input: Phase17RunInput, source: Phase17Artifact): Promise<Phase17Artifact>;
  extract(input: Phase17RunInput, parsed: Phase17Artifact): Promise<Phase17Artifact>;
  verify(input: Phase17RunInput, extraction: Phase17Artifact): Promise<Phase17Artifact>;
  planProjection(input: Phase17RunInput, verification: Phase17Artifact): Promise<Phase17Artifact>;
  certify(input: Phase17RunInput, plan: Phase17Artifact): Promise<Phase17Artifact>;
  evaluateEligibility(input: Phase17RunInput, certification: Phase17Artifact): Promise<Phase17Artifact>;
  inspectPromotion(input: Phase17RunInput, eligibility: Phase17Artifact): Promise<Phase17Artifact>;
  readOutboxStatus(input: Phase17RunInput, inspection: Phase17Artifact): Promise<Phase17Artifact>;
}

const SHA256 = /^[a-f0-9]{64}$/;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function hashCanonical(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function assertInput(input: Phase17RunInput): void {
  if (!input.runId.trim()) throw new TypeError('runId is required');
  if (!input.cycleId.trim()) throw new TypeError('cycleId is required');
  if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 2000 || input.fiscalYear > 2200) {
    throw new RangeError(`Invalid fiscalYear: ${input.fiscalYear}`);
  }
  if (!input.sourceDocumentId.trim()) throw new TypeError('sourceDocumentId is required');
  if (!SHA256.test(input.sourceSha256)) {
    throw new TypeError('sourceSha256 must be a lowercase SHA-256 hex digest');
  }
}

function assertArtifact(artifact: Phase17Artifact, expectedStage: Phase17Stage): void {
  if (artifact.stage !== expectedStage) {
    throw new Error(`Expected ${expectedStage} artifact; received ${artifact.stage}`);
  }
  if (!artifact.artifactId.trim()) throw new TypeError(`${expectedStage} artifactId is required`);
  if (!SHA256.test(artifact.sha256)) {
    throw new TypeError(`${expectedStage} sha256 must be a lowercase SHA-256 hex digest`);
  }
  if (!artifact.schemaVersion.trim()) {
    throw new TypeError(`${expectedStage} schemaVersion is required`);
  }
}

/**
 * Provider-neutral, inspect-only Phase 1–7 composition boundary.
 *
 * The coordinator contains no Nest, Prisma, S3, parser-process, GPU or promoter
 * dependency. Those are injected ports. It can build and inspect a promotion plan,
 * but it intentionally exposes no execute/activate method and records that no
 * canonical mutation was attempted.
 */
export class Phase17RuntimeCoordinator {
  constructor(private readonly ports: Phase17RuntimePorts) {}

  async inspect(input: Phase17RunInput): Promise<Phase17RunResult> {
    assertInput(input);
    const artifacts: Phase17Artifact[] = [];

    const source = await this.ports.resolveSourceProfile(input);
    assertArtifact(source, 'source_profile');
    artifacts.push(source);

    const parsed = await this.ports.parse(input, source);
    assertArtifact(parsed, 'parser_artifact');
    artifacts.push(parsed);

    const extraction = await this.ports.extract(input, parsed);
    assertArtifact(extraction, 'semantic_extraction');
    artifacts.push(extraction);

    const verification = await this.ports.verify(input, extraction);
    assertArtifact(verification, 'phase2_verification');
    artifacts.push(verification);

    const projection = await this.ports.planProjection(input, verification);
    assertArtifact(projection, 'projection_plan');
    artifacts.push(projection);

    const certification = await this.ports.certify(input, projection);
    assertArtifact(certification, 'phase6_certification');
    artifacts.push(certification);

    const eligibility = await this.ports.evaluateEligibility(input, certification);
    assertArtifact(eligibility, 'phase7_eligibility');
    artifacts.push(eligibility);

    const inspection = await this.ports.inspectPromotion(input, eligibility);
    assertArtifact(inspection, 'promotion_inspection');
    artifacts.push(inspection);

    const outbox = await this.ports.readOutboxStatus(input, inspection);
    assertArtifact(outbox, 'outbox_status');
    artifacts.push(outbox);

    return {
      mode: 'inspect_only',
      runId: input.runId,
      cycleId: input.cycleId,
      fiscalYear: input.fiscalYear,
      sourceDocumentId: input.sourceDocumentId,
      artifacts,
      lineageSha256: hashCanonical({
        input: {
          cycleId: input.cycleId,
          fiscalYear: input.fiscalYear,
          parserProvider: input.parserProvider,
          parserVersion: input.parserVersion,
          sourceDocumentId: input.sourceDocumentId,
          sourceFamily: input.sourceFamily,
          sourceSha256: input.sourceSha256,
        },
        artifacts: artifacts.map(({ stage, artifactId, sha256, schemaVersion }) => ({
          stage,
          artifactId,
          sha256,
          schemaVersion,
        })),
      }),
      canonicalMutationAttempted: false,
    };
  }
}
