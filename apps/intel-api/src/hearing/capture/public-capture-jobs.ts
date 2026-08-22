import type {
  PublicCaptureWorkerCoordinator,
  PublicCaptureWorkerOutcome,
} from './public-capture.orchestrator.js';

export interface PublicCaptureQueueJobV1 {
  version: 1;
  captureId: string;
  hearingId: string;
  mustReresolve: true;
}

export interface StreamPreflightQueueJobV1 {
  version: 1;
  hearingId: string;
}

const CAPTURE_JOB_KEYS = new Set(['version', 'captureId', 'hearingId', 'mustReresolve']);
const PREFLIGHT_JOB_KEYS = new Set(['version', 'hearingId']);
const FORBIDDEN_PUBLIC_JOB_KEYS = new Set([
  'tenantId',
  'userId',
  'clientId',
  'matterId',
  'mediaUrl',
  'officialPageUrl',
  'deepgramApiKey',
  'apiKey',
  'authorization',
]);

/**
 * Parse an untrusted queue payload. Public jobs carry only canonical global ids;
 * they never carry tenant identity, credentials, an official page snapshot, or
 * a resolved media URL. The worker reloads the hearing and resolves immediately
 * before capture in its own egress environment.
 */
export function parsePublicCaptureQueueJob(value: unknown): PublicCaptureQueueJobV1 {
  const record = objectRecord(value, 'public capture job');
  rejectUnexpectedKeys(record, CAPTURE_JOB_KEYS);
  if (record.version !== 1) throw new Error('Unsupported public capture job version');
  const captureId = requiredString(record.captureId, 'captureId');
  const hearingId = requiredString(record.hearingId, 'hearingId');
  if (record.mustReresolve !== true) {
    throw new Error('Public capture jobs must require just-in-time stream resolution');
  }
  return { version: 1, captureId, hearingId, mustReresolve: true };
}

export function parseStreamPreflightQueueJob(value: unknown): StreamPreflightQueueJobV1 {
  const record = objectRecord(value, 'stream preflight job');
  rejectUnexpectedKeys(record, PREFLIGHT_JOB_KEYS);
  if (record.version !== 1) throw new Error('Unsupported stream preflight job version');
  return { version: 1, hearingId: requiredString(record.hearingId, 'hearingId') };
}

export interface PublicCaptureWorkerHandlerOptions {
  workerIdFactory?: () => string;
}

/** Queue-provider-neutral worker entry point. */
export class PublicCaptureWorkerHandler {
  private readonly workerIdFactory: () => string;

  constructor(
    private readonly coordinator: PublicCaptureWorkerCoordinator,
    options: PublicCaptureWorkerHandlerOptions = {},
  ) {
    this.workerIdFactory = options.workerIdFactory ?? defaultWorkerId;
  }

  async handle(payload: unknown): Promise<PublicCaptureWorkerOutcome> {
    const job = parsePublicCaptureQueueJob(payload);
    return this.coordinator.run({
      captureId: job.captureId,
      hearingId: job.hearingId,
      workerId: this.workerIdFactory(),
    });
  }
}

function rejectUnexpectedKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_PUBLIC_JOB_KEYS.has(key)) {
      throw new Error(`Forbidden tenant, credential, or source field in public capture job: ${key}`);
    }
    if (!allowed.has(key)) throw new Error(`Unexpected field in public capture job: ${key}`);
  }
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim().slice(0, 200);
}

function defaultWorkerId(): string {
  return `live-hearing-worker:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}
