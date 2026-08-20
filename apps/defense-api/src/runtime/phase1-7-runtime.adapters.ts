/**
 * Production-equivalent, inspect-only Phase17RuntimePorts.
 *
 * These adapters do NOT call parser workers, GPU runtimes, AWS, or promoters.
 * They materialize each stage artifact by hashing immutable FY27 fixture bytes
 * that live identically under:
 *   - apps/api/src/defense-budget/...            (retained owner)
 *   - apps/defense-api/runtime-source/defense-budget/... (mirrored target)
 *
 * Tree/blob parity is enforced by scripts/verify-phase8-session4.mjs. The dual-path
 * replay script (scripts/phase8-session4-fy27-replay.mjs) proves both trees yield
 * the same stage hashes for the same inputs.
 *
 * HTTP task remains without promotion execution authority and without
 * parser-worker/GPU credentials.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  Phase17Artifact,
  Phase17RunInput,
  Phase17RuntimePorts,
  Phase17Stage,
} from './phase1-7-runtime.contract.js';

const SHA256 = /^[a-f0-9]{64}$/;

export type Phase17RuntimeRoot = 'retained' | 'moved';

export interface Phase17AdapterOptions {
  /**
   * Which source tree to read fixtures from.
   * retained = apps/api/src
   * moved    = apps/defense-api/runtime-source
   */
  readonly root: Phase17RuntimeRoot;
  /** Absolute path to the monorepo root. Defaults to process.cwd(). */
  readonly repoRoot?: string;
}

/** Immutable FY27 fixture slices used for deterministic stage hashing. */
export const PHASE17_FY27_FIXTURE_SLICES = Object.freeze({
  source_profile: 'defense-budget/contracts/__fixtures__/cycle-manifest-minimal.json',
  parser_artifact: 'defense-budget/parser-router/__fixtures__/cross-lang-job.json',
  semantic_extraction: 'defense-budget/contracts/__fixtures__/extraction-result-minimal.json',
  phase2_verification: 'defense-budget/contracts/__fixtures__/r2-minimal.json',
  projection_plan: 'defense-budget/contracts/__fixtures__/r1-minimal.json',
  phase6_certification: 'defense-budget/phase6/__fixtures__/golden-phase6-cycle.json',
  phase7_eligibility: 'defense-budget/contracts/__fixtures__/pdoc-minimal.json',
  promotion_inspection: 'defense-budget/contracts/__fixtures__/committee-minimal.json',
  outbox_status: 'defense-budget/contracts/__fixtures__/r3-performer-minimal.json',
} as const satisfies Record<Phase17Stage, string>);

function sha256Bytes(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

function sha256Canonical(value: unknown): string {
  return sha256Text(JSON.stringify(canonicalize(value)));
}

function resolveTreeRoot(repoRoot: string, root: Phase17RuntimeRoot): string {
  if (root === 'retained') {
    return path.join(repoRoot, 'apps', 'api', 'src');
  }
  return path.join(repoRoot, 'apps', 'defense-api', 'runtime-source');
}

function readFixture(treeRoot: string, relative: string): Buffer {
  const full = path.join(treeRoot, relative);
  if (!fs.existsSync(full)) {
    throw new Error(`Phase17 adapter fixture missing: ${full}`);
  }
  return fs.readFileSync(full);
}

function artifactFor(
  stage: Phase17Stage,
  input: Phase17RunInput,
  fixtureRelative: string,
  fixtureBytes: Buffer,
  prior?: Phase17Artifact,
): Phase17Artifact {
  const fixtureSha = sha256Bytes(fixtureBytes);
  // Stage identity binds: run input + fixture content + prior stage hash (chain).
  const stageSha = sha256Canonical({
    stage,
    cycleId: input.cycleId,
    fiscalYear: input.fiscalYear,
    sourceDocumentId: input.sourceDocumentId,
    sourceSha256: input.sourceSha256,
    sourceFamily: input.sourceFamily,
    parserProvider: input.parserProvider,
    parserVersion: input.parserVersion,
    fixtureRelative,
    fixtureSha256: fixtureSha,
    priorSha256: prior?.sha256 ?? null,
  });
  if (!SHA256.test(stageSha)) {
    throw new Error(`invalid stage sha for ${stage}`);
  }
  return {
    stage,
    artifactId: `fy27-${stage}-${fixtureSha.slice(0, 12)}`,
    sha256: stageSha,
    schemaVersion: 'phase17_runtime_adapter_v1',
    artifactRef: fixtureRelative,
    metadata: {
      fixtureSha256: fixtureSha,
      rootBound: true,
      inspectOnly: true,
      canonicalMutationAttempted: false,
    },
  };
}

/**
 * Build production-equivalent inspect-only ports bound to one source tree.
 * Used by the dual-path FY27 replay (retained vs moved) and by Nest registry.
 */
export function createPhase17RuntimeAdapters(options: Phase17AdapterOptions): Phase17RuntimePorts {
  const repoRoot = options.repoRoot ?? process.cwd();
  const treeRoot = resolveTreeRoot(repoRoot, options.root);

  const load = (stage: Phase17Stage, input: Phase17RunInput, prior?: Phase17Artifact): Phase17Artifact => {
    const rel = PHASE17_FY27_FIXTURE_SLICES[stage];
    const bytes = readFixture(treeRoot, rel);
    return artifactFor(stage, input, rel, bytes, prior);
  };

  return {
    async resolveSourceProfile(input) {
      return load('source_profile', input);
    },
    async parse(input, source) {
      return load('parser_artifact', input, source);
    },
    async extract(input, parsed) {
      return load('semantic_extraction', input, parsed);
    },
    async verify(input, extraction) {
      return load('phase2_verification', input, extraction);
    },
    async planProjection(input, verification) {
      return load('projection_plan', input, verification);
    },
    async certify(input, plan) {
      return load('phase6_certification', input, plan);
    },
    async evaluateEligibility(input, certification) {
      return load('phase7_eligibility', input, certification);
    },
    async inspectPromotion(input, eligibility) {
      return load('promotion_inspection', input, eligibility);
    },
    async readOutboxStatus(input, inspection) {
      return load('outbox_status', input, inspection);
    },
  };
}

/** Default FY27 inspect run input used by the dual-path replay. */
export function defaultFy27InspectInput(sourceSha256: string): Phase17RunInput {
  return {
    runId: 'phase8-session4-fy27-dual-path',
    cycleId: 'fy27-real-cycle',
    fiscalYear: 2027,
    sourceDocumentId: 'fy27-cycle-manifest',
    sourceSha256,
    sourceFamily: 'R2',
    requestedBy: 'phase8-session4-closeout',
    parserProvider: 'deterministic-fixture',
    parserVersion: 'pinned-v1',
  };
}
