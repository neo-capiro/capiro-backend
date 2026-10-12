/** @cleanup-smoke noArgsExit=0 */
/**
 * Delete tenant(s) by slug/name match. DESTRUCTIVE: a tenant delete cascades
 * to all of that tenant's data via the ON DELETE CASCADE foreign keys.
 *
 * Dry-run by default (lists matches, changes nothing). Pass --commit to delete.
 *
 *   delete-tenant "c2 strateg" "acme lobby"            # dry run
 *   delete-tenant --commit "c2 strateg" "acme lobby"   # actually delete
 *
 * Run as a one-off ECS task (entrypoint: delete-tenant). The Clerk organization
 * is NOT removed here — only the Capiro DB tenant + its data. Orphan Clerk orgs
 * can be cleaned up separately in the Clerk dashboard.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
dotenvConfig();



async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const terms = args.filter((a) => a !== '--commit').map((t) => t.trim().toLowerCase()).filter(Boolean);

  if (terms.length === 0) {
    console.log('Usage: delete-tenant [--commit] <search term> [...terms]. No search terms provided. Nothing to do.');
    return;
  }

  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/delete-tenant.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    const all = await prisma.tenant.findMany({
    select: { id: true, slug: true, name: true, clerkOrgId: true },
  });
  const matched = all.filter((t) =>
    terms.some(
      (term) => t.slug.toLowerCase().includes(term) || t.name.toLowerCase().includes(term),
    ),
  );

  console.log(`[delete-tenant] terms=${JSON.stringify(terms)} → ${matched.length} match(es):`);
  for (const t of matched) {
    console.log(`  - slug="${t.slug}" name="${t.name}" id=${t.id} clerkOrg=${t.clerkOrgId ?? 'none'}`);
  }

  if (!commit) {
    console.log('[delete-tenant] DRY RUN — pass --commit to delete. No changes made.');
    return;
  }

  let deleted = 0;
  for (const t of matched) {
    try {
      await prisma.tenant.delete({ where: { id: t.id } });
      deleted += 1;
      console.log(`[delete-tenant] DELETED slug="${t.slug}" id=${t.id} (data cascaded)`);
    } catch (e) {
      console.error(
        `[delete-tenant] FAILED slug="${t.slug}":`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  console.log(`[delete-tenant] done. Deleted ${deleted}/${matched.length}.`);

  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
