/**
 * Read-only Federal Business Profile dump (Funding Opportunities P21).
 *
 *   tsx scripts/diag-federal-business-profile.ts --tenant=<uuid> --client=<uuid>
 *
 * Prints the FULL versioned profile — first-party fields, the active Tango
 * snapshot, its complete version history, open enrichment candidates, and
 * sync status — for one client. SELECT-only: this is FederalBusinessProfile
 * Service's own `getProfile`, run from a shell; no write path exists here
 * or in the service it calls.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TangoStoreService } from '../src/external/tango/tango-store.service.js';
import { ClientProfileEnrichmentService } from '../src/funding-opportunities/client-profile-enrichment.service.js';
import { FederalBusinessProfileService } from '../src/funding-opportunities/federal-business-profile.service.js';

dotenvConfig();

function flagValue(argv: string[], name: string): string | undefined {
  const withEq = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(`--${name}=`.length);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export type ParsedArgs = { tenantId: string; clientId: string } | { error: string };

export function parseArgs(argv: string[]): ParsedArgs {
  const tenantId = flagValue(argv, 'tenant');
  const clientId = flagValue(argv, 'client');
  if (!tenantId) return { error: '--tenant=<uuid> is required' };
  if (!clientId) return { error: '--client=<uuid> is required' };
  return { tenantId, clientId };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if ('error' in args) {
    console.error(`FBP_ERR ${args.error}`);
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const store = new TangoStoreService(prisma);
    const enrichment = new ClientProfileEnrichmentService(prisma, store);
    const profiles = new FederalBusinessProfileService(prisma, store, enrichment);
    const profile = await profiles.getProfile(args.tenantId, args.clientId);
    console.log(JSON.stringify(profile, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /diag-federal-business-profile(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main().catch((err) => {
    console.error('FBP_ERR', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}

export { main };
