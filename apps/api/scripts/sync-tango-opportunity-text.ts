/**
 * Extracted-text ingestion for archived attachments (Funding Opportunities
 * P30).
 *
 *   tsx scripts/sync-tango-opportunity-text.ts                # dry run
 *   tsx scripts/sync-tango-opportunity-text.ts --commit
 *   tsx scripts/sync-tango-opportunity-text.ts --commit --entitled
 *
 * DRY-RUN BY DEFAULT.
 *
 * ── READ THIS FIRST: the provider has no per-document text call ──────────────
 *
 * P17's capability probe already recorded the shape of this, and building
 * against it makes the limit concrete: the installed `@makegov/tango-node@1.1.0`
 * exposes extracted text through exactly ONE method,
 * `searchOpportunityAttachments({ q, topK, includeExtractedText })`.
 *
 * That is a SEMANTIC SEARCH. It takes a query and returns whichever documents
 * match it. There is no `getAttachmentText(id)` and no attachment resource to
 * fetch — so "give me the text of THIS document" is not a question this SDK can
 * ask, and no amount of wiring here changes that.
 *
 * Inventing a query to stand in for a document id would be worse than not
 * trying. A search for the solicitation number returns whatever the index
 * decides is relevant, which is not the same set as "the attachments on that
 * notice", and binding returned text to an attachment it merely resembles is
 * exactly the fuzzy-identity substitution P02 forbids for award history. The
 * binding hash on `opportunity_document_text` exists to make that impossible.
 *
 * So this script does the part that IS honestly available:
 *
 *   SEED   one `opportunity_document_text` row per archived attachment,
 *          recording the CORRECT unavailability status for the account's
 *          current entitlement — `not_entitled` when the plan does not include
 *          extracted text, `pending` when it does and nobody has run an
 *          extraction yet.
 *
 * That is not a placeholder. It is the phase's own acceptance bar: "If
 * unavailable, preserve explicit `not_entitled`, `not_provided`, `pending` or
 * `failed`; never present blank as 'no requirements'." A reader looking at a
 * solicitation now sees WHY there is no text, and an operator can tell at a
 * glance whether the gap is a purchase decision or a job that has not run.
 *
 * ── What would finish this ───────────────────────────────────────────────────
 *
 * Either the provider adds a per-document text endpoint, or Capiro adds the
 * `local_parser` extraction method — the archived bytes are already on hand
 * (P29), and `extraction_method` exists precisely so a local extraction is a
 * separately labelled row rather than a silent substitute for provider text.
 * Neither is in this phase's file list.
 *
 * ── Entitlement is an INPUT, never a guess ───────────────────────────────────
 *
 * `--entitled` states that P17's probe reported extracted text as available on
 * this account. Without it the seeded status is `not_entitled`. The script does
 * NOT call the provider to find out: a probe is P17's job, its result is an
 * operator-reviewed artefact, and re-deriving it here from a failed call would
 * turn one rate-limit into "the account lost its entitlement".
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  buildUnavailableText,
  describeTextAvailability,
  type DocumentTextRow,
} from '../src/funding-opportunities/opportunity-document-text.service.js';

dotenvConfig();

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}
function flagValue(argv: string[], name: string): string | undefined {
  const withEq = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(`--${name}=`.length);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export interface ParsedArgs {
  commit: boolean;
  /** P17's probe said extracted text IS available on this account. */
  entitled: boolean;
  limit: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const raw = flagValue(argv, 'limit');
  const parsed = raw != null ? Number(raw) : NaN;
  return {
    commit: hasFlag(argv, 'commit'),
    entitled: hasFlag(argv, 'entitled'),
    limit: Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 10_000) : 500,
  };
}

export interface ArchivedAttachment {
  id: string;
  contentSha256: string;
  fileName: string | null;
}

export interface TextSyncDeps {
  /** Archived attachments with no text row for the CURRENT bytes. */
  readUncovered: (limit: number) => Promise<ArchivedAttachment[]>;
  writeStatus: (row: DocumentTextRow) => Promise<void>;
}

export interface TextSyncSummary {
  scanned: number;
  seeded: number;
  /** The status seeded, and the human sentence a reader will see for it. */
  status: 'pending' | 'not_entitled';
  explanation: string;
}

export async function runTextSync(
  deps: TextSyncDeps,
  options: { commit: boolean; entitled: boolean; limit: number },
): Promise<TextSyncSummary> {
  const status = options.entitled ? 'pending' : 'not_entitled';
  const attachments = await deps.readUncovered(options.limit);

  let seeded = 0;
  if (options.commit) {
    for (const attachment of attachments) {
      await deps.writeStatus(
        buildUnavailableText({
          attachmentId: attachment.id,
          attachmentContentSha256: attachment.contentSha256,
          status,
        }),
      );
      seeded += 1;
    }
  }

  return {
    scanned: attachments.length,
    seeded,
    status,
    explanation: describeTextAvailability({ status }),
  };
}

// ── Real wiring ──────────────────────────────────────────────────────────────

/**
 * Archived attachments with no text row bound to their CURRENT bytes.
 *
 * The binding is the join condition, not just the attachment id. A document
 * that was reposted has a new hash, so its old text row no longer covers it and
 * it correctly reappears here — which is how a stale extraction gets replaced
 * rather than silently kept.
 *
 * tenant-scope-exempt: both tables are global federal reference data.
 */
function realReadUncovered(prisma: PrismaClient): TextSyncDeps['readUncovered'] {
  return async (limit) => {
    const rows = await prisma.$queryRaw<
      Array<{ id: string; content_sha256: string; file_name: string | null }>
    >`
      SELECT a.id::text AS id, a.content_sha256, a.file_name
      FROM opportunity_attachment a
      LEFT JOIN opportunity_document_text t
        ON t.attachment_id = a.id
       AND t.attachment_content_sha256 = a.content_sha256
      WHERE a.status = 'archived'
        AND a.content_sha256 IS NOT NULL
        AND t.id IS NULL
      ORDER BY a.archived_at ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      id: r.id,
      contentSha256: r.content_sha256,
      fileName: r.file_name,
    }));
  };
}

function realWriteStatus(prisma: PrismaClient): TextSyncDeps['writeStatus'] {
  return async (row) => {
    await prisma.opportunityDocumentText.create({
      data: {
        attachmentId: row.attachmentId,
        attachmentContentSha256: row.attachmentContentSha256,
        status: row.status,
        extractionMethod: row.extractionMethod,
        providerTier: row.providerTier,
        text: row.text,
        charCount: row.charCount,
        truncated: row.truncated,
        failureReason: row.failureReason,
        fetchedAt: row.fetchedAt,
      },
    });
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const summary = await runTextSync(
      { readUncovered: realReadUncovered(prisma), writeStatus: realWriteStatus(prisma) },
      args,
    );
    console.log(`FO_TEXT_SYNC_DONE ${JSON.stringify({ ...summary, commit: args.commit })}`);
  } finally {
    await prisma.$disconnect();
  }
}

const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /sync-tango-opportunity-text(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main().catch((error: unknown) => {
    console.error('FO_TEXT_SYNC_ERR', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { main };
