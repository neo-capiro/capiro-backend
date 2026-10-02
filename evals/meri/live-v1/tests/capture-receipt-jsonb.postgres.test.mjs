import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  withOwnedApprovedMemory,
  TENANT,
  PROPOSER,
  CLIENT,
} from './approved-memory-postgres-harness.mjs';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const configPath = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;

describe('signed capture JSON on actual Prisma/PostgreSQL', { skip: !configPath }, () => {
  for (const clientId of [null, CLIENT]) {
    it(`preserves signed floating-point values and authority with ${clientId ? 'client' : 'generic'} scope`, async () => {
      await withOwnedApprovedMemory(configPath, async ({ tx, deps }) => {
        // All DDL and rows live inside the harness's random rollback-only schema.
        await tx.$executeRawUnsafe('ALTER TABLE tenants ADD COLUMN settings_jsonb jsonb');
        await tx.$executeRawUnsafe('ALTER TABLE clients ADD COLUMN name text');
        await tx.$executeRawUnsafe(
          "CREATE TYPE membership_status AS ENUM ('invited','active','removed')",
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE tenant_memberships ALTER COLUMN status TYPE membership_status USING status::membership_status',
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE client_memory_access ADD COLUMN id uuid DEFAULT gen_random_uuid()',
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE tenant_memberships ADD COLUMN id uuid DEFAULT gen_random_uuid()',
        );
        await tx.$executeRawUnsafe(
          `CREATE TABLE users(id uuid PRIMARY KEY, clerk_user_id text, email text, first_name text, last_name text)`,
        );
        await tx.$executeRawUnsafe(
          `CREATE TABLE clio_conversations(id uuid PRIMARY KEY, tenant_id uuid, user_id uuid, client_id uuid, archived_at timestamptz)`,
        );
        await tx.$executeRawUnsafe(
          `CREATE TABLE clio_messages(id uuid PRIMARY KEY, tenant_id uuid, user_id uuid, client_id uuid, conversation_id uuid, role text, body text, nanoclaw_id text, metadata_jsonb jsonb, created_at timestamptz DEFAULT now())`,
        );
        const fixture = { meriFoundationFixture: { fixtureNamespace: 'meri-foundation-20260928' } };
        await tx.$executeRawUnsafe(
          'UPDATE tenants SET settings_jsonb=$1::jsonb WHERE id=$2::uuid',
          JSON.stringify(fixture),
          TENANT,
        );
        await tx.$executeRawUnsafe("UPDATE clients SET name='Synthetic Aster'");
        await tx.$executeRawUnsafe(
          "INSERT INTO users VALUES ($1::uuid,'clerk-synthetic-receipt','receipt@example.com','Receipt','Synthetic')",
          PROPOSER,
        );
        const conversationId = randomUUID(),
          userId = randomUUID(),
          assistantId = randomUUID();
        await tx.$executeRawUnsafe(
          'INSERT INTO clio_conversations VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,NULL)',
          conversationId,
          TENANT,
          PROPOSER,
          clientId,
        );
        const ctx = {
          tenantId: TENANT,
          tenantSlug: 'meri-foundation-20260928-t1',
          userId: PROPOSER,
          clerkUserId: 'clerk-synthetic-receipt',
          role: 'standard_user',
        };
        const source = (name) =>
          require(
            fileURLToPath(new URL(`../../../../apps/api/src/meri/${name}.ts`, import.meta.url)),
          );
        const { issueMeriServerReadonlyCapturePolicy } = source('meri-server-readonly-capture');
        const { buildApiOnlyMeriServerCaptureEvidence, persistMeriServerCaptureEvidenceReceipt } =
          source('meri-server-capture-evidence');
        const { authorizeMeriCaptureMessageReadback } = source('meri-capture-policy-readback');
        const {
          signMeriCaptureEvidenceReceipt,
          verifyMeriCaptureEvidenceReceipt,
          observed,
        } = require('@capiro/meriv2-core');
        const policy = {
          ...(await issueMeriServerReadonlyCapturePolicy({
            prisma: deps.prisma,
            ctx,
            conversationId,
          })),
          turnId: userId,
        };
        const secret = 'owned-local-receipt-test-secret';
        const beforeSecret = process.env.INTERNAL_SERVICE_SECRET;
        process.env.INTERNAL_SERVICE_SECRET = secret;
        try {
          const initial = buildApiOnlyMeriServerCaptureEvidence({
            policy,
            userMessageId: userId,
            assistantMessageId: assistantId,
            citations: [],
            usage: { inputTokens: 27173, outputTokens: 10 },
            secret,
          });
          const cost = (27173 / 1_000_000) * 10 + (10 / 1_000_000) * 50;
          assert.equal(cost, 0.27222999999999997);
          const receipt = signMeriCaptureEvidenceReceipt(
            {
              ...initial.receipt,
              usage: {
                ...initial.receipt.usage,
                estimatedCostUsd: observed(cost),
                costKind: 'existing_pricing_estimate',
              },
            },
            secret,
          );
          const unrelated = { text: ' keep whitespace \n Café ', entries: [false, null, 3] };
          const data = {
            tenantId: TENANT,
            userId: PROPOSER,
            clientId,
            conversationId,
            body: 'Synthetic receipt test',
          };
          await tx.clioMessage.create({
            data: { ...data, id: userId, role: 'user', metadata: {} },
            select: { id: true },
          });
          await tx.clioMessage.create({
            data: {
              ...data,
              id: assistantId,
              role: 'assistant',
              metadata: { unrelated, serverCaptureEvidenceReceipt: receipt },
            },
            select: { id: true },
          });
          const before = await tx.clioMessage.findFirst({
            where: { id: assistantId },
            select: { metadata: true },
          });
          // Demonstrates the former production failure, rather than a fake JSON roundtrip.
          assert.notDeepEqual(before.metadata.serverCaptureEvidenceReceipt, receipt);
          assert.throws(
            () =>
              verifyMeriCaptureEvidenceReceipt(
                before.metadata.serverCaptureEvidenceReceipt,
                policy,
                secret,
              ),
            /authentication_failed/,
          );

          await persistMeriServerCaptureEvidenceReceipt({
            prisma: deps.prisma,
            ctx,
            policy,
            assistantMessageId: assistantId,
            receipt,
          });
          const after = await tx.clioMessage.findFirst({ where: { id: assistantId } });
          assert.deepEqual(after.metadata.serverCaptureEvidenceReceipt, receipt);
          assert.deepEqual(after.metadata.serverReadonlyCapturePolicy, policy);
          assert.deepEqual(after.metadata.unrelated, unrelated);
          assert.equal(
            verifyMeriCaptureEvidenceReceipt(
              after.metadata.serverCaptureEvidenceReceipt,
              policy,
              secret,
            ).usage.estimatedCostUsd.value,
            cost,
          );
          await authorizeMeriCaptureMessageReadback({
            prisma: deps.prisma,
            ctx,
            conversationId,
            message: after,
          });

          const foreignId = randomUUID();
          await tx.clioMessage.create({
            data: {
              ...data,
              id: foreignId,
              userId: randomUUID(),
              role: 'assistant',
              metadata: { untouched: true },
            },
            select: { id: true },
          });
          await assert.rejects(
            persistMeriServerCaptureEvidenceReceipt({
              prisma: deps.prisma,
              ctx,
              policy,
              assistantMessageId: foreignId,
              receipt,
            }),
            /assistant_message_readback_missing/,
          );
          assert.deepEqual(
            (
              await tx.clioMessage.findFirst({
                where: { id: foreignId },
                select: { metadata: true },
              })
            ).metadata,
            { untouched: true },
          );
          // Current membership still gates persisted receipt reads; storage does not weaken it.
          await tx.$executeRawUnsafe(
            "UPDATE tenant_memberships SET status='removed' WHERE user_id=$1::uuid",
            PROPOSER,
          );
          await assert.rejects(
            authorizeMeriCaptureMessageReadback({
              prisma: deps.prisma,
              ctx,
              conversationId,
              message: after,
            }),
            { status: 403 },
          );
        } finally {
          if (beforeSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
          else process.env.INTERNAL_SERVICE_SECRET = beforeSecret;
        }
      });
    });
  }
});
