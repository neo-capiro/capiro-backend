import { PayloadTooLargeException } from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { Writable, type Readable, pipeline } from 'node:stream';
import {
  PLANNER_ATTACHMENT_LIMIT,
  plannerAttachmentName,
  type PlannerFormUpload,
} from './planner-files.js';
import { fail, keys, object } from './planner.validation.js';
import { plannerVisibleFormQuestions, type PlannerFormData } from '@capiro/strategy-verifier';

/** Bound aggregate memory as bytes arrive, including hidden/invalid files. */
export function plannerFormMemoryStorage() {
  const totals = new WeakMap<object, number>();
  return {
    _handleFile(
      request: object,
      file: { stream: Readable },
      done: (error: Error | null, info?: { buffer: Buffer; size: number }) => void,
    ) {
      const chunks: Buffer[] = [];
      let size = 0;
      const sink = new Writable({
        write(chunk: Buffer, _encoding, next) {
          const total = (totals.get(request) ?? 0) + chunk.length;
          totals.set(request, total);
          if (total > PLANNER_ATTACHMENT_LIMIT)
            return next(new PayloadTooLargeException('Form attachments must total 25 MB or less'));
          chunks.push(chunk);
          size += chunk.length;
          next();
        },
      });
      pipeline(file.stream, sink, (error) => {
        if (error) {
          chunks.length = 0;
          done(error);
        } else done(null, { buffer: Buffer.concat(chunks, size), size });
      });
    },
    _removeFile(_request: object, file: { buffer?: Buffer }, done: (error: Error | null) => void) {
      delete file.buffer;
      done(null);
    },
  };
}
export const PlannerFormUploadInterceptor = AnyFilesInterceptor({
  storage: plannerFormMemoryStorage(),
  limits: {
    files: 10,
    fields: 1,
    parts: 11,
    fieldSize: 250_000,
    fileSize: PLANNER_ATTACHMENT_LIMIT,
  },
});

export function plannerFormAnswers(raw: unknown): Record<string, unknown> {
  const data = object(raw);
  if (typeof data.answers !== 'string') return data;
  keys(data, ['answers']);
  try {
    return object(JSON.parse(data.answers));
  } catch {
    fail('Invalid form answers');
  }
}
export function plannerFormFiles(
  config: PlannerFormData,
  answers: Record<string, unknown>,
  files: PlannerFormUpload[],
) {
  if (
    files.length > 10 ||
    files.reduce((total, file) => total + file.size, 0) > PLANNER_ATTACHMENT_LIMIT
  )
    fail('Forms accept up to ten files totaling 25 MB');
  const visible = new Set(
    plannerVisibleFormQuestions(config.fields, answers).map((field) => field.id),
  );
  return files.filter((file) => {
    const question = config.fields.find((field) => field.id === file.fieldname);
    if (!question || question.type !== 'attachment') fail('Unknown attachment question');
    if (!Buffer.isBuffer(file.buffer) || file.size <= 0 || file.size !== file.buffer.length)
      fail('Choose a nonempty attachment');
    plannerAttachmentName(file.originalname);
    return visible.has(question.id);
  });
}
