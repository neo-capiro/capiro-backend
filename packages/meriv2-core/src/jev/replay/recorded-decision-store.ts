import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

export interface RecordingKey {
  task?: string;
  registryVersion?: string;
  questionHash?: string;
  envelopeHash: string;
  questionVersion: string;
  model: string;
  provider: string;
}

export interface RecordedDecision extends RecordingKey {
  recordedAt: string;
  request: { state: unknown; questions: Record<string, unknown> };
  response: unknown;
  latencyMs: number;
  usage?: { inputTokens: number; outputTokens: number };
}

const recordingSchema = z.object({
  task: z.string().min(1).optional(),
  registryVersion: z.string().min(1).optional(),
  questionHash: z.string().min(1).optional(),
  envelopeHash: z.string().min(1),
  questionVersion: z.string().min(1),
  model: z.string().min(1),
  provider: z.string().min(1),
  recordedAt: z.string().min(1),
  request: z.object({ state: z.unknown(), questions: z.record(z.unknown()) }).strict(),
  response: z.unknown(),
  latencyMs: z.number().nonnegative(),
  usage: z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative() }).optional(),
}).strict();

function key(value: RecordingKey): string {
  return [value.task ?? 'claim_support', value.registryVersion ?? 'legacy-registry',
    value.questionHash ?? 'legacy-question', value.envelopeHash, value.questionVersion,
    value.model, value.provider].join('\u0000');
}

function rejectSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  if (/authorization|api[-_]?key|bearer\s+[a-z0-9._-]+/i.test(text)) {
    throw new Error('recording contains forbidden credential or header material');
  }
}

export class RecordedDecisionStore {
  private readonly index = new Map<string, RecordedDecision>();

  constructor(readonly path: string) {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)) {
      const value = recordingSchema.parse(JSON.parse(line)) as RecordedDecision;
      this.index.set(key(value), value);
    }
  }

  get(recordingKey: RecordingKey): RecordedDecision | undefined {
    const exact = this.index.get(key(recordingKey));
    if (exact) return exact;
    if (recordingKey.task || recordingKey.registryVersion || recordingKey.questionHash) {
      const { task: _task, registryVersion: _registryVersion, questionHash: _questionHash, ...legacy } = recordingKey;
      return this.index.get(key(legacy));
    }
    return undefined;
  }

  append(recording: RecordedDecision): void {
    const parsed = recordingSchema.parse(recording) as RecordedDecision;
    rejectSecrets(parsed);
    mkdirSync(dirname(this.path), { recursive: true });
    const line = `${JSON.stringify(parsed)}\n`;
    if (!existsSync(this.path)) {
      const fd = openSync(this.path, 'wx');
      try { writeFileSync(fd, line); } finally { closeSync(fd); }
    } else {
      appendFileSync(this.path, line, 'utf8');
    }
    this.index.set(key(parsed), parsed);
  }
}
