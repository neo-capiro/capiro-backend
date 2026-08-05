#!/usr/bin/env tsx
/**
 * Seed script for Engagement Phase 0 browser acceptance fixtures.
 *
 * Creates minimum valid local data in a disposable PostgreSQL database to
 * render the current Engagement UI states:
 *   1. Meetings landing / day view
 *   2. Meeting detail
 *   3. Notes / debrief
 *   4. Outreach list
 *   5. New Outreach entry
 *   6. Outreach recipients
 *   7. Outreach context
 *   8. Outreach draft/review
 *   9. Reports
 *   10. Integrations
 *
 * All fixture names begin with "Phase 0 Engagement Baseline".
 * No real people, real emails, OAuth tokens, or private content.
 * Idempotent within the disposable database.
 *
 * Required env vars:
 *   ENGAGEMENT_PHASE0_CLERK_ORG_ID  — Clerk organization ID
 *   ENGAGEMENT_PHASE0_USER_CLERK_ID — Clerk user ID for the actor
 *   ENGAGEMENT_PHASE0_USER_EMAIL    — email of the actor
 *   ENGAGEMENT_PHASE0_FIXTURE_FILE  — path to write fixture IDs (JSON)
 */

import { writeFile } from 'node:fs/promises';
import { PrismaService } from '../src/prisma/prisma.service.js';

// Fixed UUIDs for the fixture dataset
const TENANT_ID = 'ea000000-0000-4000-8000-000000000001';
const USER_ID = 'ea000000-0000-4000-8000-000000000011';
const CLIENT_A_ID = 'ea000000-0000-4000-8000-000000000021';
const CLIENT_B_ID = 'ea000000-0000-4000-8000-000000000022';
const CONTACT_A_ID = 'ea000000-0000-4000-8000-000000000031';
const CONTACT_B_ID = 'ea000000-0000-4000-8000-000000000032';
const MEETING_PAST_ID = 'ea000000-0000-4000-8000-000000000041';
const MEETING_CURRENT_ID = 'ea000000-0000-4000-8000-000000000042';
const MEETING_FUTURE_ID = 'ea000000-0000-4000-8000-000000000043';
const OUTREACH_DRAFT_ID = 'ea000000-0000-4000-8000-000000000051';
const OUTREACH_SENT_ID = 'ea000000-0000-4000-8000-000000000052';
const AUDIENCE_LIST_ID = 'ea000000-0000-4000-8000-000000000061';
const AUDIENCE_GROUP_ID = 'ea000000-0000-4000-8000-000000000062';
const CAMPAIGN_ID = 'ea000000-0000-4000-8000-000000000071';
const TASK_ID = 'ea000000-0000-4000-8000-000000000081';
const REPORT_OFFICE_ID = 'ea000000-0000-4000-8000-000000000091';

const NOW = new Date();
const PAST = new Date(NOW.getTime() - 7 * 86400000);
const FUTURE = new Date(NOW.getTime() + 7 * 86400000);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const clerkOrgId = required('ENGAGEMENT_PHASE0_CLERK_ORG_ID');
  const clerkUserId = required('ENGAGEMENT_PHASE0_USER_CLERK_ID');
  const userEmail = required('ENGAGEMENT_PHASE0_USER_EMAIL');
  const fixtureFile = required('ENGAGEMENT_PHASE0_FIXTURE_FILE');

  const prisma = new PrismaService();
  await prisma.$connect();

  try {
    // Clean up any previous run
    await prisma.$executeRawUnsafe(`DELETE FROM engagement_campaign_recipients WHERE campaign_id = '${CAMPAIGN_ID}'::uuid`);
    await prisma.$executeRawUnsafe(`DELETE FROM engagement_campaigns WHERE id = '${CAMPAIGN_ID}'::uuid`);
    await prisma.$executeRawUnsafe(`DELETE FROM outreach_audience_members WHERE audience_id IN ('${AUDIENCE_LIST_ID}'::uuid, '${AUDIENCE_GROUP_ID}'::uuid)`);
    await prisma.$executeRawUnsafe(`DELETE FROM outreach_audiences WHERE id IN ('${AUDIENCE_LIST_ID}'::uuid, '${AUDIENCE_GROUP_ID}'::uuid)`);
    await prisma.$executeRawUnsafe(`DELETE FROM outreach_records WHERE id IN ('${OUTREACH_DRAFT_ID}'::uuid, '${OUTREACH_SENT_ID}'::uuid)`);
    await prisma.$executeRawUnsafe(`DELETE FROM engagement_tasks WHERE id = '${TASK_ID}'::uuid`);
    await prisma.$executeRawUnsafe(`DELETE FROM engagement_report_target_offices WHERE id = '${REPORT_OFFICE_ID}'::uuid`);
    await prisma.$executeRawUnsafe(`DELETE FROM meeting_attendees WHERE meeting_id IN ('${MEETING_PAST_ID}'::uuid, '${MEETING_CURRENT_ID}'::uuid, '${MEETING_FUTURE_ID}'::uuid)`);
    await prisma.$executeRawUnsafe(`DELETE FROM meetings WHERE id IN ('${MEETING_PAST_ID}'::uuid, '${MEETING_CURRENT_ID}'::uuid, '${MEETING_FUTURE_ID}'::uuid)`);
    await prisma.$executeRawUnsafe(`DELETE FROM engagement_contacts WHERE id IN ('${CONTACT_A_ID}'::uuid, '${CONTACT_B_ID}'::uuid)`);
    await prisma.$executeRawUnsafe(`DELETE FROM clients WHERE id IN ('${CLIENT_A_ID}'::uuid, '${CLIENT_B_ID}'::uuid)`);
    await prisma.$executeRawUnsafe(`DELETE FROM tenant_memberships WHERE user_id = '${USER_ID}'::uuid AND tenant_id = '${TENANT_ID}'::uuid`);
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE id = '${USER_ID}'::uuid`);
    await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = '${TENANT_ID}'::uuid`);

    // Tenant
    await prisma.$executeRawUnsafe(`
      INSERT INTO tenants (id, slug, name, status, clerk_org_id, created_at, updated_at)
      VALUES ('${TENANT_ID}'::uuid, 'phase0-engagement-baseline', 'Phase 0 Engagement Baseline', 'active', '${clerkOrgId}', now(), now())
    `);

    // User + membership
    await prisma.$executeRawUnsafe(`
      INSERT INTO users (id, email, clerk_user_id, created_at, updated_at)
      VALUES ('${USER_ID}'::uuid, '${userEmail}', '${clerkUserId}', now(), now())
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO tenant_memberships (tenant_id, user_id, role, status, created_at, updated_at)
      VALUES ('${TENANT_ID}'::uuid, '${USER_ID}'::uuid, 'user_admin', 'active', now(), now())
    `);

    // Clients
    await prisma.$executeRawUnsafe(`
      INSERT INTO clients (id, tenant_id, name, created_at, updated_at)
      VALUES
        ('${CLIENT_A_ID}'::uuid, '${TENANT_ID}'::uuid, 'Phase 0 — Acme Corp', now(), now()),
        ('${CLIENT_B_ID}'::uuid, '${TENANT_ID}'::uuid, 'Phase 0 — Beta Industries', now(), now())
    `);

    // Contacts
        await prisma.$executeRawUnsafe(`
          INSERT INTO engagement_contacts (id, tenant_id, full_name, email, created_at, updated_at)
          VALUES
            ('${CONTACT_A_ID}'::uuid, '${TENANT_ID}'::uuid, 'Jane Smith', 'jane.smith@example.gov', now(), now()),
            ('${CONTACT_B_ID}'::uuid, '${TENANT_ID}'::uuid, 'John Doe', 'john.doe@example.gov', now(), now())
        `);

        // Meetings (past, current window, future)
        await prisma.$executeRawUnsafe(`
          INSERT INTO meetings (id, tenant_id, client_id, subject, starts_at, ends_at, status, visibility, created_by_user_id, created_at, updated_at)
          VALUES
            ('${MEETING_PAST_ID}'::uuid, '${TENANT_ID}'::uuid, '${CLIENT_A_ID}'::uuid,
             'Phase 0 — Past Strategy Review',
             '${PAST.toISOString()}', '${new Date(PAST.getTime() + 3600000).toISOString()}',
             'scheduled', 'private', '${USER_ID}'::uuid, now(), now()),
            ('${MEETING_CURRENT_ID}'::uuid, '${TENANT_ID}'::uuid, '${CLIENT_A_ID}'::uuid,
             'Phase 0 — Current Policy Briefing',
             '${NOW.toISOString()}', '${new Date(NOW.getTime() + 3600000).toISOString()}',
             'scheduled', 'private', '${USER_ID}'::uuid, now(), now()),
            ('${MEETING_FUTURE_ID}'::uuid, '${TENANT_ID}'::uuid, '${CLIENT_B_ID}'::uuid,
             'Phase 0 — Future Appropriations Prep',
             '${FUTURE.toISOString()}', '${new Date(FUTURE.getTime() + 7200000).toISOString()}',
             'scheduled', 'private', '${USER_ID}'::uuid, now(), now())
        `);

        // Attendees
        await prisma.$executeRawUnsafe(`
          INSERT INTO meeting_attendees (id, tenant_id, meeting_id, contact_id, email, name, created_at)
          VALUES
            (gen_random_uuid(), '${TENANT_ID}'::uuid, '${MEETING_PAST_ID}'::uuid, '${CONTACT_A_ID}'::uuid, 'jane.smith@example.gov', 'Jane Smith', now()),
            (gen_random_uuid(), '${TENANT_ID}'::uuid, '${MEETING_CURRENT_ID}'::uuid, '${CONTACT_B_ID}'::uuid, 'john.doe@example.gov', 'John Doe', now())
        `);

        // Outreach records (type is required)
        await prisma.$executeRawUnsafe(`
          INSERT INTO outreach_records (id, tenant_id, client_id, type, status, title, subject, created_by_user_id, created_at, updated_at)
          VALUES
            ('${OUTREACH_DRAFT_ID}'::uuid, '${TENANT_ID}'::uuid, '${CLIENT_A_ID}'::uuid,
             'email', 'draft', 'Phase 0 — Draft Outreach', 'Phase 0 — Draft Outreach', '${USER_ID}'::uuid, now(), now()),
            ('${OUTREACH_SENT_ID}'::uuid, '${TENANT_ID}'::uuid, '${CLIENT_A_ID}'::uuid,
             'email', 'sent', 'Phase 0 — Sent Outreach', 'Phase 0 — Sent Outreach', '${USER_ID}'::uuid, now(), now())
        `);

        // Audiences
        await prisma.$executeRawUnsafe(`
          INSERT INTO outreach_audiences (id, tenant_id, name, kind, created_by_user_id, created_at, updated_at)
          VALUES
            ('${AUDIENCE_LIST_ID}'::uuid, '${TENANT_ID}'::uuid, 'Phase 0 — House Armed Services List', 'list', '${USER_ID}'::uuid, now(), now()),
            ('${AUDIENCE_GROUP_ID}'::uuid, '${TENANT_ID}'::uuid, 'Phase 0 — Appropriations Group', 'group', '${USER_ID}'::uuid, now(), now())
        `);

        // Campaign
        await prisma.$executeRawUnsafe(`
          INSERT INTO engagement_campaigns (id, tenant_id, name, status, created_by_user_id, created_at, updated_at)
          VALUES ('${CAMPAIGN_ID}'::uuid, '${TENANT_ID}'::uuid, 'Phase 0 — Q3 Outreach Campaign', 'draft', '${USER_ID}'::uuid, now(), now())
        `);

        // Task (status enum: todo|in_progress|done|blocked|canceled)
        await prisma.$executeRawUnsafe(`
          INSERT INTO engagement_tasks (id, tenant_id, title, status, created_by_user_id, created_at, updated_at)
          VALUES ('${TASK_ID}'::uuid, '${TENANT_ID}'::uuid, 'Phase 0 — Follow up with committee staff', 'todo', '${USER_ID}'::uuid, now(), now())
        `);

        // Report target office (scope_key/office_key/member_principal required)
        await prisma.$executeRawUnsafe(`
          INSERT INTO engagement_report_target_offices (
            id, tenant_id, client_id, scope_key, office_key, member_principal, committee, created_by_user_id, created_at, updated_at
          )
          VALUES (
            '${REPORT_OFFICE_ID}'::uuid,
            '${TENANT_ID}'::uuid,
            '${CLIENT_A_ID}'::uuid,
            'phase0-baseline',
            'hasc-majority',
            'Phase 0 Member',
            'House Armed Services Committee',
            '${USER_ID}'::uuid,
            now(),
            now()
          )
        `);

    // Write fixture IDs for the acceptance script
    const fixtures = {
      tenantId: TENANT_ID,
      userId: USER_ID,
      clientIds: [CLIENT_A_ID, CLIENT_B_ID],
      contactIds: [CONTACT_A_ID, CONTACT_B_ID],
      meetingIds: { past: MEETING_PAST_ID, current: MEETING_CURRENT_ID, future: MEETING_FUTURE_ID },
      outreachIds: { draft: OUTREACH_DRAFT_ID, sent: OUTREACH_SENT_ID },
      audienceIds: { list: AUDIENCE_LIST_ID, group: AUDIENCE_GROUP_ID },
      campaignId: CAMPAIGN_ID,
      taskId: TASK_ID,
      reportOfficeId: REPORT_OFFICE_ID,
    };

    await writeFile(fixtureFile, JSON.stringify(fixtures, null, 2) + '\n');
    console.log(`Seeded ${Object.keys(fixtures).length} fixture groups to ${fixtureFile}`);

  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Seed failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
