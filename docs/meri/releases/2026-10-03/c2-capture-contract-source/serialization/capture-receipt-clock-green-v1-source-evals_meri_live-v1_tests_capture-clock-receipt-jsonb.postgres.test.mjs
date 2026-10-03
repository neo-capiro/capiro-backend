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

describe('clock receipt finalization on actual Prisma/PostgreSQL', { skip: !configPath }, () => {
  for (const clientId of [null, CLIENT]) {
    for (const joined of [false, true]) {
      it(`persists an authenticated ${joined ? 'joined' : 'pending'} clock receipt with ${clientId ? 'client' : 'generic'} scope`, async () => {
        await withOwnedApprovedMemory(configPath, async ({ tx, deps }) => {
          // Storage regression only: synthetic policy/clock observations, no
          // original corpus qualification, provider, production RLS or capture.
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
            'CREATE TABLE users(id uuid PRIMARY KEY, clerk_user_id text, email text, first_name text, last_name text)',
          );
          await tx.$executeRawUnsafe(
            'CREATE TABLE clio_conversations(id uuid PRIMARY KEY, tenant_id uuid, user_id uuid, client_id uuid, archived_at timestamptz, metadata_jsonb jsonb)',
          );
          await tx.$executeRawUnsafe(
            'CREATE TABLE clio_messages(id uuid PRIMARY KEY, tenant_id uuid, user_id uuid, client_id uuid, conversation_id uuid, role text, body text, nanoclaw_id text, metadata_jsonb jsonb, created_at timestamptz DEFAULT now())',
          );
          const captureBinding = {
            caseId: '01',
            captureRunId: randomUUID(),
            fixtureVersion: 'meri-live-v1-2026-09-26.1',
            physicalMapSha256: 'a'.repeat(64),
            resetReceiptId: 'owned-local-reset',
            seedReceiptId: 'owned-local-seed',
          };
          await tx.$executeRawUnsafe(
            'UPDATE tenants SET settings_jsonb=$1::jsonb WHERE id=$2::uuid',
            JSON.stringify({
              meriFoundationFixture: {
                fixtureNamespace: 'meri-foundation-20260928',
                captureEvidence: captureBinding,
              },
            }),
            TENANT,
          );
          await tx.$executeRawUnsafe("UPDATE clients SET name='Synthetic Aster'");
          await tx.$executeRawUnsafe(
            "INSERT INTO users VALUES ($1::uuid,'clerk-synthetic-clock-receipt','clock-receipt@example.com','Receipt','Synthetic')",
            PROPOSER,
          );
          const conversationId = randomUUID(),
            userMessageId = randomUUID(),
            assistantId = randomUUID();
          await tx.$executeRawUnsafe(
            "INSERT INTO clio_conversations VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,NULL,'{}'::jsonb)",
            conversationId,
            TENANT,
            PROPOSER,
            clientId,
          );
          const ctx = {
            tenantId: TENANT,
            tenantSlug: 'meri-foundation-20260928-t1',
            userId: PROPOSER,
            clerkUserId: 'clerk-synthetic-clock-receipt',
            role: 'standard_user',
          };
          const source = (name) =>
            require(
              fileURLToPath(new URL(`../../../../apps/api/src/meri/${name}.ts`, import.meta.url)),
            );
          const { issueMeriServerReadonlyCapturePolicy, finalizeMeriServerCaptureEvidence } =
            source('meri-server-readonly-capture');
          const { buildApiOnlyMeriServerCaptureEvidence, persistMeriServerCaptureEvidenceReceipt } =
            source('meri-server-capture-evidence');
          const { authorizeMeriCaptureMessageReadback } = source('meri-capture-policy-readback');
          const {
            completeMeriCaptureEvidenceReceipt,
            signMeriCaptureEvidenceReceipt,
            verifyMeriCaptureEvidenceReceipt,
            observed,
          } = require('@capiro/meriv2-core');
          const issued = await issueMeriServerReadonlyCapturePolicy({
            prisma: deps.prisma,
            ctx,
            conversationId,
          });
          const policy = {
            ...issued,
            turnId: userMessageId,
            semanticClock: {
              version: 1,
              kind: 'qualified_original_fixture_semantic_clock',
              instant: '2026-09-26T16:00:00.000Z',
              timeZone: 'America/New_York',
              caseId: captureBinding.caseId,
              captureRunId: captureBinding.captureRunId,
              currentVerifySha256: 'b'.repeat(64),
              observedAt: issued.issuedAt,
            },
          };
          const secret = 'owned-local-clock-receipt-test-secret';
          const beforeSecret = process.env.INTERNAL_SERVICE_SECRET;
          process.env.INTERNAL_SERVICE_SECRET = secret;
          try {
            const initial = buildApiOnlyMeriServerCaptureEvidence({
              policy,
              userMessageId,
              assistantMessageId: assistantId,
              citations: [],
              usage: null,
              secret,
            });
            const orchestrator = signMeriCaptureEvidenceReceipt(
              completeMeriCaptureEvidenceReceipt({
                ...initial.receipt,
                usage: {
                  ...initial.receipt.usage,
                  estimatedCostUsd: observed(0.27222999999999997),
                  costKind: 'existing_pricing_estimate',
                },
              }),
              secret,
            );
            const api = joined
              ? {
                  initial: {
                    packetId: randomUUID(),
                    persisted: true,
                    clockUse: {
                      instant: policy.semanticClock.instant,
                      timeZone: policy.semanticClock.timeZone,
                      eligibilityAt: new Date(issued.issuedAt).toISOString(),
                      scoring: 'not_run',
                    },
                  },
                  tools: [],
                  relativeToolWindows: 'NOT_APPLICABLE',
                }
              : null;
            const receipt = finalizeMeriServerCaptureEvidence({
              policy,
              orchestrator,
              userMessageId,
              assistantMessageId: assistantId,
              clockPackets: api,
              secret,
            });
            assert.equal(receipt.receipt.status, 'BLOCKED');
            if (!joined)
              assert.ok(receipt.receipt.blockers.includes('semantic_clock_api_tool_join_pending'));
            const unrelated = { text: ' keep whitespace \n Café ', entries: [false, null, 3] };
            await tx.clioMessage.create({
              data: {
                id: userMessageId,
                tenantId: TENANT,
                userId: PROPOSER,
                clientId,
                conversationId,
                role: 'user',
                body: 'Synthetic receipt serialization request',
                metadata: {},
              },
            });
            await tx.clioMessage.create({
              data: {
                id: assistantId,
                tenantId: TENANT,
                userId: PROPOSER,
                clientId,
                conversationId,
                role: 'assistant',
                body: 'Synthetic receipt serialization test',
                metadata: { unrelated },
              },
            });
            // This exercises production raw JSON-text persistence AND generated
            // Prisma readback; the pending join must remain signed and BLOCKED.
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
            const verified = verifyMeriCaptureEvidenceReceipt(
              after.metadata.serverCaptureEvidenceReceipt,
              policy,
              secret,
            );
            assert.equal(verified.usage.estimatedCostUsd.value, 0.27222999999999997);
            assert.equal(verified.status, 'BLOCKED');
            assert.equal(Object.hasOwn(verified.semanticClock, 'api'), joined);
            assert.deepEqual(verified.blockers, receipt.receipt.blockers);
            await authorizeMeriCaptureMessageReadback({
              prisma: deps.prisma,
              ctx,
              conversationId,
              message: after,
            });

            const tampered = structuredClone(receipt);
            tampered.receipt.traceId = randomUUID();
            await tx.$executeRaw`UPDATE clio_messages SET metadata_jsonb=jsonb_set(metadata_jsonb,'{serverCaptureEvidenceReceipt}',${JSON.stringify(tampered)}::jsonb) WHERE id=${assistantId}::uuid`;
            const changed = await tx.clioMessage.findFirst({ where: { id: assistantId } });
            assert.throws(
              () =>
                verifyMeriCaptureEvidenceReceipt(
                  changed.metadata.serverCaptureEvidenceReceipt,
                  policy,
                  secret,
                ),
              /authentication_failed/,
            );
            await assert.rejects(
              authorizeMeriCaptureMessageReadback({
                prisma: deps.prisma,
                ctx,
                conversationId,
                message: changed,
              }),
              { status: 403 },
            );
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
  }
});
