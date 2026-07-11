/**
 * Flip a per-tenant rollout feature flag in tenants.settings_jsonb.clioFeatureFlags.
 *
 * The general-purpose CLI equivalent of capiro-admin's setMeriV2Flag, for the
 * flags that have NO admin endpoint yet (meetingsV2, meriDockUndockUi,
 * notetaker, outreachAsync, meetingsCrossUser) and are documented as
 * "flipped via settings_jsonb.clioFeatureFlags" in tenant-flags.ts. Runs as a
 * one-off ECS task (entrypoint verb `set-tenant-flag`).
 *
 * Non-destructive: merges the single flag into the existing clioFeatureFlags
 * object, preserving all other settings + flags (mirrors setMeriV2Flag). The
 * flag name is validated against the known flag constants so a typo can't
 * write a junk flag that silently never reads back. Wrapped in a bypass_rls
 * transaction (plain-PrismaClient-script equivalent of withSystem, the
 * emit-state-changes / sync-congress precedent) since the tenants table is
 * RLS-scoped.
 *
 *   set-tenant-flag --slug capiro-internal --flag meriDockUndockUi.enabled --value true
 *   set-tenant-flag --tenant-id <uuid>     --flag meetingsV2.enabled       --value false
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  MERIV2_FLAGS,
  NOTETAKER_FLAG,
  MEETINGS_V2_FLAG,
  MERI_DOCK_UNDOCK_UI_FLAG,
  MEETINGS_CROSS_USER_FLAG,
  OUTREACH_ASYNC_FLAG,
} from '../src/common/tenant-flags.js';
dotenvConfig();

/** Every flag key the app actually reads from clioFeatureFlags. Guards typos. */
const KNOWN_FLAGS = new Set<string>([
  ...Object.values(MERIV2_FLAGS),
  NOTETAKER_FLAG,
  MEETINGS_V2_FLAG,
  MERI_DOCK_UNDOCK_UI_FLAG,
  MEETINGS_CROSS_USER_FLAG,
  OUTREACH_ASYNC_FLAG,
]);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const slug = arg('slug');
  const tenantId = arg('tenant-id');
  const flag = arg('flag');
  const valueRaw = arg('value');

  if ((!slug && !tenantId) || !flag || valueRaw == null) {
    throw new Error(
      'usage: set-tenant-flag (--slug <slug> | --tenant-id <uuid>) --flag <key> --value <true|false>',
    );
  }
  if (!KNOWN_FLAGS.has(flag)) {
    throw new Error(`unknown flag '${flag}'. known: ${[...KNOWN_FLAGS].sort().join(', ')}`);
  }
  if (valueRaw !== 'true' && valueRaw !== 'false') {
    throw new Error(`--value must be 'true' or 'false' (got '${valueRaw}')`);
  }
  const value = valueRaw === 'true';

  const prisma = new PrismaClient();
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.bypass_rls', 'on', true)");
      const tenant = slug
        ? await tx.tenant.findUnique({ where: { slug }, select: { id: true, slug: true, settings: true } })
        : await tx.tenant.findUnique({
            where: { id: tenantId as string },
            select: { id: true, slug: true, settings: true },
          });
      if (!tenant) throw new Error(`tenant not found (${slug ?? tenantId})`);

      const settings = (tenant.settings ?? {}) as Record<string, unknown>;
      const clioFeatureFlags = {
        ...((settings.clioFeatureFlags ?? {}) as Record<string, unknown>),
        [flag]: value,
      };
      await tx.tenant.update({
        where: { id: tenant.id },
        data: { settings: { ...settings, clioFeatureFlags } as unknown as Prisma.InputJsonValue },
      });
      return { slug: tenant.slug, id: tenant.id, clioFeatureFlags };
    });

    console.log(
      `[set-tenant-flag] tenant=${result.slug} (${result.id}) ${flag}=${value} — clioFeatureFlags now ${JSON.stringify(result.clioFeatureFlags)}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
