/**
 * Provision the internal `capiro-internal` tenant and invite a Capiro staff
 * member as `capiro_admin`. Run once per Capiro staff member you want to
 * onboard.
 *
 *   pnpm --filter @capiro/api bootstrap:capiro-admin -- \
 *     --email neo@capiro.ai \
 *     [--name "Neo Martinez"]
 *
 * What this does:
 *   1. Ensure the Clerk org `capiro-internal` exists (creates if not).
 *   2. Ensure the matching `tenants` row exists with role markers.
 *   3. Send a Clerk org invitation to the email with role `admin`.
 *   4. The webhook handler picks up the membership-created event and inserts
 *      a `tenant_memberships` row with role `capiro_admin` (NOT `user_admin`)
 *      because the membership belongs to the capiro-internal tenant.
 *
 * The `capiro_admin` role is granted by the webhook handler when the org slug
 * matches the reserved `capiro-internal` slug. See clerk-webhook.service.ts.
 */
import { config as dotenvConfig } from 'dotenv';
import { createClerkClient } from '@clerk/backend';
import { PrismaClient } from '@prisma/client';

dotenvConfig();

const CAPIRO_INTERNAL_SLUG = 'capiro-internal';
const CAPIRO_INTERNAL_NAME = 'Capiro Internal';

interface Args {
  email: string;
  name?: string;
  resend?: boolean;
}

function parseArgs(): Args {
  const args: Partial<Args> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--email':
        args.email = v?.trim().toLowerCase();
        i++;
        break;
      case '--name':
        args.name = v;
        i++;
        break;
      case '--resend':
        args.resend = true;
        break;
    }
  }
  if (!args.email) throw new Error('Missing --email');
  return args as Args;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/bootstrap-capiro-admin.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const args = parseArgs();
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error('CLERK_SECRET_KEY is not set');
  const clerk = createClerkClient({ secretKey });

  // Step 1 - Clerk org
  const orgList = await clerk.organizations.getOrganizationList({
    query: CAPIRO_INTERNAL_SLUG,
    limit: 10,
  });
  let org = orgList.data.find((o) => o.slug === CAPIRO_INTERNAL_SLUG);
  if (!org) {
    org = await clerk.organizations.createOrganization({
      name: CAPIRO_INTERNAL_NAME,
      slug: CAPIRO_INTERNAL_SLUG,
    });
    // eslint-disable-next-line no-console
    console.log(`Created Clerk org ${org.id} (${org.slug})`);
  }

  // Step 2 - DB tenant + metadata
  const prisma = new PrismaClient();
  let tenantId: string;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      const tenant = await tx.tenant.upsert({
        where: { slug: CAPIRO_INTERNAL_SLUG },
        create: {
          slug: CAPIRO_INTERNAL_SLUG,
          name: CAPIRO_INTERNAL_NAME,
          status: 'active',
          clerkOrgId: org!.id,
        },
        update: { clerkOrgId: org!.id, status: 'active' },
      });
      tenantId = tenant.id;
    });
    await clerk.organizations.updateOrganizationMetadata(org.id, {
      publicMetadata: {
        capiro_tenant_id: tenantId!,
        capiro_tenant_slug: CAPIRO_INTERNAL_SLUG,
      },
    });
  } finally {
    await prisma.$disconnect();
  }

  // Step 3 - invitation
  const pending = await clerk.organizations.getOrganizationInvitationList({
    organizationId: org.id,
    status: ['pending'],
  });
  const existing = pending.data.find((inv) => inv.emailAddress.toLowerCase() === args.email);
  if (existing && !args.resend) {
    // eslint-disable-next-line no-console
    console.log(
      `Pending invitation already exists for ${args.email} (${existing.id}). Pass --resend to refresh.`,
    );
    return;
  }
  if (existing && args.resend) {
    await clerk.organizations.revokeOrganizationInvitation({
      organizationId: org.id,
      invitationId: existing.id,
      requestingUserId: org.id,
    });
  }
  const invitation = await clerk.organizations.createOrganizationInvitation({
    organizationId: org.id,
    emailAddress: args.email,
    role: 'org:admin',
    redirectUrl: process.env.APP_SIGN_IN_URL ?? 'https://app.capiro.ai/sign-in',
  });
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        tenant: { id: tenantId!, slug: CAPIRO_INTERNAL_SLUG, clerkOrgId: org.id },
        invitation: { id: invitation.id, email: args.email, capiroRole: 'capiro_admin' },
        nextStep:
          'Open the email from Clerk, set a password, and accept the invite. The webhook will assign capiro_admin role automatically.',
      },
      null,
      2,
    ),
  );
}

if (require.main === module) {
main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
}
