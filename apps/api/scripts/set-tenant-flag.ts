/**
 * Set (or clear) a per-tenant feature flag under
 * tenants.settings_jsonb.clioFeatureFlags — the generic counterpart to
 * capiro-admin's MeriV2-only setMeriV2Flag, for canarying flags that have no
 * dedicated admin surface (e.g. outreachClientProfile.enabled, notetaker.enabled).
 *
 *   pnpm --filter @capiro/api set:tenant-flag -- \
 *     --slug capiro-internal --flag outreachClientProfile.enabled --value true
 *   (dry-run by default; add --commit to persist)
 *
 * SAFE: dry-run unless --commit; spread-merges so other flags/settings are
 * untouched (mirrors capiro-admin.setMeriV2Flag); prints before/after. Exits
 * non-zero on error / unknown slug. Run as a one-off ECS task against the
 * deployed image (TMPDIR=/dev/shm on the server — see infra_tsx_tmpdir_bug).
 */
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const p = `--${name}`;
  const i = process.argv.indexOf(p);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const kv = process.argv.find((a) => a.startsWith(`${p}=`));
  return kv ? kv.slice(p.length + 1) : undefined;
}

async function main(): Promise<void> {
  const slug = arg('slug');
  const flag = arg('flag');
  const valueRaw = arg('value');
  const commit = process.argv.includes('--commit');
  if (!slug || !flag || valueRaw == null || (valueRaw !== 'true' && valueRaw !== 'false')) {
    throw new Error(
      'Usage: --slug <tenant-slug> --flag <flag.key> --value <true|false> [--commit]',
    );
  }
  const value = valueRaw === 'true';

  const tenant = await prisma.tenant.findFirst({
    where: { slug },
    select: { id: true, slug: true, settings: true },
  });
  if (!tenant) throw new Error(`No tenant with slug "${slug}"`);

  const settings = (tenant.settings ?? {}) as Record<string, unknown>;
  const current = (settings.clioFeatureFlags ?? {}) as Record<string, unknown>;
  // eslint-disable-next-line no-console
  console.log(
    `tenant ${tenant.slug} (${tenant.id})\n` +
      `  current ${flag} = ${JSON.stringify(current[flag])}\n` +
      `  ->      ${flag} = ${value}`,
  );

  if (!commit) {
    // eslint-disable-next-line no-console
    console.log('DRY RUN — pass --commit to persist.');
    return;
  }

  const clioFeatureFlags = { ...current, [flag]: value };
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: { settings: { ...settings, clioFeatureFlags } as unknown as Prisma.InputJsonValue },
  });
  // eslint-disable-next-line no-console
  console.log('COMMITTED.');
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
