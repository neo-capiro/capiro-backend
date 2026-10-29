import { createHash } from 'node:crypto';
/** Same opaque source token at draft creation, submission and locked approval. */
export function settingsMemorySourceVersion(row: {
  id: string;
  sections: unknown;
  updatedAt: string;
}) {
  return createHash('sha256')
    .update(JSON.stringify({ id: row.id, sections: row.sections, updatedAt: row.updatedAt }))
    .digest('hex');
}
