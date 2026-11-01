import { createHash } from 'node:crypto';
import type { PublishedRelation } from './sql-reader-connection.js';
import { SQL_QUERY_LIMITS, sqlGrammarDescriptor, type SqlSource } from './sql-statement-gate.js';

/** Canonical JSON: recursively sort object keys, preserving every array's order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Bind model guidance to the exact returned catalog subset, never to an authority/freshness token. */
export function sqlContractDescriptor(source: SqlSource, relations: readonly PublishedRelation[]) {
  const facts = {
    version: 'capiro.sql-contract/1' as const,
    source,
    grammar: sqlGrammarDescriptor(),
    limits: SQL_QUERY_LIMITS,
    columnCountLimit: null,
  };
  // Normalize to the actual JSON representation, including omission of undefined
  // optional metadata. Envelope timestamps and revisionSha256 are not digest inputs.
  const digestInput = JSON.parse(JSON.stringify({ ...facts, relations }));
  return { ...facts, revisionSha256: createHash('sha256').update(canonicalJson(digestInput), 'utf8').digest('hex') };
}
