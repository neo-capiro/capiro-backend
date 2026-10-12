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
import {
  decodeExpectedState,
  FOUNDATION_APPLY_CONFIRMATION,
  FOUNDATION_ROLLBACK_CONFIRMATION,
  runFoundationFullchat,
  type FoundationDatabase,
  type FoundationMode,
} from './set-tenant-flag-foundation.js';

function arg(name: string): string | undefined {
  const p = `--${name}`;
  const i = process.argv.indexOf(p);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const kv = process.argv.find((a) => a.startsWith(`${p}=`));
  return kv ? kv.slice(p.length + 1) : undefined;
}

function genericArguments() {
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
  return { slug, flag, value, commit };
}

async function runGeneric(
  prisma: PrismaClient,
  { slug, flag, value, commit }: ReturnType<typeof genericArguments>,
): Promise<void> {
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

function foundationArguments(): {
  mode: FoundationMode;
  expectedState: string;
} {
  const values = new Map<string, string>();
  let markerCount = 0;
  const tokens = process.argv.slice(2);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--foundation-fullchat') {
      markerCount += 1;
      continue;
    }
    const equal = token.indexOf('=');
    const name = equal < 0 ? token : token.slice(0, equal);
    if (!['--mode', '--confirmation', '--expected-state'].includes(name)) {
      throw new Error(`Unsupported fixed foundation option: ${token}`);
    }
    if (values.has(name)) throw new Error(`Duplicate fixed foundation option: ${name}`);
    const value = equal < 0 ? tokens[++index] : token.slice(equal + 1);
    if (!value || value.startsWith('--')) {
      throw new Error(`Fixed foundation option ${name} requires one value`);
    }
    values.set(name, value);
  }
  if (markerCount !== 1) throw new Error('Fixed foundation marker must appear exactly once');
  const mode = (values.get('--mode') ?? 'plan') as FoundationMode;
  if (!['plan', 'apply', 'rollback'].includes(mode)) {
    throw new Error('Fixed foundation mode must be plan, apply, or rollback');
  }
  const confirmation = values.get('--confirmation') ?? '';
  const expectedState = values.get('--expected-state') ?? '';
  if (mode === 'plan') {
    if (confirmation || expectedState) {
      throw new Error('Fixed foundation plan does not accept confirmation or expected state');
    }
  } else {
    const required =
      mode === 'apply' ? FOUNDATION_APPLY_CONFIRMATION : FOUNDATION_ROLLBACK_CONFIRMATION;
    if (confirmation !== required) {
      throw new Error(`Fixed foundation ${mode} requires its exact confirmation`);
    }
    if (!expectedState) {
      throw new Error(`Fixed foundation ${mode} requires receipt-bound expected state`);
    }
  }
  return { mode, expectedState };
}

async function runFoundation(
  prisma: PrismaClient,
  mode: FoundationMode,
  states: ReturnType<typeof decodeExpectedState> | undefined,
): Promise<void> {
  const receipt = await runFoundationFullchat(
    prisma as unknown as FoundationDatabase,
    mode,
    states,
  );
  // One bounded machine-readable line is the only foundation-mode output. It
  // contains tenant identity plus this flag's presence/value, never settings.
  // eslint-disable-next-line no-console
  console.log(`MERI_FOUNDATION_FULLCHAT_RESULT=${JSON.stringify(receipt)}`);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/set-tenant-flag.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const options = process.argv.includes('--foundation-fullchat')
    ? { kind: 'foundation' as const, ...foundationArguments() }
    : { kind: 'generic' as const, ...genericArguments() };
  const states =
    options.kind === 'foundation' && options.mode !== 'plan'
      ? decodeExpectedState(options.expectedState)
      : undefined;
  const prisma = new PrismaClient();
  try {
    if (options.kind === 'foundation') {
      await runFoundation(prisma, options.mode, states);
      return;
    }
    await runGeneric(prisma, options);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(
      process.argv.includes('--foundation-fullchat')
        ? `Fixed foundation flag operation refused: ${err instanceof Error ? err.message : 'unexpected failure'}`
        : err,
    );
    process.exit(1);
  });
}
