/** Maintenance for pre-fix editable drafts. Dry-run is the default; never rewrites
 * selections, citations, approved report runs, delivery rows or source receipts.
 *
 * tsx scripts/legiwatch/repair-editorial-coverage.ts --tenant UUID --owner CLERK_ID
 *   --draft-ids UUID,UUID --plan /tmp/editorial-coverage-plan.json
 * Review the exact before/after paragraphs and printed SHA-256, then:
 * tsx scripts/legiwatch/repair-editorial-coverage.ts --apply --plan /tmp/editorial-coverage-plan.json
 *   --expected-plan-hash SHA256
 * Requires the normal Workspace DB identity and its configured Intel service URL/secret.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PrismaClient } from '../../apps/workspace/generated/prisma-client/index.js';
import { formatLegacyEditorialCoverage } from '../../apps/workspace/src/drafts/editorial-content.js';

const args = process.argv.slice(2);
const arg = (name: string) => args[args.indexOf(name) + 1];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fileHash = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const uuid = (value: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
type Candidate = {
  draftId: string;
  action: 'repair' | 'unchanged';
  expectedUpdatedAt: string;
  expectedConfigHash: string;
  nextConfigHash: string;
  before: string;
  after: string;
};
type Plan = { version: 1; tenantId: string; ownerId: string; candidates: Candidate[] };

async function main() {
  const planPath = arg('--plan');
  if (!args.includes('--plan') || !planPath) throw Error('--plan is required');
  const apply = args.includes('--apply');
  const serialized = apply ? await readFile(planPath, 'utf8') : '';
  if (
    apply &&
    (!args.includes('--expected-plan-hash') || fileHash(serialized) !== arg('--expected-plan-hash'))
  )
    throw Error('Reviewed plan hash does not match');
  const prior = apply ? (JSON.parse(serialized) as Plan) : null;
  const tenantId = prior?.tenantId ?? (args.includes('--tenant') ? arg('--tenant') : '');
  const ownerId = prior?.ownerId ?? (args.includes('--owner') ? arg('--owner') : '');
  const ids =
    prior?.candidates.map((c) => c.draftId) ??
    (args.includes('--draft-ids') ? arg('--draft-ids').split(',') : []);
  if (
    (prior && prior.version !== 1) ||
    !uuid(tenantId) ||
    !ownerId ||
    ownerId.length > 200 ||
    !ids.length ||
    ids.length > 50 ||
    ids.some((id) => !uuid(id)) ||
    new Set(ids).size !== ids.length
  )
    throw Error('Explicit tenant, owner and 1–50 unique draft UUIDs required');
  const base = process.env.INTEL_API_BASE_URL,
    secret = process.env.INTERNAL_SERVICE_SECRET;
  if (!base || !secret) throw Error('Workspace Intel source access configuration is required');
  const prisma = new PrismaClient();
  const candidates: Candidate[] = [];
  try {
    for (const draftId of ids) {
      const result = await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant',${tenantId},true)`;
          await tx.$executeRaw`SELECT set_config('app.folder_actor',${ownerId},true)`;
          const members = await tx.$queryRaw<
            Array<{ id: string }>
          >`SELECT u.id FROM users u JOIN tenant_memberships m ON m.user_id=u.id WHERE m.tenant_id=${tenantId}::uuid AND u.clerk_user_id=${ownerId} AND m.status::text='active' FOR SHARE OF m`;
          if (!members.length) throw Error('Active owner membership is required');
          const receipts = await tx.$queryRaw<
            Array<{ source_key: string }>
          >`SELECT source_key FROM ws_source_action WHERE tenant_id=${tenantId}::uuid AND owner_id=${ownerId} AND draft_id=${draftId}::uuid AND source_type='legiwatch_editorial'`;
          if (receipts.length !== 1)
            throw Error(`Draft ${draftId}: exact owned editorial receipt required`);
          const draft = await tx.wsDraft.findFirst({ where: { tenantId, ownerId, id: draftId } });
          if (!draft) throw Error(`Draft ${draftId}: current owner required`);
          const selectionId = receipts[0]!.source_key;
          const response = await fetch(
            `${base.replace(/\/+$/, '')}/intel-api/internal/legiwatch/editorial-source/${encodeURIComponent(selectionId)}?${new URLSearchParams({ tenantId, ownerId })}`,
            {
              headers: { 'x-internal-service-secret': secret },
              signal: AbortSignal.timeout(10_000),
              redirect: 'error',
            },
          );
          if (!response.ok) throw Error(`Draft ${draftId}: current source access unavailable`);
          const source = object(await response.json()),
            prefill = object(source.prefill),
            context = object(prefill.context);
          if (
            source.actionId !== selectionId ||
            context.snapshotId !== selectionId ||
            !Array.isArray(prefill.sources)
          )
            throw Error('Exact authoritative selection required');
          const config = object(draft.config),
            next = formatLegacyEditorialCoverage(config, context, prefill.sources);
          const candidate: Candidate = {
            draftId,
            action: next ? 'repair' : 'unchanged',
            expectedUpdatedAt: draft.updatedAt.toISOString(),
            expectedConfigHash: hash(config),
            nextConfigHash: hash(next ?? config),
            before: String(object(config.sectionContent)['Cutoff and coverage'] ?? ''),
            after: String(object((next ?? config).sectionContent)['Cutoff and coverage'] ?? ''),
          };
          if (apply) {
            const expected = prior!.candidates.find((c) => c.draftId === draftId)!;
            if (JSON.stringify(candidate) !== JSON.stringify(expected))
              throw Error(`Draft ${draftId}: changed after review; create a new plan`);
            if (next) {
              const updated = await tx.wsDraft.updateMany({
                where: {
                  id: draftId,
                  tenantId,
                  ownerId,
                  updatedAt: draft.updatedAt,
                  config: { equals: draft.config! },
                },
                data: { config: next as never, lastEditedById: ownerId },
              });
              if (updated.count !== 1)
                throw Error(`Draft ${draftId}: concurrent edit; no repair applied`);
            }
          }
          return candidate;
        },
        { timeout: 20_000 },
      );
      candidates.push(result);
      if (apply)
        console.log(
          JSON.stringify({ draftId, state: result.action === 'repair' ? 'applied' : 'unchanged' }),
        );
    }
    if (!apply) {
      const plan: Plan = { version: 1, tenantId, ownerId, candidates };
      const text = JSON.stringify(plan, null, 2) + '\n';
      await writeFile(planPath, text, { flag: 'wx', mode: 0o600 });
      console.log(
        JSON.stringify({
          plan: planPath,
          planHash: fileHash(text),
          repairs: candidates.filter((c) => c.action === 'repair').length,
          state: 'dry_run_only',
        }),
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Coverage repair failed');
  process.exitCode = 1;
});
