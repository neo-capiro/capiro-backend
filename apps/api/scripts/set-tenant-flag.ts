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
 *
 * `tenants` carries FORCE ROW LEVEL SECURITY (policy `tenants_isolation`:
 * visible only when `id = current_tenant_id()` OR `app.bypass_rls` is on —
 * see the init_identity_tenancy migration). A bare `PrismaClient` query sets
 * neither GUC, so it saw ZERO rows here — every real tenant misreported as
 * "No tenant with slug ..." regardless of the slug (caught 2026-08-17 running
 * this against capiro-dev for a slug that in fact exists, cross-checked via
 * diag-tenant-config.ts's read-only dump). The read AND the write now run
 * inside ONE transaction with `app.bypass_rls` set, mirroring
 * diag-tenant-config.ts / PrismaService.withSystem. `set_config(..., true)`
 * scopes the bypass to this transaction only — it never leaks past it.
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

  await prisma.$transaction(async (tx) => {
    // tenants is FORCE RLS-protected — see header comment. Scoped to this
    // transaction only (set_config's third arg = true), same as
    // diag-tenant-config.ts / PrismaService.withSystem.
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;

    const tenant = await tx.tenant.findFirst({
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
    await tx.tenant.update({
      where: { id: tenant.id },
      data: { settings: { ...settings, clioFeatureFlags } as unknown as Prisma.InputJsonValue },
    });
    // eslint-disable-next-line no-console
    console.log('COMMITTED.');
  });
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
