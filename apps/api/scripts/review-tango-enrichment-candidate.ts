/**
 * Review ONE client profile enrichment candidate (Funding Opportunities P20).
 *
 *   tsx scripts/review-tango-enrichment-candidate.ts --list --tenant=<uuid>
 *   tsx scripts/review-tango-enrichment-candidate.ts --candidate=<uuid> --tenant=<uuid> --accept --reviewed-by=<userId>
 *   tsx scripts/review-tango-enrichment-candidate.ts --candidate=<uuid> --tenant=<uuid> --reject --reviewed-by=<userId> --reason="..."
 *
 * There is deliberately NO bulk/all flag anywhere in this file — this
 * phase's own acceptance bar ("no accept-all for certifications",
 * generalized to no accept-all at all — see
 * ClientProfileEnrichmentService's class doc) is enforced by this CLI
 * simply having no syntax that could express "review more than one".
 * `--candidate` is always exactly one id.
 *
 * This is an interim operator tool, not a self-serve UI — P20 ships the
 * review WORKFLOW (the durable, auditable decision record); a proper
 * reviewer-facing surface is a later phase's job.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TangoStoreService } from '../src/external/tango/tango-store.service.js';
import {
  ClientProfileEnrichmentService,
  type EnrichmentCandidateStatus,
} from '../src/funding-opportunities/client-profile-enrichment.service.js';

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

export type ParsedArgs =
  | { mode: 'list'; tenantId: string; clientId?: string; status?: EnrichmentCandidateStatus }
  | { mode: 'review'; tenantId: string; candidateId: string; status: 'accepted' | 'rejected'; reviewedBy: string; reason?: string }
  | { mode: 'error'; message: string };

export function parseArgs(argv: string[]): ParsedArgs {
  const tenantId = flagValue(argv, 'tenant');
  if (!tenantId) return { mode: 'error', message: '--tenant=<uuid> is required' };

  if (hasFlag(argv, 'list')) {
    return {
      mode: 'list',
      tenantId,
      clientId: flagValue(argv, 'client'),
      status: flagValue(argv, 'status') as EnrichmentCandidateStatus | undefined,
    };
  }

  const candidateId = flagValue(argv, 'candidate');
  if (!candidateId) return { mode: 'error', message: '--candidate=<uuid> is required (or pass --list)' };

  const accept = hasFlag(argv, 'accept');
  const reject = hasFlag(argv, 'reject');
  if (accept === reject) {
    return { mode: 'error', message: 'pass exactly one of --accept or --reject' };
  }

  const reviewedBy = flagValue(argv, 'reviewed-by');
  if (!reviewedBy) return { mode: 'error', message: '--reviewed-by=<userId> is required' };

  return {
    mode: 'review',
    tenantId,
    candidateId,
    status: accept ? 'accepted' : 'rejected',
    reviewedBy,
    reason: flagValue(argv, 'reason'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'error') {
    console.error(`TANGO_REVIEW_ERR ${args.message}`);
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const store = new TangoStoreService(prisma);
    const enrichment = new ClientProfileEnrichmentService(prisma, store);

    if (args.mode === 'list') {
      const rows = await enrichment.listCandidates(args.tenantId, { clientId: args.clientId, status: args.status });
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    const result = await enrichment.reviewCandidate(args.tenantId, args.candidateId, {
      status: args.status,
      reviewedBy: args.reviewedBy,
      rejectionReason: args.reason,
    });
    console.log(`TANGO_REVIEW_DONE ${JSON.stringify(result)}`);
  } finally {
    await prisma.$disconnect();
  }
}

const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /review-tango-enrichment-candidate(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main().catch((err) => {
    console.error('TANGO_REVIEW_ERR', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}

export { main };
