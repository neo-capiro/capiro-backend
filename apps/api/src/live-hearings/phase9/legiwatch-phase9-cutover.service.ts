import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  LEGIWATCH_PHASE9_CONFIRMATIONS,
  type LegiWatchPhase9CutoverPhase,
  type LegiWatchPhase9RolloutState,
} from './legiwatch-phase9.types.js';

const EVIDENCE_TYPES = new Set([
  'LIVE_DISCOVERY',
  'LIVE_RESOLUTION',
  'LIVE_CAPTURE',
  'LIVE_DEEPGRAM',
  'RECOVERY_GAP',
  'WORKER_CRASH_RECOVERY',
  'NETWORK_RECOVERY',
  'DEEPGRAM_RECOVERY',
  'DUPLICATE_SUPPRESSION',
  'CONCURRENT_CAPTURES',
  'DELAYED_START',
  'CANCELLATION',
  'RESCHEDULE',
  'SOURCE_ROTATION',
  'COMMITTEE_SITE_CHANGE',
  'BROWSER_FALLBACK',
  'POLICY_BLOCK',
  'SILENCE_HANDLING',
  'SPEAKER_ATTRIBUTION',
  'TENANT_RLS',
  'INTELLIGENCE_LATENCY',
  'ROLLBACK',
]);
const EVIDENCE_SOURCES = new Set(['LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED']);
const EVIDENCE_STATUSES = new Set(['PASS', 'FAIL', 'BLOCKED']);
const LIVE_CAPTURE_EVIDENCE = new Set(['LIVE_CAPTURE', 'LIVE_DEEPGRAM']);
const FORBIDDEN_DETAIL_KEY_FRAGMENTS = [
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'deepgramkey',
  'mediaurl',
  'password',
  'privatekey',
  'rawaudio',
  'secret',
  'tenantid',
  'clientid',
  'watchlist',
] as const;

interface StateRow {
  phase: string;
  productionDefault: boolean;
  schedulesEnabled: boolean;
  killSwitchEngaged: boolean;
  captureAllPublicEvents: boolean;
  minimumConsecutivePasses: number;
  minimumShadowHours: number;
  consecutivePasses: number;
  shadowStartedAt: Date;
  canaryStartedAt: Date | null;
  cutoverAt: Date | null;
  rollbackAt: Date | null;
  lastRunId: string | null;
  lastPassingRunId: string | null;
  updatedBy: string;
  updatedAt: Date;
}

interface RunRow {
  id: string;
  mode: string;
  status: string;
  evidenceSource: string;
  blockerCount: number;
  createdAt: Date;
}

interface EvidenceRow {
  id: string;
  evidenceType: string;
  evidenceSource: string;
  status: string;
  hearingId: string | null;
  captureId: string | null;
  runId: string | null;
  observedAt: Date;
  expiresAt: Date | null;
  artifactUri: string | null;
  details: unknown;
  recordedBy: string;
  createdAt: Date;
}

@Injectable()
export class LegiWatchPhase9CutoverService {
  constructor(private readonly prisma: PrismaService) {}

  async state(): Promise<LegiWatchPhase9RolloutState> {
    const rows = await this.prisma.$queryRawUnsafe<StateRow[]>(
      `SELECT phase,
              production_default AS "productionDefault",
              schedules_enabled AS "schedulesEnabled",
              kill_switch_engaged AS "killSwitchEngaged",
              capture_all_public_events AS "captureAllPublicEvents",
              minimum_consecutive_passes AS "minimumConsecutivePasses",
              minimum_shadow_hours AS "minimumShadowHours",
              consecutive_passes AS "consecutivePasses",
              shadow_started_at AS "shadowStartedAt",
              canary_started_at AS "canaryStartedAt",
              cutover_at AS "cutoverAt",
              rollback_at AS "rollbackAt",
              last_run_id::text AS "lastRunId",
              last_passing_run_id::text AS "lastPassingRunId",
              updated_by AS "updatedBy",
              updated_at AS "updatedAt"
       FROM legiwatch_cutover_state
       WHERE id='global'
       LIMIT 1`,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('LegiWatch Phase 9 cutover state is missing');
    return mapState(row);
  }

  async rolloutDecision(): Promise<{
    phase: LegiWatchPhase9CutoverPhase;
    productionDefault: boolean;
    killSwitchEngaged: boolean;
    canary: boolean;
    liveHearingsV2DefaultEnabled: boolean;
    schedulesEnabled: boolean;
    captureAllPublicEvents: boolean;
    asOf: string;
  }> {
    const state = await this.state();
    return {
      phase: state.phase,
      productionDefault: state.productionDefault,
      killSwitchEngaged: state.killSwitchEngaged,
      canary: state.phase === 'CANARY' || state.phase === 'READY',
      liveHearingsV2DefaultEnabled:
        state.phase === 'CUTOVER' && state.productionDefault && !state.killSwitchEngaged,
      schedulesEnabled: state.schedulesEnabled,
      captureAllPublicEvents: state.captureAllPublicEvents,
      asOf: new Date().toISOString(),
    };
  }

  async transition(input: {
    target: LegiWatchPhase9CutoverPhase;
    actor: string;
    confirmation: string;
  }): Promise<LegiWatchPhase9RolloutState> {
    const state = await this.state();
    if (state.phase === input.target) return state;
    const actor = bounded(input.actor, 200);
    const expected = confirmationForTarget(input.target);
    if (input.confirmation !== expected) {
      throw new ConflictException(`Exact confirmation required: ${expected}`);
    }
    const latest = await this.latestRun();
    const now = new Date();

    if (input.target === 'CANARY') {
      requirePhase(state.phase, 'SHADOW', input.target);
      if (!state.schedulesEnabled) {
        throw new ConflictException('Shadow schedules must be registered and enabled before canary');
      }
      requirePassingRun(latest, new Set(['SHADOW', 'READINESS']));
      await this.updateState(
        `phase='CANARY',
         canary_started_at=COALESCE(canary_started_at, now()),
         updated_by=$1,
         updated_at=now()`,
        [actor],
      );
      return this.state();
    }

    if (input.target === 'READY') {
      requirePhase(state.phase, 'CANARY', input.target);
      if (!state.schedulesEnabled) {
        throw new ConflictException('Canary schedules are not enabled');
      }
      requirePassingRun(latest, new Set(['CANARY', 'READINESS']));
      const shadowHours = Math.floor(
        (now.getTime() - new Date(state.shadowStartedAt).getTime()) / 3_600_000,
      );
      if (shadowHours < state.minimumShadowHours) {
        throw new ConflictException(
          `Shadow window is ${shadowHours}h; at least ${state.minimumShadowHours}h is required`,
        );
      }
      if (state.consecutivePasses < state.minimumConsecutivePasses) {
        throw new ConflictException(
          `${state.consecutivePasses} consecutive passing runs; ${state.minimumConsecutivePasses} required`,
        );
      }
      await this.updateState(
        `phase='READY', updated_by=$1, updated_at=now()`,
        [actor],
      );
      return this.state();
    }

    if (input.target === 'CUTOVER') {
      requirePhase(state.phase, 'READY', input.target);
      if (process.env.LEGIWATCH_ALLOW_PRODUCTION_CUTOVER !== 'true') {
        throw new ConflictException(
          'Production cutover is disabled; set LEGIWATCH_ALLOW_PRODUCTION_CUTOVER=true in the controlled operator environment',
        );
      }
      if (!state.schedulesEnabled) {
        throw new ConflictException('All required production schedules must be enabled before cutover');
      }
      requirePassingRun(latest, new Set(['CUTOVER_VERIFICATION']));
      if (!latest || !['LIVE', 'MIXED'].includes(latest.evidenceSource)) {
        throw new ConflictException('The latest cutover verification must include LIVE or MIXED evidence');
      }
      if (latest.blockerCount !== 0) {
        throw new ConflictException('The latest cutover verification still has blockers');
      }
      await this.updateState(
        `phase='CUTOVER',
         production_default=true,
         kill_switch_engaged=false,
         cutover_at=now(),
         updated_by=$1,
         updated_at=now()`,
        [actor],
      );
      return this.state();
    }

    if (input.target === 'ROLLBACK') {
      if (state.phase !== 'CUTOVER' && state.phase !== 'CANARY' && state.phase !== 'READY') {
        throw new ConflictException(`Cannot roll back from ${state.phase}`);
      }
      await this.prisma.withSystem(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE legiwatch_cutover_state
           SET phase='ROLLBACK',
               production_default=false,
               schedules_enabled=false,
               kill_switch_engaged=true,
               capture_all_public_events=false,
               rollback_at=now(),
               consecutive_passes=0,
               updated_by=$1,
               updated_at=now()
           WHERE id='global'`,
          actor,
        );
        await tx.$executeRawUnsafe(
          `UPDATE legiwatch_runtime_heartbeat
           SET enabled=false,
               schedule_enabled=false,
               status='disabled',
               updated_at=now(),
               metrics=COALESCE(metrics, '{}'::jsonb) || $1::jsonb`,
          JSON.stringify({ rollbackBy: actor, rollbackAt: now.toISOString() }),
        );
      });
      return this.state();
    }

    if (input.target === 'SHADOW') {
      requirePhase(state.phase, 'ROLLBACK', input.target);
      await this.updateState(
        `phase='SHADOW',
         production_default=false,
         schedules_enabled=false,
         kill_switch_engaged=true,
         capture_all_public_events=false,
         consecutive_passes=0,
         shadow_started_at=now(),
         canary_started_at=NULL,
         cutover_at=NULL,
         updated_by=$1,
         updated_at=now()`,
        [actor],
      );
      return this.state();
    }

    throw new ConflictException(`Unsupported target phase ${input.target}`);
  }

  async setCaptureAll(input: {
    enabled: boolean;
    actor: string;
    confirmation: string;
  }): Promise<LegiWatchPhase9RolloutState> {
    const expected = input.enabled
      ? LEGIWATCH_PHASE9_CONFIRMATIONS.CAPTURE_ALL_ON
      : LEGIWATCH_PHASE9_CONFIRMATIONS.CAPTURE_ALL_OFF;
    if (input.confirmation !== expected) {
      throw new ConflictException(`Exact confirmation required: ${expected}`);
    }
    const state = await this.state();
    if (input.enabled) {
      if (state.phase !== 'CUTOVER' || !state.productionDefault || state.killSwitchEngaged) {
        throw new ConflictException('Capture-all is permitted only after a successful CUTOVER');
      }
      if (process.env.LEGIWATCH_ALLOW_CAPTURE_ALL !== 'true') {
        throw new ConflictException(
          'Capture-all is disabled; set LEGIWATCH_ALLOW_CAPTURE_ALL=true in the controlled operator environment',
        );
      }
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE legiwatch_cutover_state
       SET capture_all_public_events=$1,
           updated_by=$2,
           updated_at=now()
       WHERE id='global'`,
      input.enabled,
      bounded(input.actor, 200),
    );
    return this.state();
  }

  async recordEvidence(input: {
    evidenceType: string;
    evidenceSource: string;
    status: string;
    hearingId?: string;
    captureId?: string;
    runId?: string;
    observedAt?: Date;
    expiresAt?: Date;
    artifactUri?: string;
    details?: Record<string, unknown>;
    actor: string;
  }): Promise<Record<string, unknown>> {
    if (!EVIDENCE_TYPES.has(input.evidenceType)) {
      throw new ConflictException(`Unsupported Phase 9 evidence type ${input.evidenceType}`);
    }
    if (!EVIDENCE_SOURCES.has(input.evidenceSource)) {
      throw new ConflictException(`Unsupported Phase 9 evidence source ${input.evidenceSource}`);
    }
    if (!EVIDENCE_STATUSES.has(input.status)) {
      throw new ConflictException(`Unsupported Phase 9 evidence status ${input.status}`);
    }
    if (
      LIVE_CAPTURE_EVIDENCE.has(input.evidenceType) &&
      (!input.hearingId?.trim() || !input.captureId?.trim())
    ) {
      throw new ConflictException(`${input.evidenceType} requires a hearingId and captureId`);
    }
    const observedAt = validDate(input.observedAt) ?? new Date();
    const defaultTtlDays = input.evidenceSource === 'LIVE' ? 30 : 90;
    const expiresAt =
      validDate(input.expiresAt) ??
      new Date(observedAt.getTime() + defaultTtlDays * 86_400_000);
    if (expiresAt.getTime() <= observedAt.getTime()) {
      throw new ConflictException('Evidence expiry must be after observedAt');
    }
    const details = input.details ?? {};
    assertEvidenceDetailsSafe(details);
    const artifactUri = input.artifactUri ? safeArtifactUri(input.artifactUri) : null;
    const rows = await this.prisma.$queryRawUnsafe<EvidenceRow[]>(
      `INSERT INTO legiwatch_verification_evidence (
         evidence_type, evidence_source, status, hearing_id, capture_id, run_id,
         observed_at, expires_at, artifact_uri, details, recorded_by, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6::uuid, $7, $8, $9, $10::jsonb, $11, now()
       )
       RETURNING id::text AS id,
                 evidence_type AS "evidenceType",
                 evidence_source AS "evidenceSource",
                 status,
                 hearing_id AS "hearingId",
                 capture_id AS "captureId",
                 run_id::text AS "runId",
                 observed_at AS "observedAt",
                 expires_at AS "expiresAt",
                 artifact_uri AS "artifactUri",
                 details,
                 recorded_by AS "recordedBy",
                 created_at AS "createdAt"`,
      input.evidenceType,
      input.evidenceSource,
      input.status,
      input.hearingId?.trim() || null,
      input.captureId?.trim() || null,
      input.runId?.trim() || null,
      observedAt,
      expiresAt,
      artifactUri,
      JSON.stringify(details),
      bounded(input.actor, 200),
    );
    const row = rows[0];
    if (!row) throw new Error('Phase 9 verification evidence did not persist');
    return mapEvidence(row);
  }

  async listEvidence(input: {
    evidenceType?: string;
    status?: string;
    limit?: number;
  }): Promise<Array<Record<string, unknown>>> {
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
    const rows = await this.prisma.$queryRawUnsafe<EvidenceRow[]>(
      `SELECT id::text AS id,
              evidence_type AS "evidenceType",
              evidence_source AS "evidenceSource",
              status,
              hearing_id AS "hearingId",
              capture_id AS "captureId",
              run_id::text AS "runId",
              observed_at AS "observedAt",
              expires_at AS "expiresAt",
              artifact_uri AS "artifactUri",
              details,
              recorded_by AS "recordedBy",
              created_at AS "createdAt"
       FROM legiwatch_verification_evidence
       WHERE ($1::text IS NULL OR evidence_type=$1)
         AND ($2::text IS NULL OR status=$2)
       ORDER BY observed_at DESC, id DESC
       LIMIT $3`,
      input.evidenceType?.trim() || null,
      input.status?.trim() || null,
      limit,
    );
    return rows.map(mapEvidence);
  }

  private async latestRun(): Promise<RunRow | null> {
    const rows = await this.prisma.$queryRawUnsafe<RunRow[]>(
      `SELECT id::text AS id,
              mode,
              status,
              evidence_source AS "evidenceSource",
              blocker_count AS "blockerCount",
              created_at AS "createdAt"
       FROM legiwatch_cutover_run
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  private async updateState(setClause: string, values: unknown[]): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE legiwatch_cutover_state SET ${setClause} WHERE id='global'`,
      ...values,
    );
  }
}

function confirmationForTarget(target: LegiWatchPhase9CutoverPhase): string {
  if (target === 'CANARY') return LEGIWATCH_PHASE9_CONFIRMATIONS.CANARY;
  if (target === 'READY') return LEGIWATCH_PHASE9_CONFIRMATIONS.READY;
  if (target === 'CUTOVER') return LEGIWATCH_PHASE9_CONFIRMATIONS.CUTOVER;
  if (target === 'ROLLBACK') return LEGIWATCH_PHASE9_CONFIRMATIONS.ROLLBACK;
  if (target === 'SHADOW') return 'RETURN LEGIWATCH TO SHADOW';
  return target;
}

function requirePhase(
  actual: LegiWatchPhase9CutoverPhase,
  expected: LegiWatchPhase9CutoverPhase,
  target: LegiWatchPhase9CutoverPhase,
): void {
  if (actual !== expected) {
    throw new ConflictException(`${expected} is required before transition to ${target}; current phase is ${actual}`);
  }
}

function requirePassingRun(run: RunRow | null, allowedModes: ReadonlySet<string>): void {
  if (!run || run.status !== 'PASS' || run.blockerCount !== 0 || !allowedModes.has(run.mode)) {
    throw new ConflictException(
      `A blocker-free passing ${[...allowedModes].join('/')} readiness run is required`,
    );
  }
}

function mapState(row: StateRow): LegiWatchPhase9RolloutState {
  return {
    phase: row.phase as LegiWatchPhase9CutoverPhase,
    productionDefault: row.productionDefault,
    schedulesEnabled: row.schedulesEnabled,
    killSwitchEngaged: row.killSwitchEngaged,
    captureAllPublicEvents: row.captureAllPublicEvents,
    minimumConsecutivePasses: row.minimumConsecutivePasses,
    minimumShadowHours: row.minimumShadowHours,
    consecutivePasses: row.consecutivePasses,
    shadowStartedAt: row.shadowStartedAt.toISOString(),
    canaryStartedAt: row.canaryStartedAt?.toISOString() ?? null,
    cutoverAt: row.cutoverAt?.toISOString() ?? null,
    rollbackAt: row.rollbackAt?.toISOString() ?? null,
    lastRunId: row.lastRunId,
    lastPassingRunId: row.lastPassingRunId,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapEvidence(row: EvidenceRow): Record<string, unknown> {
  return {
    id: row.id,
    evidenceType: row.evidenceType,
    evidenceSource: row.evidenceSource,
    status: row.status,
    hearingId: row.hearingId,
    captureId: row.captureId,
    runId: row.runId,
    observedAt: row.observedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    artifactUri: row.artifactUri,
    details: row.details,
    recordedBy: row.recordedBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function validDate(value: Date | undefined): Date | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
}

function bounded(value: string, maximum: number): string {
  const clean = value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, maximum);
  if (!clean) throw new ConflictException('A non-empty value is required');
  return clean;
}

function safeArtifactUri(value: string): string {
  const clean = value.trim().slice(0, 1_000);
  if (clean.startsWith('arn:aws:')) return clean;
  let parsed: URL;
  try {
    parsed = new URL(clean);
  } catch {
    throw new ConflictException('artifactUri must be an HTTPS, S3, or AWS ARN reference');
  }
  if (!['https:', 's3:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new ConflictException('artifactUri must be credential-free HTTPS, S3, or AWS ARN');
  }
  return parsed.toString();
}

function assertEvidenceDetailsSafe(value: unknown, path = '$', depth = 0): void {
  if (depth > 8) throw new ConflictException('Evidence details are too deeply nested');
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertEvidenceDetailsSafe(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (FORBIDDEN_DETAIL_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment))) {
      throw new ConflictException(`Evidence details contain forbidden field ${path}.${key}`);
    }
    assertEvidenceDetailsSafe(child, `${path}.${key}`, depth + 1);
  }
  if (JSON.stringify(value).length > 20_000) {
    throw new ConflictException('Evidence details exceed 20 KB');
  }
}
