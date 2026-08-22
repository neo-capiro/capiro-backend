import { NestFactory } from '@nestjs/core';
import { hostname } from 'node:os';
import { AppModule } from '../../app.module.js';
import { LegiWatchPhase9CutoverService } from './legiwatch-phase9-cutover.service.js';
import { LegiWatchPhase9ReadinessService } from './legiwatch-phase9-readiness.service.js';
import { LegiWatchPhase9RuntimeService, type LegiWatchRuntimeRegistration } from './legiwatch-phase9-runtime.service.js';
import type {
  LegiWatchPhase9CutoverPhase,
  LegiWatchPhase9EvidenceSource,
  LegiWatchPhase9Mode,
} from './legiwatch-phase9.types.js';

const COMMANDS = [
  'state',
  'register-runtime',
  'run-readiness',
  'transition',
  'capture-all',
  'record-evidence',
] as const;
type Command = (typeof COMMANDS)[number];

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  if (!command || !COMMANDS.includes(command)) {
    throw new Error(`usage: run-legiwatch-phase9-operator <${COMMANDS.join('|')}>`);
  }
  const actor =
    process.env.LEGIWATCH_OPERATOR_ID ??
    `phase9-operator:${hostname()}:${process.pid}`;
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const runtime = app.get(LegiWatchPhase9RuntimeService);
    const readiness = app.get(LegiWatchPhase9ReadinessService);
    const cutover = app.get(LegiWatchPhase9CutoverService);
    let result: unknown;
    if (command === 'state') {
      result = {
        state: await cutover.state(),
        rollout: await cutover.rolloutDecision(),
        runtime: await runtime.list(),
      };
    } else if (command === 'register-runtime') {
      result = await runtime.registerSchedules({
        registrations: jsonEnv<LegiWatchRuntimeRegistration[]>(
          'LEGIWATCH_RUNTIME_REGISTRATIONS_JSON',
        ),
        actor,
        confirmation: requiredEnv('LEGIWATCH_CONFIRMATION'),
      });
    } else if (command === 'run-readiness') {
      result = await readiness.evaluateAndPersist(actor, {
        evidenceSource: evidenceSource(),
        mode: mode(),
        lookbackDays: integerEnv('LEGIWATCH_AUDIT_LOOKBACK_DAYS', 60),
        lookaheadDays: integerEnv('LEGIWATCH_AUDIT_LOOKAHEAD_DAYS', 30),
        captureGraceMinutes: integerEnv('LEGIWATCH_CAPTURE_GRACE_MINUTES', 15),
        intelligenceLagMinutes: integerEnv('LEGIWATCH_INTELLIGENCE_LAG_MINUTES', 10),
      });
    } else if (command === 'transition') {
      result = await cutover.transition({
        target: requiredEnv('LEGIWATCH_TARGET_PHASE') as LegiWatchPhase9CutoverPhase,
        actor,
        confirmation: requiredEnv('LEGIWATCH_CONFIRMATION'),
      });
    } else if (command === 'capture-all') {
      result = await cutover.setCaptureAll({
        enabled: requiredEnv('LEGIWATCH_CAPTURE_ALL_ENABLED') === 'true',
        actor,
        confirmation: requiredEnv('LEGIWATCH_CONFIRMATION'),
      });
    } else {
      const evidence = jsonEnv<Record<string, unknown>>('LEGIWATCH_EVIDENCE_JSON');
      result = await cutover.recordEvidence({
        evidenceType: String(evidence.evidenceType ?? ''),
        evidenceSource: String(evidence.evidenceSource ?? ''),
        status: String(evidence.status ?? ''),
        hearingId: optionalString(evidence.hearingId),
        captureId: optionalString(evidence.captureId),
        runId: optionalString(evidence.runId),
        observedAt: optionalDate(evidence.observedAt),
        expiresAt: optionalDate(evidence.expiresAt),
        artifactUri: optionalString(evidence.artifactUri),
        details: isRecord(evidence.details) ? evidence.details : undefined,
        actor,
      });
    }
    console.log(JSON.stringify({ command, actor, result }));
  } finally {
    await app.close();
  }
}

function jsonEnv<T>(name: string): T {
  const value = requiredEnv(name);
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function evidenceSource(): LegiWatchPhase9EvidenceSource {
  return requiredEnv('LEGIWATCH_EVIDENCE_SOURCE') as LegiWatchPhase9EvidenceSource;
}

function mode(): LegiWatchPhase9Mode {
  return (process.env.LEGIWATCH_READINESS_MODE ?? 'READINESS') as LegiWatchPhase9Mode;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalDate(value: unknown): Date | undefined {
  const text = optionalString(value);
  if (!text) return undefined;
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid evidence date ${text}`);
  return date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
