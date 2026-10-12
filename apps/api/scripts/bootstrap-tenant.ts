/**
 * Provision a new tenant via the invitation-based onboarding flow.
 *
 *   pnpm --filter @capiro/api bootstrap:tenant -- \
 *     --slug acme \
 *     --name "Acme Lobbying Group" \
 *     --admin-email admin@acme.com \
 *     [--admin-name "Jane Doe"] \
 *     [--redirect https://app.capiro.ai/sign-in]
 *
 * Steps (idempotent on slug):
 *   1. Create the Clerk Organization (no createdBy - first member is the
 *      invited admin once they accept). Reuse if a Clerk org with that slug
 *      already exists.
 *   2. Set the org's `public_metadata.capiro_tenant_id` so the JWT template
 *      embeds it on every session token.
 *   3. Upsert the `tenants` row with `clerk_org_id`.
 *   4. Send a Clerk org invitation to `admin-email` with role `admin`. Clerk
 *      handles the email send + 30-day expiration. Re-running this command
 *      with the same slug + email no-ops (the existing pending invitation is
 *      kept) unless --resend is passed.
 *
 * The invited admin clicks the email → Clerk hosted UI → sets a password →
 * accepts the org membership. Our webhook handler (apps/api/src/webhooks/...)
 * picks up `organizationMembership.created`, looks up the tenant by
 * `clerk_org_id`, and inserts a `tenant_memberships` row with role
 * `user_admin` + status `active`.
 */
import { config as dotenvConfig } from 'dotenv';
import { createClerkClient } from '@clerk/backend';
import { PrismaClient } from '@prisma/client';

dotenvConfig();

interface Args {
  slug: string;
  name: string;
  adminEmail: string;
  adminName?: string;
  redirect?: string;
  resend?: boolean;
}

function parseArgs(): Args {
  const args: Partial<Args> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--slug':
        args.slug = v?.toLowerCase();
        i++;
        break;
      case '--name':
        args.name = v;
        i++;
        break;
      case '--admin-email':
        args.adminEmail = v?.trim().toLowerCase();
        i++;
        break;
      case '--admin-name':
        args.adminName = v;
        i++;
        break;
      case '--redirect':
        args.redirect = v;
        i++;
        break;
      case '--resend':
        args.resend = true;
        break;
    }
  }
  for (const required of ['slug', 'name', 'adminEmail'] as const) {
    if (!args[required]) {
      throw new Error(`Missing --${required.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`);
    }
  }
  return args as Args;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/bootstrap-tenant.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const args = parseArgs();
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey || secretKey.startsWith('sk_test_REPLACE') || secretKey === 'REPLACE_ME') {
    throw new Error('CLERK_SECRET_KEY is not set in the environment');
  }
  const clerk = createClerkClient({ secretKey });

  // -------------------------------------------------------------- Step 1: Clerk org
  const orgList = await clerk.organizations.getOrganizationList({
    query: args.slug,
    limit: 50,
  });
  let org = orgList.data.find((o) => o.slug === args.slug);
  if (!org) {
    org = await clerk.organizations.createOrganization({
      name: args.name,
      slug: args.slug,
      // No createdBy - the first member is the admin who accepts the invite.
    });
    // eslint-disable-next-line no-console
    console.log(`Created Clerk organization ${org.id} (${org.slug})`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`Reusing existing Clerk organization ${org.id} (${org.slug})`);
  }

  // -------------------------------------------------------------- Step 2: Tenant row + metadata
  const prisma = new PrismaClient();
  let tenantId: string;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      const tenant = await tx.tenant.upsert({
        where: { slug: args.slug },
        create: {
          slug: args.slug,
          name: args.name,
          status: 'active',
          clerkOrgId: org!.id,
        },
        update: { name: args.name, status: 'active', clerkOrgId: org!.id },
      });
      tenantId = tenant.id;
    });

    await clerk.organizations.updateOrganizationMetadata(org.id, {
      publicMetadata: { capiro_tenant_id: tenantId!, capiro_tenant_slug: args.slug },
    });
  } finally {
    await prisma.$disconnect();
  }

  // -------------------------------------------------------------- Step 3: Invitation
  const existingInvites = await clerk.organizations.getOrganizationInvitationList({
    organizationId: org.id,
    status: ['pending'],
  });
  const existing = existingInvites.data.find(
    (inv) => inv.emailAddress.toLowerCase() === args.adminEmail,
  );

  let invitationId: string;
  if (existing && !args.resend) {
    // eslint-disable-next-line no-console
    console.log(
      `Pending invitation already exists for ${args.adminEmail} (${existing.id}). Pass --resend to revoke and resend.`,
    );
    invitationId = existing.id;
  } else {
    if (existing && args.resend) {
      await clerk.organizations.revokeOrganizationInvitation({
        organizationId: org.id,
        invitationId: existing.id,
        // requestingUserId is required by Clerk's API for audit purposes.
        // For our internal admin path, we don't have a Clerk user context;
        // pass the org id as a synthetic value so the call succeeds. If
        // Clerk tightens this, we'll route revocations through a dedicated
        // service account.
        requestingUserId: org.id,
      });
    }
    const invitation = await clerk.organizations.createOrganizationInvitation({
      organizationId: org.id,
      emailAddress: args.adminEmail,
      role: 'org:admin',
      redirectUrl: args.redirect ?? 'https://app.capiro.ai/sign-in',
    });
    invitationId = invitation.id;
    // eslint-disable-next-line no-console
    console.log(`Sent Clerk invitation ${invitation.id} to ${args.adminEmail}`);
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        tenant: { id: tenantId!, slug: args.slug, name: args.name, clerkOrgId: org.id },
        invitation: { id: invitationId, email: args.adminEmail, role: 'user_admin' },
        nextStep:
          'The admin will receive an email from Clerk. After accepting, our webhook will create their tenant_memberships row automatically.',
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
