/** Trusted release-operator CLI. Private package/manifests never belong in git. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEvidence, normalizeEvidence, reconciliationSummary } from './legiwatch-evidence.mjs';
import { applyRequestedItems } from './legiwatch-import-apply.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const n = arg.indexOf('=');
    return [arg.slice(2, n < 0 ? undefined : n), n < 0 ? true : arg.slice(n + 1)];
  }),
);
const mode = args.mode ?? 'validate';
if (
  !['validate', 'preview', 'apply'].includes(mode) ||
  !args.evidence ||
  !args.manifest ||
  !args.output
)
  throw new Error(
    'Use --evidence=PRIVATE_PATH --manifest=PRIVATE_JSON --output=PRIVATE_JSON [--mode=validate|preview|apply]',
  );
const manifest = JSON.parse(await readFile(resolve(args.manifest), 'utf8'));
const evidence = await loadEvidence(args.evidence),
  items = normalizeEvidence(evidence.inventory, manifest);
const summary = {
  ...reconciliationSummary(items),
  sourceHash: evidence.sourceHash,
  verifiedFiles: evidence.verifiedFiles,
  mode,
  tenantId: manifest.tenantId,
};
if (mode === 'validate') {
  await writeFile(resolve(args.output), JSON.stringify({ summary, items }, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(summary));
} else {
  if (!manifest.actorClerkId) throw new Error('Explicit release operator actorClerkId required');
  const { PrismaService } = await import('../dist/prisma/prisma.service.js');
  const { FolderSourceDataRepository } =
    await import('../dist/sourcedata/folder-source-data.repository.js');
  const { SourceDataRepository } = await import('../dist/sourcedata/source-data.repository.js');
  const { FolderTrackerService } =
    await import('../dist/tracker/folders/folder-tracker.service.js');
  const { FolderImportService } = await import('../dist/tracker/folders/folder-import.service.js');
  const { PreviewFolderImportDto } = await import('../dist/tracker/folders/folder-import.dto.js');
  const { plainToInstance } = await import('class-transformer'),
    { validateOrReject } = await import('class-validator');
  const prisma = new PrismaService();
  try {
    await prisma.$connect();
    const operator = await prisma.withSystem((tx) =>
      tx.$queryRawUnsafe(
        `SELECT 1 FROM tenant_memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id
       WHERE u.clerk_user_id=$1 AND t.slug='capiro-internal' AND m.role::text='capiro_admin' AND m.status::text='active' LIMIT 1`,
        manifest.actorClerkId,
      ),
    );
    if (operator.length !== 1)
      throw new Error('Release operator must be an active Capiro internal administrator');
    const target = await prisma.withSystem((tx) =>
      tx.$queryRawUnsafe('SELECT slug FROM tenants WHERE id=$1::uuid', manifest.tenantId),
    );
    if (target.length !== 1 || target[0].slug !== manifest.tenantSlug)
      throw new Error('Target tenant UUID/slug mismatch');
    const svc = new FolderImportService(
      new FolderTrackerService(
        prisma,
        new FolderSourceDataRepository(prisma),
        new SourceDataRepository(prisma),
      ),
    );
    const ctx = {
      tenantId: manifest.tenantId,
      clerkUserId: manifest.actorClerkId,
      role: 'capiro_admin',
    };
    let preview;
    for (let offset = 0; offset < items.length; offset += 100) {
      const input = plainToInstance(PreviewFolderImportDto, {
        targetTenantId: manifest.tenantId,
        sourceAccount: manifest.sourceAccount,
        captureId: manifest.captureId,
        sourceHash: evidence.sourceHash,
        mappingManifest: manifest,
        items: items.slice(offset, offset + 100),
      });
      await validateOrReject(input, { whitelist: true, forbidNonWhitelisted: true });
      preview = await svc.preview(ctx, input);
    }
    if (mode === 'apply') {
      if (!Array.isArray(manifest.applyKinds) || !manifest.applyKinds.length)
        throw new Error('Explicit applyKinds required; no implicit all-account apply');
      await applyRequestedItems(svc, ctx, preview.run, manifest.applyKinds);
    }
    const reconciled = [];
    let offset = 0;
    let page;
    do {
      page = await svc.reconcile(ctx, preview.run.id, offset);
      reconciled.push(...page.items);
      offset = page.nextOffset;
    } while (offset !== null);
    const pendingRequestedItems =
      mode === 'apply'
        ? reconciled.filter(
            (i) => manifest.applyKinds.includes(i.kind) && ['ready', 'retry'].includes(i.status),
          ).length
        : 0;
    if (pendingRequestedItems) process.exitCode = 2;
    await writeFile(
      resolve(args.output),
      JSON.stringify(
        {
          summary,
          run: page.run,
          counts: page.counts,
          items: reconciled,
          alertsActivated: false,
          usersProvisioned: false,
          pendingRequestedItems,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        summary,
        runId: preview.run.id,
        counts: page.counts,
        alertsActivated: false,
        usersProvisioned: false,
        pendingRequestedItems,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}
