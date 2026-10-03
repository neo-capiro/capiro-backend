import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  withOwnedApprovedMemory,
  TENANT,
  PROPOSER,
  REVIEWER,
} from './approved-memory-postgres-harness.mjs';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const configPath = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;

// Exact ContextPacket scalar columns/types/defaults from schema.prisma. All DDL,
// triggers and rows are inside the harness's random rollback-only schema. This
// exercises generated Prisma and the production adapter, not production RLS or
// fixture qualification/issuance. The clock below is an internal test input.
const packetTable = `CREATE TABLE context_packet (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, surface varchar(24) NOT NULL,
  user_id uuid, client_id uuid, ref_jsonb jsonb NOT NULL DEFAULT '{}',
  items_jsonb jsonb NOT NULL DEFAULT '[]', exclusions_jsonb jsonb NOT NULL DEFAULT '[]',
  item_count int NOT NULL DEFAULT 0, exclusion_count int NOT NULL DEFAULT 0,
  block_chars int NOT NULL DEFAULT 0, created_at timestamptz(6) NOT NULL DEFAULT now(),
  packet_version int NOT NULL DEFAULT 2, directives_jsonb jsonb NOT NULL DEFAULT '[]',
  evidence_jsonb jsonb NOT NULL DEFAULT '[]', source_failures_jsonb jsonb NOT NULL DEFAULT '[]',
  policy_jsonb jsonb NOT NULL DEFAULT '{}', model_policy_jsonb jsonb NOT NULL DEFAULT '{}',
  packet_hash varchar(80), critical_failure_count int NOT NULL DEFAULT 0,
  freshest_source_at timestamptz(6), stalest_source_at timestamptz(6),
  effective_tenant_id uuid NOT NULL, actor_user_id uuid, trace_id varchar(160),
  prompt_version varchar(80), policy_version varchar(80), compiler_version varchar(80),
  required_layers text[] DEFAULT ARRAY[]::text[], health_jsonb jsonb NOT NULL DEFAULT '{}',
  total_token_budget int, used_tokens int NOT NULL DEFAULT 0,
  truncated boolean NOT NULL DEFAULT false, incomplete boolean NOT NULL DEFAULT false
)`;

function request(qualified = true) {
  const semanticClock = {
    version: 1,
    kind: 'qualified_original_fixture_semantic_clock',
    instant: '2026-09-26T16:00:00.000Z',
    timeZone: 'America/New_York',
    caseId: '01',
    captureRunId: randomUUID(),
    currentVerifySha256: 'a'.repeat(64),
    observedAt: Date.now(),
  };
  return {
    tenantId: TENANT,
    effectiveTenantId: TENANT,
    actorUserId: PROPOSER,
    userId: PROPOSER,
    surface: 'chat',
    layers: ['firm-identity'],
    ref: { conversationId: randomUUID(), captureRequestId: randomUUID() },
    ...(qualified ? { now: new Date(semanticClock.instant), semanticClock } : {}),
  };
}

async function withCompiler(mode, work) {
  const previousMode = process.env.MERIV2_CONTEXT_PACKET_V2;
  process.env.MERIV2_CONTEXT_PACKET_V2 = mode;
  try {
    await withOwnedApprovedMemory(configPath, async ({ tx, deps }) => {
      await tx.$executeRawUnsafe('ALTER TABLE tenants ADD COLUMN settings_jsonb jsonb');
      await tx.$executeRawUnsafe(packetTable);
      await tx.$executeRawUnsafe(
        'UPDATE tenants SET settings_jsonb=$1::jsonb WHERE id=$2::uuid',
        JSON.stringify({
          clioFeatureFlags: { 'meriv2.contextPacketV2': true, 'meriv2.contextPacketV2.chat': true },
        }),
        TENANT,
      );
      const memoryId = randomUUID();
      await tx.$executeRawUnsafe(
        `INSERT INTO memory_items(id,tenant_id,type,slug,title,visibility,status,governed_status,
          provenance,sections_jsonb,memory_class,memory_authority,memory_scope,source_type,
          source_id,source_ref,source_content_hash,source_version,asserted_by_user_id,
          approved_by_user_id,approved_at,as_of,last_confirmed_at,sensitivity,
          conflict_status,instructions_allowed,legal_hold)
         VALUES($1::uuid,$2::uuid,'firm-soul','firm','Owned clock serialization fixture',
          'tenant','active','active','human',$3::jsonb,'institutional_authoritative',
          'firm_approved','firm','firm_playbook','owned-clock-source','memory-file:firm-soul',
          $4,'v1',$5::uuid,$6::uuid,'2026-07-20T00:00:00Z','2026-07-20T00:00:00Z',
          '2026-07-20T00:00:00Z','normal','none',false,false)`,
        memoryId,
        TENANT,
        JSON.stringify([
          { owner: 'human', heading: 'Identity', body: 'Owned serialization fixture.' },
        ]),
        'b'.repeat(64),
        PROPOSER,
        REVIEWER,
      );
      const { ContextCompilerService } = require(
        fileURLToPath(
          new URL('../../../../apps/api/src/context/context-compiler.service.ts', import.meta.url),
        ),
      );
      const recordedErrors = [];
      const service = new ContextCompilerService(deps.prisma, {
        record: (error) => recordedErrors.push(error),
      });
      assert.equal(
        await service.modeFor(TENANT, 'chat'),
        mode,
        'Actual tenant canary selects requested mode',
      );
      await work({ tx, service, memoryId, recordedErrors });
    });
  } finally {
    if (previousMode === undefined) delete process.env.MERIV2_CONTEXT_PACKET_V2;
    else process.env.MERIV2_CONTEXT_PACKET_V2 = previousMode;
  }
}

function assertClock(clockUse, input, scoring, before, after) {
  assert.deepEqual(Object.keys(clockUse).sort(), [
    'eligibilityAt',
    'instant',
    'scoring',
    'timeZone',
  ]);
  assert.equal(clockUse.instant, input.semanticClock.instant);
  assert.equal(clockUse.timeZone, input.semanticClock.timeZone);
  assert.equal(clockUse.scoring, scoring);
  const realEligibility = Date.parse(clockUse.eligibilityAt);
  assert.ok(
    realEligibility >= before && realEligibility <= after,
    'Eligibility retains actual wall time',
  );
  assert.notEqual(clockUse.eligibilityAt, clockUse.instant);
}

const faultCases = [
  {
    name: 'removed clock metadata',
    body: "NEW.model_policy_jsonb := NEW.model_policy_jsonb - 'contextCompilerClockUse'; RETURN NEW;",
    code: 'context_packet_clock_readback_mismatch',
  },
  {
    name: 'changed clock timezone',
    body: `NEW.model_policy_jsonb := jsonb_set(NEW.model_policy_jsonb,
      '{contextCompilerClockUse,timeZone}', '"UTC"'::jsonb); RETURN NEW;`,
    code: 'context_packet_clock_readback_mismatch',
  },
  {
    name: 'extra clock claim',
    body: `NEW.model_policy_jsonb := jsonb_set(NEW.model_policy_jsonb,
      '{contextCompilerClockUse,unobservedClaim}', 'true'::jsonb); RETURN NEW;`,
    code: 'context_packet_clock_readback_mismatch',
  },
  {
    name: 'missing SQL readback row',
    timing: 'AFTER',
    body: 'DELETE FROM context_packet WHERE id=NEW.id; RETURN NEW;',
    code: 'context_packet_read_after_write_missing',
  },
  {
    name: 'rejected SQL insert',
    body: "RAISE EXCEPTION 'owned context clock insert fault';",
    code: /^context_packet_[a-z0-9_]+$/,
  },
];

async function installFault(tx, fault) {
  // Constant test SQL; no external input or alternate database is accepted.
  await tx.$executeRawUnsafe(`CREATE FUNCTION context_clock_fault() RETURNS trigger
    LANGUAGE plpgsql AS $owned$ BEGIN ${fault.body} END $owned$`);
  await tx.$executeRawUnsafe(`CREATE TRIGGER context_clock_fault
    ${fault.timing ?? 'BEFORE'} INSERT ON context_packet
    FOR EACH ROW EXECUTE FUNCTION context_clock_fault()`);
}

describe(
  'context clock JSONB on actual generated Prisma/PostgreSQL',
  { skip: !configPath, concurrency: false },
  () => {
    for (const mode of ['off', 'enforce', 'shadow']) {
      it(`${mode}: persists and rereads actual compiler clock metadata`, async () => {
        await withCompiler(mode, async ({ tx, service, memoryId, recordedErrors }) => {
          const input = request();
          const before = Date.now();
          const packet = await service.compile(input);
          const after = Date.now();
          assert.equal(packet.persisted, true);
          assert.equal(packet.packetId, packet.generatedPacketId);
          assert.equal(packet.persistedPacketId, packet.packetId);
          assert.equal(packet.version, mode === 'enforce' ? 2 : 1);
          assert.ok(
            packet.items.some((item) => item.id === memoryId),
            'Actual SQL source participates',
          );
          assertClock(
            packet.clockUse,
            input,
            mode === 'enforce' ? 'used' : 'not_run',
            before,
            after,
          );
          const stored = await tx.contextPacket.findFirst({
            where: { id: packet.packetId, tenantId: TENANT },
          });
          assert.deepEqual(stored.modelPolicy, { contextCompilerClockUse: packet.clockUse });
          assert.deepEqual(stored.ref, input.ref);
          assert.equal(stored.packetHash, packet.traceHash);
          assert.deepEqual(stored.items, packet.items);
          assert.equal(stored.packetVersion, packet.version);
          const rows = await tx.contextPacket.findMany({ where: { tenantId: TENANT } });
          assert.equal(rows.length, mode === 'shadow' ? 2 : 1);
          for (const row of rows) {
            assertClock(
              row.modelPolicy.contextCompilerClockUse,
              input,
              row.packetVersion === 2 ? 'used' : 'not_run',
              before,
              after,
            );
          }
          if (mode === 'shadow') {
            const shadow = rows.find((row) => row.packetVersion === 2);
            assert.equal(shadow.health.shadowComparison.baselinePacketId, packet.packetId);
          }
          assert.deepEqual(recordedErrors, []);
        });
      });

      it(`${mode}: ordinary packets and existing unrelated JSON remain unchanged`, async () => {
        await withCompiler(mode, async ({ tx, service, memoryId }) => {
          const sentinelId = randomUUID();
          const sentinelPolicy = {
            unrelated: { text: ' keep whitespace \n Café ', values: [null, false, 3] },
          };
          await tx.contextPacket.create({
            data: {
              id: sentinelId,
              tenantId: TENANT,
              effectiveTenantId: TENANT,
              surface: 'chat',
              modelPolicy: sentinelPolicy,
              ref: { existing: 'owned sentinel' },
            },
          });
          const before = await tx.contextPacket.findFirst({ where: { id: sentinelId } });
          const packet = await service.compile(request(false));
          assert.equal(packet.persisted, true);
          assert.equal(packet.clockUse, undefined);
          assert.ok(packet.items.some((item) => item.id === memoryId));
          const rows = await tx.contextPacket.findMany({
            where: { tenantId: TENANT, id: { not: sentinelId } },
          });
          assert.equal(rows.length, mode === 'shadow' ? 2 : 1);
          for (const row of rows) assert.deepEqual(row.modelPolicy, {});
          assert.deepEqual(await tx.contextPacket.findFirst({ where: { id: sentinelId } }), before);
        });
      });

      for (const fault of faultCases) {
        it(`${mode}: ${fault.name} blocks qualified output and rolls back the failed write`, async () => {
          await withCompiler(mode, async ({ tx, service, recordedErrors }) => {
            await installFault(tx, fault);
            await assert.rejects(service.compile(request()), (error) => {
              assert.equal(error.name, 'ContextPacketPersistenceError');
              if (fault.code instanceof RegExp) assert.match(error.code, fault.code);
              else assert.equal(error.code, fault.code);
              assert.equal(error.surface, 'chat');
              assert.match(error.generatedPacketId, /^[a-f0-9-]{36}$/);
              assert.ok(
                !error.message.includes('owned context clock insert fault'),
                'Raw SQL error remains bounded',
              );
              return true;
            });
            assert.equal(
              recordedErrors.length,
              1,
              'Failure reaches the request persistence boundary',
            );
            assert.equal(
              await tx.contextPacket.count(),
              0,
              'No failed or unverified packet remains',
            );
          });
        });
      }
    }

    it('ordinary off mode retains its existing best-effort behavior on SQL failure', async () => {
      await withCompiler('off', async ({ tx, service, recordedErrors }) => {
        await installFault(
          tx,
          faultCases.find((fault) => fault.name === 'rejected SQL insert'),
        );
        const packet = await service.compile(request(false));
        assert.equal(packet.persisted, false);
        assert.equal(packet.packetId, null);
        assert.equal(packet.persistedPacketId, null);
        assert.equal(packet.clockUse, undefined);
        assert.match(packet.persistenceErrorCode, /^context_packet_[a-z0-9_]+$/);
        assert.equal(await tx.contextPacket.count(), 0);
        assert.deepEqual(recordedErrors, []);
      });
    });
  },
);
