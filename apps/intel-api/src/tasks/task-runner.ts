/**
 * intel-api one-off `task <verb>` runner (Phase 1).
 *
 * Invoked by the container entrypoint's `task)` arm:
 *   node dist/tasks/task-runner.js <verb> [args...]
 * against the verb-runner task-def family (`capiro-dev-intel-api-enableflag`,
 * container `intel-api-enableflag`) via a `containerOverrides` command. It does
 * NOT boot the Nest HTTP server; it constructs a short-lived Prisma client,
 * runs one verb, and disconnects. Mirrors the inline `enable-feature` verb's
 * lifecycle (lazy connect, `$disconnect()` in `finally`, non-zero exit on error).
 *
 * Verb dispatch (`runVerb`, `verifySourcedata`, `isKnownVerb`) is exported and
 * dependency-injected so it is unit-testable without a DB or Bedrock.
 *
 * Phase 1 verb: `verify-sourcedata <billId>` — the core-enabler gate (plan §4
 * S6): read a real bill, embed it, and cosine-rank against context_embeddings.
 */

import { PrismaService } from '../prisma/prisma.service.js';
import { SourceDataRepository } from '../sourcedata/source-data.repository.js';
import { EMBEDDING_MODEL, embedText, normalize, vectorLiteral } from '../embeddings/embedder.js';

/** Candidate cosine floor for bill semantic search (ported: EMBED_CANDIDATE_FLOOR). */
export const EMBED_CANDIDATE_FLOOR = 0.3;

export const KNOWN_VERBS = ['verify-sourcedata'] as const;
export type Verb = (typeof KNOWN_VERBS)[number];

export function isKnownVerb(v: string): v is Verb {
  return (KNOWN_VERBS as readonly string[]).includes(v);
}

/** Injected dependencies — real in main(), fakes in tests. */
export interface VerbDeps {
  repo: Pick<SourceDataRepository, 'getBillById' | 'semanticBillScores'>;
  embed: (text: string) => Promise<number[]>;
  log: (msg: string) => void;
}

/**
 * `verify-sourcedata <billId>`: proves the two Phase-1 enablers end to end —
 * (1) cross-DB read of a real congress_bill, (2) Titan query embedding, and
 * (3) cosine ranking against the GLOBAL bill embeddings under the capiro_app
 * RLS role. Emits the pass signals asserted by plan §4.4; throws (→ non-zero
 * exit) on any failure or an empty result set.
 */
export async function verifySourcedata(billId: string, deps: VerbDeps): Promise<void> {
  if (!billId) throw new Error('verify-sourcedata requires a <billId> argument (e.g. 119-hr-1)');

  const bill = await deps.repo.getBillById(billId);
  if (!bill) throw new Error(`BILL_NOT_FOUND id=${billId}`);
  deps.log(`BILL_OK id=${bill.id} title="${bill.title ?? ''}"`);

  const queryText = normalize(
    [bill.title, bill.policyArea, (bill.subjects ?? []).join(', ')]
      .filter((p): p is string => Boolean(p && p.length))
      .join('\n'),
  );
  const vec = await deps.embed(queryText);
  deps.log(`EMBED_OK dim=${vec.length} model=${EMBEDDING_MODEL}`);

  const scores = await deps.repo.semanticBillScores(
    vectorLiteral(vec),
    EMBEDDING_MODEL,
    EMBED_CANDIDATE_FLOOR,
  );
  deps.log('SEMANTIC_TOP:');
  for (const s of scores.slice(0, 10)) {
    deps.log(`  ${s.sourceId}\t${s.score.toFixed(4)}`);
  }
  if (scores.length === 0) {
    throw new Error('SEMANTIC_EMPTY (0 rows >= floor) — no bill embeddings matched');
  }
}

/** Route a verb to its handler. Throws on an unknown verb (→ non-zero exit). */
export async function runVerb(verb: string, args: string[], deps: VerbDeps): Promise<void> {
  switch (verb) {
    case 'verify-sourcedata':
      return verifySourcedata(args[0] ?? '', deps);
    default:
      throw new Error(`Unknown task verb: ${verb} (known: ${KNOWN_VERBS.join(', ')})`);
  }
}

async function main(): Promise<void> {
  const [verb, ...args] = process.argv.slice(2);
  if (!verb) {
    console.error(`task <verb> [args]  (known: ${KNOWN_VERBS.join(', ')})`);
    process.exit(1);
  }

  const prisma = new PrismaService();
  const repo = new SourceDataRepository(prisma);
  try {
    await runVerb(verb, args, { repo, embed: embedText, log: (m) => console.log(m) });
  } catch (e) {
    console.error(`TASK_ERR verb=${verb}: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Auto-run only when executed directly as the container entrypoint target —
// NOT when imported by unit tests (jest is the entry, so require.main !== module).
if (require.main === module) {
  void main();
}
