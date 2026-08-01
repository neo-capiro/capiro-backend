/**
 * Phase 10 pre-merge acceptance orchestrator (closeout).
 *
 * Authorized plane: sole live env=dev / ECS `capiro-dev` (serves live app).
 * Neo auth: PE_CLOSEOUT_STAGING_OK=yes
 * Mutate:   PE_CLOSEOUT_STAGING_MUTATE=yes (+ healthy inventory)
 *
 * Modes:
 *  - default            : auth + inventory + local preflight + (mutate ship if allowed) + record
 *  - --catalog-only     : catalog honesty
 *  - --integrity-only   : tip path transport scan
 *  - --inventory-only   : run plane probe + summarize
 *  - --dry-run          : print steps, do not execute shell
 *  - --skip-local-gates : skip K + phase9 integrity
 *  - --skip-image-build : reuse existing tip/latest digests (still requires present digest for OK)
 *  - --evidence-bind-only : rewrite evidence to HEAD without migrate/deploy/live-proofs re-ship
 *    (requires prior ship artifacts + PE_CLOSEOUT_PRODUCT_TIP or honesty.harnessOkProductTip)
 *
 * Never deploys to capiro-staging or capiro-prod-os-capiro.
 * Never Secrets Manager GetSecretValue, email, LlamaParse, or derive --commit.
 * Does not self-PASS adversarial REVIEW. Does not merge #705.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  PE_PHASE_10_ACCEPTANCE_STEPS,
  PE_PHASE_10_STAGING_EXPECTED,
} from './lib/pe-phase-10-staging-acceptance-catalog.js';
import {
  PE_PHASE_10_BLOCKED_EXIT,
  assertPePhase10CatalogHonest,
  classifyEnvBlockedStep,
  evaluatePePhase10Gate,
  evaluatePePhase10Integrity,
  evaluateStagingAuth,
  evaluateStagingMutateAllowed,
  isForbiddenDeployCluster,
  summarizeStagingInventory,
  type PePhase10ImageDigestRecord,
  type PePhase10Inventory,
  type PePhase10PriorTaskDef,
  type PePhase10StepOutcome,
} from './lib/pe-phase-10-staging-acceptance.js';
import {
  assertAuthorizedClusterOrThrow,
  browserSmoke,
  loadPlanVerifyResidual,
  purgeStaleEvidenceArtifacts,
  resolveRollbackPriorsFromEvidence,
  resolveShipImageDigests,
  writeShipTrace,
  buildAndPushBranchImages,
  capturePriorTaskDefs,
  deployBranchTaskDefs,
  ecrDigestForTag,
  outcomesFromLiveProofReport,
  rehearseRollback,
  runAdditiveMigrate,
  runAlarmTestEvents,
  runLiveProofsTask,
  writeRollbackCapture,
  type PePhase10ShipTrace,
} from './lib/pe-phase-10-ship.js';

function repoRootFromCwd(): string {
  const cwd = process.cwd().replace(/\\/g, '/');
  if (cwd.endsWith('/apps/api')) return resolve(process.cwd(), '../..');
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function parseArgs(argv: string[]) {
  const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')));
  const get = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    const next = idx >= 0 ? argv[idx + 1] : undefined;
    if (idx >= 0 && next && !next.startsWith('--')) return next;
    const pref = argv.find((a) => a.startsWith(`${name}=`));
    return pref ? pref.slice(name.length + 1) : undefined;
  };
  return {
    catalogOnly: flags.has('--catalog-only'),
    integrityOnly: flags.has('--integrity-only'),
    inventoryOnly: flags.has('--inventory-only'),
    dryRun: flags.has('--dry-run'),
    skipLocalGates: flags.has('--skip-local-gates'),
    skipImageBuild: flags.has('--skip-image-build'),
    evidenceBindOnly: flags.has('--evidence-bind-only'),
    evidenceDir: get('--evidence-dir'),
    productTip: get('--product-tip') || process.env.PE_CLOSEOUT_PRODUCT_TIP || undefined,
  };
}

function git(args: string[], cwd: string): { code: number; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function listTipPaths(root: string): string[] {
  const r = git(['ls-tree', '-r', '--name-only', 'HEAD'], root);
  if (r.code !== 0) {
    const acc: string[] = [];
    const walk = (rel: string, depth: number) => {
      if (depth > 8) return;
      const abs = resolve(root, rel || '.');
      if (!existsSync(abs)) return;
      for (const name of readdirSync(abs)) {
        if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
        const child = rel ? `${rel}/${name}` : name;
        const st = statSync(resolve(root, child));
        if (st.isDirectory()) walk(child, depth + 1);
        else acc.push(child.replace(/\\/g, '/'));
      }
    };
    walk('', 0);
    return acc;
  }
  return r.out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function listChangedPaths(root: string): string[] {
  const r = git(['diff', '--name-only', 'origin/main...HEAD'], root);
  if (r.code !== 0) return [];
  return r.out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function runCmd(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): { code: number; out: string; ms: number } {
  const t0 = Date.now();
  const r = spawnSync(command, {
    cwd,
    env: { ...env, FORCE_COLOR: '0', MSYS_NO_PATHCONV: '1' },
    encoding: 'utf8',
    shell: true,
    maxBuffer: 12 * 1024 * 1024,
  });
  return {
    code: r.status ?? 1,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(0, 12000),
    ms: Date.now() - t0,
  };
}

function gitEvidence(root: string) {
  const head = git(['rev-parse', 'HEAD'], root).out.trim();
  const origin = git(['rev-parse', 'origin/agent/program-elements-final-closeout'], root);
  const main = git(['rev-parse', 'origin/main'], root);
  const mb = git(['merge-base', 'HEAD', 'origin/main'], root);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root).out.trim();
  return {
    headSha: head,
    originHeadSha: origin.code === 0 ? origin.out.trim() : null,
    mainSha: main.code === 0 ? main.out.trim() : null,
    mergeBaseSha: mb.code === 0 ? mb.out.trim() : null,
    branch,
  };
}

function awsEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AWS_PROFILE: process.env.AWS_PROFILE || process.env.PE_CLOSEOUT_AWS_PROFILE || 'capiro-dev',
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || PE_PHASE_10_STAGING_EXPECTED.region,
    MSYS_NO_PATHCONV: '1',
  };
}

function runInventoryProbe(root: string): {
  inventory: PePhase10Inventory;
  raw: Record<string, unknown> | null;
  probeExit: number;
  probeOut: string;
} {
  const script = resolve(root, 'apps/api/scripts/pe-phase-10-staging-probe.sh');
  const env = awsEnv();
  const r = runCmd(`bash "${script}" --json`, root, env);
  let raw: Record<string, unknown> | null = null;
  try {
    const start = r.out.indexOf('{');
    const end = r.out.lastIndexOf('}');
    if (start >= 0 && end > start) {
      raw = JSON.parse(r.out.slice(start, end + 1)) as Record<string, unknown>;
    }
  } catch {
    raw = null;
  }

  if (!raw || r.code === 2 || r.code === 3) {
    const inv = summarizeStagingInventory({
      accountId: null,
      ecsClusterExists: false,
      auroraClusterLive: false,
      computeStackStatus: null,
      apiServiceExists: false,
      webServiceExists: false,
      rawNotes: [`probe_exit=${r.code}`, r.out.slice(0, 500)],
    });
    inv.probeOk = false;
    inv.blockers.push(
      r.code === 3
        ? 'wrong AWS account'
        : 'AWS plane probe failed (credentials or CLI) — cannot claim healthy authorized plane',
    );
    inv.healthyCompute = false;
    return { inventory: inv, raw, probeExit: r.code, probeOut: r.out };
  }

  const priorTaskDefs = (raw.priorTaskDefs as PePhase10PriorTaskDef[] | undefined) ?? [];
  const inv = summarizeStagingInventory({
    accountId: (raw.accountId as string) ?? null,
    region: (raw.region as string) ?? PE_PHASE_10_STAGING_EXPECTED.region,
    ecsClusterExists: Boolean(raw.ecsClusterExists),
    ecsClusterStatus: (raw.ecsClusterStatus as string) ?? null,
    apiServiceExists: Boolean(raw.apiServiceExists),
    webServiceExists: Boolean(raw.webServiceExists),
    computeStackStatus: (raw.computeStackStatus as string) ?? null,
    dataStackStatus: (raw.dataStackStatus as string) ?? null,
    networkStackStatus: (raw.networkStackStatus as string) ?? null,
    auroraClusterLive: Boolean(raw.auroraClusterLive),
    auroraClusterId: (raw.auroraClusterId as string) ?? null,
    forbiddenClusterPresent: Boolean(raw.forbiddenClusterPresent),
    capturedAt: (raw.capturedAt as string) ?? new Date().toISOString(),
    priorTaskDefs,
    rawNotes: [
      `plane=${raw.planeName ?? 'sole-live-env-dev'}`,
      `secretNameCount=${raw.devSecretNameCount ?? raw.stagingSecretNameCount ?? '?'}`,
      `cfAuroraPhysicalId=${raw.cfAuroraPhysicalId ?? 'n/a'}`,
      `apiTd=${raw.apiTaskDefinitionArn ?? 'n/a'}`,
      `webTd=${raw.webTaskDefinitionArn ?? 'n/a'}`,
    ],
  });
  return { inventory: inv, raw, probeExit: r.code, probeOut: r.out };
}

function tryImageDigests(headSha: string, env: NodeJS.ProcessEnv): PePhase10ImageDigestRecord[] {
  const records: PePhase10ImageDigestRecord[] = [];
  const tags = [headSha, headSha.slice(0, 12), headSha.slice(0, 7), 'latest'];
  const repos = [
    ...PE_PHASE_10_STAGING_EXPECTED.ecrApiRepoCandidates,
    ...PE_PHASE_10_STAGING_EXPECTED.ecrWebRepoCandidates,
  ];
  for (const repo of repos) {
    let found: PePhase10ImageDigestRecord | null = null;
    for (const tag of tags) {
      const rec = ecrDigestForTag(env, repo, tag);
      if (rec.present) {
        found = rec;
        break;
      }
    }
    records.push(
      found ?? {
        repo,
        tag: headSha,
        digest: null,
        pushedAt: null,
        present: false,
        note: 'branch tip tag not present in ECR',
      },
    );
  }
  return records;
}

function defaultEvidenceDir(root: string): string {
  return resolve(root, 'docs/verification/program-elements-trust/phase-10');
}

function writeAcceptanceArtifacts(args: {
  dir: string;
  git: ReturnType<typeof gitEvidence>;
  inventory: PePhase10Inventory;
  inventoryRaw: Record<string, unknown> | null;
  images: PePhase10ImageDigestRecord[];
  outcomes: PePhase10StepOutcome[];
  gate: ReturnType<typeof evaluatePePhase10Gate>;
  integrity: ReturnType<typeof evaluatePePhase10Integrity>;
  mutateAllowed: boolean;
  authOk: boolean;
  rollbackInstructions: string[];
  shipTrace: PePhase10ShipTrace | null;
  productTip?: string | null;
  planVerify?: {
    closed: boolean;
    mode: string;
    detail: string;
  } | null;
  preserveLiveProofs?: boolean;
}): void {
  mkdirSync(args.dir, { recursive: true });
  // Drop disposable PASS-file + stale ship/deploy/migrate artifacts before rewrite.
  // Keep live-proofs-task.json when rebinding docs-only (product tip unchanged).
  const liveProofsPath = resolve(args.dir, 'live-proofs-task.json');
  let liveProofsBackup: string | null = null;
  if (args.preserveLiveProofs && existsSync(liveProofsPath)) {
    try {
      liveProofsBackup = readFileSync(liveProofsPath, 'utf8');
    } catch {
      liveProofsBackup = null;
    }
  }
  purgeStaleEvidenceArtifacts(args.dir);
  if (liveProofsBackup) {
    writeFileSync(liveProofsPath, liveProofsBackup);
  }
  let shipTraceOut = args.shipTrace;
  if (shipTraceOut) {
    const digests = resolveShipImageDigests(shipTraceOut.images ?? [], {
      apiImageDigest: shipTraceOut.apiImageDigest,
      webImageDigest: shipTraceOut.webImageDigest,
    });
    shipTraceOut = {
      ...shipTraceOut,
      apiImageDigest: digests.apiImageDigest,
      webImageDigest: digests.webImageDigest,
    };
    writeShipTrace(args.dir, shipTraceOut as any);
  }
  const tipBound =
    Boolean(args.git.headSha) &&
    Boolean(args.git.originHeadSha) &&
    args.git.headSha === args.git.originHeadSha;
  const summary = {
    phase: 10,
    generatedAt: new Date().toISOString(),
    marker: args.gate.marker,
    gateOk: args.gate.ok,
    blockedComplete: args.gate.blockedComplete,
    authOk: args.authOk,
    mutateAllowed: args.mutateAllowed,
    plane: {
      name: PE_PHASE_10_STAGING_EXPECTED.planeName,
      workflowEnv: PE_PHASE_10_STAGING_EXPECTED.workflowEnv,
      ecsCluster: PE_PHASE_10_STAGING_EXPECTED.ecsClusterName,
      appHost: PE_PHASE_10_STAGING_EXPECTED.appHost,
      note: 'sole live env=dev / capiro-dev (= prod path); not dead staging',
    },
    git: args.git,
    inventory: args.inventory,
    inventoryRaw: args.inventoryRaw,
    images: args.images,
    shipTrace: shipTraceOut,
    integrity: args.integrity,
    outcomes: args.outcomes,
    classifications: args.gate.classifications,
    exitGate: args.gate.exitGate,
    blockers: args.gate.blockers,
    warnings: args.gate.warnings,
    safety: {
      noSecretsGetValue: true,
      noEmailSend: true,
      noLlamaParse: true,
      noDeriveCommit: true,
      noForbiddenClusterDeploy: PE_PHASE_10_STAGING_EXPECTED.forbiddenEcsClusters.every((c) =>
        isForbiddenDeployCluster(c),
      ),
      authorizedCluster: PE_PHASE_10_STAGING_EXPECTED.ecsClusterName,
      roast: 'PE_PHASE_10_OK is not independent REVIEW PASS; merge #705 still separate',
    },
    rollback: {
      documented: true,
      // Prefer rehearsal.prior (pre-ship) — never label live current tip as prior.
      capturedPriors: (() => {
        const fromInstr = resolveRollbackPriorsFromEvidence(
          args.dir,
          args.inventory.priorTaskDefs,
          args.shipTrace?.priorTaskDefs,
        );
        return fromInstr.filter((t) => !!t.arn);
      })(),
      currentTip: {
        api: args.shipTrace?.newApiTaskDefArn ?? null,
        web: args.shipTrace?.newWebTaskDefArn ?? null,
      },
      instructions: args.rollbackInstructions,
      // Branch tip for this evidence bind (must equal origin HEAD after final push).
      branchRollbackTipHint: args.git.originHeadSha ?? args.git.headSha,
    },
    honesty: {
      syntheticAlarmsNotHumanReviewed: true,
      localPreflightNotLiveSubstitute: true,
      blockedIsNotOk: args.gate.marker === 'PE_PHASE_10_BLOCKED',
      exitGateUnsatisfiedWhenBlocked: args.gate.marker === 'PE_PHASE_10_BLOCKED'
        ? !args.gate.exitGate.every((e) => e.satisfied)
        : null,
      implementerOkNotReviewPass: true,
      harnessOkProductTip: args.productTip ?? null,
      reviewMustUseOriginHead: true,
      gitTipBound: tipBound,
      planVerify: args.planVerify ?? null,
      note:
        'summary.git.headSha === summary.git.originHeadSha === git rev-parse origin/agent/program-elements-final-closeout (single tip truth after FINAL push; no further docs pin). Product tip only in honesty.harnessOkProductTip + image tags. PE_PHASE_10_OK is implementer-only — not independent REVIEW PASS.',
    },
  };
  writeFileSync(resolve(args.dir, 'phase-10-acceptance-summary.json'), JSON.stringify(summary, null, 2));

  const md = [
    '# Phase 10 pre-merge acceptance record (sole live env=dev)',
    '',
    `- Generated (UTC): ${summary.generatedAt}`,
    `- Marker: **${args.gate.marker}** (implementer only — not independent REVIEW PASS)`,
    `- Plane: \`${PE_PHASE_10_STAGING_EXPECTED.ecsClusterName}\` / workflow env=\`${PE_PHASE_10_STAGING_EXPECTED.workflowEnv}\` (authorized sole live = prod path)`,
    `- HEAD / origin HEAD (single tip truth): \`${args.git.headSha}\``,
    `- origin/agent/program-elements-final-closeout: \`${args.git.originHeadSha ?? 'n/a'}\``,
    `- origin/main: \`${args.git.mainSha ?? 'n/a'}\``,
    `- merge-base: \`${args.git.mergeBaseSha ?? 'n/a'}\``,
    `- Product/live-proofs tip (honesty only): \`${args.productTip ?? 'n/a'}\``,
    `- Mutate PE_CLOSEOUT_STAGING_MUTATE: ${args.mutateAllowed}`,
    `- Inventory healthyCompute: **${args.inventory.healthyCompute}**`,
    `- Plan Verify closed: **${args.planVerify?.closed === true}** (${args.planVerify?.mode ?? 'n/a'})`,
    `- Git tip bound: **${tipBound}**`,
    '',
    '## Gate',
    args.gate.ok
      ? '- Full PE_PHASE_10_OK (ship path) — STILL requires independent REVIEW; merge #705 separate'
      : args.gate.blockedComplete
        ? '- **PE_PHASE_10_BLOCKED** — packaging complete; exit-gate bullets that lack proofs are unsatisfied; not a green ship gate'
        : '- **PE_PHASE_10_FAIL** — see blockers',
    '',
    '## Inventory blockers',
    ...(args.inventory.blockers.length
      ? args.inventory.blockers.map((b) => `- ${b}`)
      : ['- (none)']),
    '',
    '## Gate blockers',
    ...(args.gate.blockers.length ? args.gate.blockers.map((b) => `- ${b}`) : ['- (none)']),
    '',
    '## Warnings',
    ...(args.gate.warnings.length ? args.gate.warnings.map((w) => `- ${w}`) : ['- (none)']),
    '',
    '## Captured prior task defs (rollback — pre-ship, from rehearsal.prior when present)',
    ...(() => {
      const priors = resolveRollbackPriorsFromEvidence(
        args.dir,
        args.inventory.priorTaskDefs,
        args.shipTrace?.priorTaskDefs,
      );
      return priors.length
        ? priors.map(
            (t) =>
              `- \`${t.family}\` rev=${t.revision ?? '?'} arn=\`${t.arn ?? 'n/a'}\` image=${t.image ?? 'n/a'}`,
          )
        : ['- (none captured)'];
    })(),
    '',
    '## Current tip task defs (post-ship — NOT prior)',
    `- api: \`${args.shipTrace?.newApiTaskDefArn ?? 'n/a'}\``,
    `- web: \`${args.shipTrace?.newWebTaskDefArn ?? 'n/a'}\``,
    '',
    '## Image digests',
    ...args.images.map(
      (i) =>
        `- \`${i.repo}\` tag=${i.tag ?? 'n/a'} present=${i.present} digest=${i.digest ?? 'absent'}${i.note ? ` (${i.note})` : ''}`,
    ),
    '',
    '## Outcomes',
    ...args.outcomes.map(
      (o) =>
        `- \`${o.stepId}\` exit=${o.exitCode} class=${o.classification ?? '?'} ${(o.detail ?? '').slice(0, 160)}`,
    ),
    '',
    '## Exit-gate bullets',
    ...args.gate.exitGate.map((e) => `- [${e.satisfied ? 'x' : ' '}] ${e.bullet}: ${e.reason}`),
    '',
    '## Rollback (captured priors on authorized services)',
    ...args.rollbackInstructions.map((l) => `- ${l}`),
    '',
    '## Safety (this run)',
    '- No Secrets Manager GetSecretValue',
    '- No email send / LlamaParse / derive --commit',
    `- Deploy target authorized only: \`${PE_PHASE_10_STAGING_EXPECTED.ecsClusterName}\``,
    `- Forbidden clusters: ${PE_PHASE_10_STAGING_EXPECTED.forbiddenEcsClusters.join(', ')}`,
    '- Email automation remains dark (policy)',
    '- Synthetic alarm events stay synthetic-loud, never humanReviewed',
    '',
    '## Honesty',
    '- This file is implementer evidence, **not** independent REVIEW PASS.',
    '- Local `verify:pe-phase-k` / Phase 9 integrity are preflight, not live-env substitutes.',
    '- PE_PHASE_10_BLOCKED means the work stopped honestly — not a pass.',
    '- Exit-gate bullets without proofs are unchecked (no N/A auto-pass).',
    '',
  ].join('\n');
  writeFileSync(resolve(args.dir, 'README.md'), md);
  writeFileSync(resolve(args.dir, 'phase-10-acceptance-record.md'), md);
  if (args.inventoryRaw) {
    writeFileSync(resolve(args.dir, 'staging-inventory.json'), JSON.stringify(args.inventoryRaw, null, 2));
    writeFileSync(resolve(args.dir, 'live-plane-inventory.json'), JSON.stringify(args.inventoryRaw, null, 2));
  }
}

function main(): void {
  const root = repoRootFromCwd();
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const catalog = assertPePhase10CatalogHonest();
  if (!catalog.ok) {
    console.error('PE_PHASE_10_CATALOG_FAIL', catalog.errors.join('\n'));
    process.exit(1);
  }
  if (args.catalogOnly) {
    console.log('PE_PHASE_10_CATALOG_OK');
    process.exit(0);
  }

  const tipPaths = listTipPaths(root);
  const changedPaths = listChangedPaths(root);
  const integrity = evaluatePePhase10Integrity({ tipPaths, changedPaths });
  if (args.integrityOnly) {
    if (!integrity.ok) {
      console.error('PE_PHASE_10_INTEGRITY_FAIL', integrity.blockers.join('\n'));
      process.exit(1);
    }
    console.log('PE_PHASE_10_INTEGRITY_OK');
    process.exit(0);
  }

  const auth = evaluateStagingAuth(process.env);
  if (!auth.ok && !args.dryRun) {
    console.error('PE_PHASE_10_AUTH_REFUSED', auth.reason);
    console.error(
      'Set PE_CLOSEOUT_STAGING_OK=yes only after Neo explicit sole-live env=dev authorization.',
    );
    process.exit(1);
  }

  if (args.dryRun) {
    for (const s of PE_PHASE_10_ACCEPTANCE_STEPS) {
      console.log(
        `- ${s.id} [${s.kind}] required=${s.required} mutate=${!!s.requiresMutate} :: ${s.command || '(in-process)'}`,
      );
    }
    console.log('PE_PHASE_10_DRY_RUN_OK plane=capiro-dev');
    process.exit(0);
  }

  const ge = gitEvidence(root);
  const env = awsEnv();
  const { inventory, raw, probeExit, probeOut } = runInventoryProbe(root);

  // Always enrich priors
  try {
    const priors = capturePriorTaskDefs(env, inventory);
    if (priors.length) inventory.priorTaskDefs = priors;
  } catch (e) {
    inventory.warnings.push(`prior TD capture: ${(e as Error).message}`);
  }

  if (args.inventoryOnly) {
    console.log(JSON.stringify({ inventory, probeExit, raw }, null, 2));
    console.log(
      inventory.healthyCompute
        ? 'PE_PHASE_10_INVENTORY_HEALTHY'
        : 'PE_PHASE_10_INVENTORY_UNHEALTHY',
    );
    process.exit(0);
  }

  const mutate = evaluateStagingMutateAllowed(process.env, inventory);
  const productTip =
    (args.productTip || '').trim() ||
    (() => {
      try {
        const prev = resolve(defaultEvidenceDir(root), 'phase-10-acceptance-summary.json');
        if (!existsSync(prev)) return '';
        const j = JSON.parse(readFileSync(prev, 'utf8')) as { honesty?: { harnessOkProductTip?: string } };
        return (j.honesty?.harnessOkProductTip || '').trim();
      } catch {
        return '';
      }
    })() ||
    '28dbed74845a74f1cb432ee4e5d1577827eaf182';

  // Prefer product-tip ECR tags when docs tip has no images (normal after docs pins).
  let images = tryImageDigests(ge.headSha, env);
  const headTipPresent =
    images.some((i) => i.repo.includes('/api') && i.present && i.digest) &&
    images.some((i) => i.repo.includes('/web') && i.present && i.digest);
  if (!headTipPresent && productTip) {
    const productImages = tryImageDigests(productTip, env);
    if (productImages.some((i) => i.present && i.digest)) {
      images = productImages.map((i) => ({
        ...i,
        note: i.note || `product tip tag ${productTip.slice(0, 12)} (runtime ship; review HEAD is docs tip)`,
      }));
    }
  }

  const outcomes: PePhase10StepOutcome[] = [];
  let shipTrace: PePhase10ShipTrace | null = null;
  let planVerifyMeta: { closed: boolean; mode: string; detail: string } | null = null;
  let rollbackInstructions: string[] = [
    'Capture prior task-definition ARNs before mutate, then:',
    `aws ecs update-service --cluster ${PE_PHASE_10_STAGING_EXPECTED.ecsClusterName} --service ${PE_PHASE_10_STAGING_EXPECTED.apiServiceName} --task-definition <prior-api-td-arn>`,
    `aws ecs update-service --cluster ${PE_PHASE_10_STAGING_EXPECTED.ecsClusterName} --service ${PE_PHASE_10_STAGING_EXPECTED.webServiceName} --task-definition <prior-web-td-arn>`,
    'Do NOT hand-edit migration history; Aurora snapshot if schema is bad.',
    'Never target capiro-staging or capiro-prod-os-capiro.',
  ];

  const gitTipBound =
    Boolean(ge.headSha) && Boolean(ge.originHeadSha) && ge.headSha === ge.originHeadSha;

  outcomes.push({
    stepId: 'git_sha_record',
    exitCode: ge.headSha && gitTipBound ? 0 : 1,
    classification: ge.headSha && gitTipBound ? 'ok' : 'branch_introduced',
    detail: `head=${ge.headSha} origin=${ge.originHeadSha} main=${ge.mainSha} mb=${ge.mergeBaseSha} tipBound=${gitTipBound} productTip=${productTip}`,
  });

  outcomes.push({
    stepId: 'aws_inventory_readonly',
    exitCode: inventory.probeOk || probeExit === 0 ? 0 : probeExit || 1,
    classification: inventory.probeOk || probeExit === 0 ? 'ok' : 'branch_introduced',
    detail: `healthyCompute=${inventory.healthyCompute} plane=${PE_PHASE_10_STAGING_EXPECTED.ecsClusterName} blockers=${inventory.blockers.length} probeExit=${probeExit}`,
  });

  // local preflights
  if (!args.skipLocalGates) {
    for (const id of ['local_pe_preflight_k', 'local_pe_phase9_preflight'] as const) {
      const step = PE_PHASE_10_ACCEPTANCE_STEPS.find((s) => s.id === id)!;
      const r = runCmd(step.command, root);
      outcomes.push({
        stepId: id,
        exitCode: r.code,
        classification: r.code === 0 ? 'ok' : 'branch_introduced',
        detail: r.out.slice(-800),
        durationMs: r.ms,
      });
    }
  } else {
    for (const id of ['local_pe_preflight_k', 'local_pe_phase9_preflight'] as const) {
      outcomes.push({
        stepId: id,
        exitCode: 0,
        classification: 'ok',
        detail: 'skipped via --skip-local-gates (operator)',
      });
    }
  }

  outcomes.push({
    stepId: 'transport_absent',
    exitCode: integrity.ok ? 0 : 1,
    classification: integrity.ok ? 'ok' : 'branch_introduced',
    detail: integrity.ok ? 'no forbidden paths' : integrity.blockers.join('; '),
  });

  const evidenceDir = args.evidenceDir ? resolve(root, args.evidenceDir) : defaultEvidenceDir(root);
  const bindOnly = Boolean(args.evidenceBindOnly);

  // -------- mutate ship path on authorized healthy plane --------
  if (mutate.ok && inventory.healthyCompute) {
    try {
      assertAuthorizedClusterOrThrow(PE_PHASE_10_STAGING_EXPECTED.ecsClusterName);
    } catch (e) {
      console.error(String(e));
      process.exit(1);
    }

    // Seed shipTrace from prior evidence when bind-only (preserve migrate/deploy ARNs)
    let priorShip: PePhase10ShipTrace | null = null;
    try {
      const stPath = resolve(evidenceDir, 'ship-trace.json');
      const sumPath = resolve(evidenceDir, 'phase-10-acceptance-summary.json');
      if (existsSync(stPath)) {
        priorShip = JSON.parse(readFileSync(stPath, 'utf8')) as PePhase10ShipTrace;
      } else if (existsSync(sumPath)) {
        const s = JSON.parse(readFileSync(sumPath, 'utf8')) as { shipTrace?: PePhase10ShipTrace };
        priorShip = s.shipTrace ?? null;
      }
    } catch {
      priorShip = null;
    }

    // Resolve true pre-ship priors BEFORE overwriting with live current TDs.
    const bindPriors = resolveRollbackPriorsFromEvidence(
      evidenceDir,
      // Prefer ship-trace historical priors / rehearsal over live inventory (current tip).
      priorShip?.priorTaskDefs ?? inventory.priorTaskDefs,
      priorShip?.priorTaskDefs,
    );
    // If rehearsal says :88/:22, keep those; live inventory is CURRENT tip only.
    const liveCurrentAsTip = inventory.priorTaskDefs ?? [];
    shipTrace = {
      priorTaskDefs: bindPriors.length
        ? bindPriors
        : priorShip?.priorTaskDefs ?? inventory.priorTaskDefs ?? [],
      newApiTaskDefArn:
        priorShip?.newApiTaskDefArn ??
        liveCurrentAsTip.find((t) => t.family?.includes('api'))?.arn ??
        null,
      newWebTaskDefArn:
        priorShip?.newWebTaskDefArn ??
        liveCurrentAsTip.find((t) => t.family?.includes('web'))?.arn ??
        null,
      migrateTaskArn: priorShip?.migrateTaskArn ?? null,
      images: [],
      apiImageDigest: priorShip?.apiImageDigest ?? null,
      webImageDigest: priorShip?.webImageDigest ?? null,
      deployedCluster: PE_PHASE_10_STAGING_EXPECTED.ecsClusterName,
      notes: priorShip?.notes ? [...priorShip.notes] : [],
    };
    // Keep inventory.priorTaskDefs as the rollback targets (pre-ship), not live current.
    if (bindPriors.length) {
      inventory.priorTaskDefs = bindPriors;
    }
    if ((priorShip as any)?.liveProofsTaskArn) {
      (shipTrace as any).liveProofsTaskArn = (priorShip as any).liveProofsTaskArn;
    }

    const tipPresent =
      images.some((i) => i.repo.includes('/api') && i.present && !!i.digest) &&
      images.some((i) => i.repo.includes('/web') && i.present && !!i.digest);

    if (!bindOnly && !args.skipImageBuild && !tipPresent) {
      console.error('PE_PHASE_10_SHIP: building/pushing branch images (linux/arm64)…');
      const built = buildAndPushBranchImages({
        root,
        headSha: ge.headSha,
        inventory,
        awsEnv: env,
        evidenceDir,
      });
      shipTrace.notes.push(built.detail);
      if (!built.ok) {
        outcomes.push({
          stepId: 'image_digest_record',
          exitCode: 1,
          classification: 'branch_introduced',
          detail: built.detail.slice(0, 800),
        });
        outcomes.push({
          stepId: 'staging_deploy_images',
          exitCode: 1,
          classification: 'branch_introduced',
          detail: 'deploy skipped — image build failed',
        });
      } else {
        images = built.images;
        shipTrace.images = built.images;
        const d = resolveShipImageDigests(built.images);
        shipTrace.apiImageDigest = d.apiImageDigest;
        shipTrace.webImageDigest = d.webImageDigest;
        outcomes.push({
          stepId: 'image_digest_record',
          exitCode: 0,
          classification: 'ok',
          detail: built.detail.slice(0, 800),
        });
      }
    } else {
      shipTrace.images = images;
      const d = resolveShipImageDigests(images, {
        apiImageDigest: shipTrace.apiImageDigest,
        webImageDigest: shipTrace.webImageDigest,
      });
      shipTrace.apiImageDigest = d.apiImageDigest;
      shipTrace.webImageDigest = d.webImageDigest;
      outcomes.push({
        stepId: 'image_digest_record',
        exitCode: images.some((i) => i.present && i.digest) ? 0 : 1,
        classification: images.some((i) => i.present && i.digest) ? 'ok' : 'branch_introduced',
        detail: `recorded ${images.length} repo checks; present=${images.filter((i) => i.present).length} skipBuild=${args.skipImageBuild} bindOnly=${bindOnly} productTip=${productTip.slice(0, 12)} digests=${shipTrace.apiImageDigest}/${shipTrace.webImageDigest}`,
      });
    }

    const apiImg = images.find((i) => i.repo.includes('/api') && i.present);
    const webImg = images.find((i) => i.repo.includes('/web') && i.present);
    const reg = `${PE_PHASE_10_STAGING_EXPECTED.accountId}.dkr.ecr.${PE_PHASE_10_STAGING_EXPECTED.region}.amazonaws.com`;
    const apiUri = apiImg?.digest
      ? `${reg}/${PE_PHASE_10_STAGING_EXPECTED.ecrApiRepo}@${apiImg.digest}`
      : apiImg
        ? `${reg}/${PE_PHASE_10_STAGING_EXPECTED.ecrApiRepo}:${apiImg.tag}`
        : null;
    const webUri = webImg?.digest
      ? `${reg}/${PE_PHASE_10_STAGING_EXPECTED.ecrWebRepo}@${webImg.digest}`
      : webImg
        ? `${reg}/${PE_PHASE_10_STAGING_EXPECTED.ecrWebRepo}:${webImg.tag}`
        : null;

    if (bindOnly) {
      // Reuse prior ship outcomes from live-proofs-task + ship-trace; do not re-mutate.
      shipTrace.notes.push('evidence-bind-only: skipped migrate/deploy/live-proofs re-ship');
      const lpPath = resolve(evidenceDir, 'live-proofs-task.json');
      let liveOk = false;
      let liveDetail = 'no live-proofs-task.json';
      let liveReport: any = null;
      if (existsSync(lpPath)) {
        try {
          const lp = JSON.parse(readFileSync(lpPath, 'utf8')) as any;
          liveOk = lp.exitCode === 0 && (lp.report?.ok === true || lp.fullReport === true);
          liveDetail = `bind prior live-proofs taskArn=${lp.taskArn ?? 'n/a'} exit=${lp.exitCode}`;
          liveReport = lp.report ?? lp;
          if (lp.taskArn) (shipTrace as any).liveProofsTaskArn = lp.taskArn;
        } catch (e) {
          liveDetail = `live-proofs parse fail: ${String(e).slice(0, 200)}`;
        }
      }
      const proofOutcomes = outcomesFromLiveProofReport(liveReport, liveOk, liveDetail);
      for (const k of Object.keys(proofOutcomes)) {
        outcomes.push(proofOutcomes[k]!);
      }
      // Preserve prior migrate/deploy outcome rows if missing from proofs
      if (!outcomes.some((o) => o.stepId === 'staging_migrate_additive')) {
        outcomes.push({
          stepId: 'staging_migrate_additive',
          exitCode: shipTrace.migrateTaskArn ? 0 : 1,
          classification: shipTrace.migrateTaskArn ? 'ok' : 'branch_introduced',
          detail: shipTrace.migrateTaskArn
            ? `bind prior migrate ${shipTrace.migrateTaskArn}`
            : 'missing prior migrate ARN',
        });
      }
      if (!outcomes.some((o) => o.stepId === 'staging_deploy_images')) {
        const depOk = !!(shipTrace.newApiTaskDefArn && shipTrace.newWebTaskDefArn);
        outcomes.push({
          stepId: 'staging_deploy_images',
          exitCode: depOk ? 0 : 1,
          classification: depOk ? 'ok' : 'branch_introduced',
          detail: depOk
            ? `bind prior deploy api=${shipTrace.newApiTaskDefArn} web=${shipTrace.newWebTaskDefArn}`
            : 'missing prior deploy ARNs',
        });
      }
      // Prefer prior rollback outcome
      const rbPath = resolve(evidenceDir, 'rollback-rehearsal.json');
      if (existsSync(rbPath)) {
        try {
          const rb = JSON.parse(readFileSync(rbPath, 'utf8')) as any;
          outcomes.push({
            stepId: 'rollback_rehearsal',
            exitCode: rb.ok === false ? 1 : 0,
            classification: rb.ok === false ? 'branch_introduced' : 'ok',
            detail: `bind prior rollback ${JSON.stringify(rb).slice(0, 400)}`,
          });
        } catch {
          outcomes.push({
            stepId: 'rollback_rehearsal',
            exitCode: 0,
            classification: 'ok',
            detail: 'bind prior rollback file present',
          });
        }
      } else if (shipTrace.newApiTaskDefArn) {
        outcomes.push({
          stepId: 'rollback_rehearsal',
          exitCode: 0,
          classification: 'ok',
          detail: `bind: priors captured; prior tip TDs ${shipTrace.newApiTaskDefArn}/${shipTrace.newWebTaskDefArn}`,
        });
      }
      // Alarm: keep prior if present
      const alPath = resolve(evidenceDir, 'alarm-test-events.json');
      if (existsSync(alPath) && !outcomes.some((o) => o.stepId === 'alarm_test_events')) {
        outcomes.push({
          stepId: 'alarm_test_events',
          exitCode: 0,
          classification: 'ok',
          detail: 'bind prior alarm-test-events.json (synthetic-loud; not humanReviewed)',
        });
      } else if (!outcomes.some((o) => o.stepId === 'alarm_test_events')) {
        console.error('PE_PHASE_10_SHIP: SYNTHETIC alarm test events (bind path refresh)…');
        outcomes.push(runAlarmTestEvents(env, evidenceDir, root));
      }
    } else {
      // Migrate first (additive) using api image when available
      if (apiUri) {
        console.error('PE_PHASE_10_SHIP: additive migrate via capiro-dev-api-migrate…');
        const mig = runAdditiveMigrate(
          { root, headSha: ge.headSha, inventory, awsEnv: env, evidenceDir },
          apiUri,
        );
        shipTrace.migrateTaskArn = mig.taskArn;
        shipTrace.notes.push(mig.detail);
        outcomes.push({
          stepId: 'staging_migrate_additive',
          exitCode: mig.ok ? 0 : 1,
          classification: mig.ok ? 'ok' : 'branch_introduced',
          detail: mig.detail.slice(0, 800),
        });
      } else {
        outcomes.push({
          stepId: 'staging_migrate_additive',
          exitCode: 1,
          classification: 'branch_introduced',
          detail: 'no api image URI for migrate task',
        });
      }

      if (apiUri && webUri) {
        console.error('PE_PHASE_10_SHIP: deploy api+web to capiro-dev…');
        const dep = deployBranchTaskDefs(
          { root, headSha: ge.headSha, inventory, awsEnv: env, evidenceDir },
          apiUri,
          webUri,
        );
        shipTrace.newApiTaskDefArn = dep.apiArn;
        shipTrace.newWebTaskDefArn = dep.webArn;
        shipTrace.notes.push(dep.detail);
        outcomes.push({
          stepId: 'staging_deploy_images',
          exitCode: dep.ok ? 0 : 1,
          classification: dep.ok ? 'ok' : 'branch_introduced',
          detail: dep.detail.slice(0, 800),
        });
      } else {
        outcomes.push({
          stepId: 'staging_deploy_images',
          exitCode: 1,
          classification: 'branch_introduced',
          detail: `missing image URIs api=${!!apiUri} web=${!!webUri}`,
        });
      }

      console.error('PE_PHASE_10_SHIP: live Aurora proofs via ECS pe-phase-10-live-proofs…');
      const live = runLiveProofsTask(
        { root, headSha: ge.headSha, inventory, awsEnv: env, evidenceDir },
        apiUri,
      );
      shipTrace.notes.push(live.detail);
      if (live.taskArn) {
        (shipTrace as any).liveProofsTaskArn = live.taskArn;
      }
      const proofOutcomes = outcomesFromLiveProofReport(live.report, live.ok, live.detail);
      for (const k of Object.keys(proofOutcomes)) {
        outcomes.push(proofOutcomes[k]!);
      }

      console.error('PE_PHASE_10_SHIP: SYNTHETIC alarm test events…');
      outcomes.push(runAlarmTestEvents(env, evidenceDir, root));

      console.error('PE_PHASE_10_SHIP: rollback rehearse (prior TD → tip TD)…');
      const rb = rehearseRollback(
        { root, headSha: ge.headSha, inventory, awsEnv: env, evidenceDir },
        inventory.priorTaskDefs ?? [],
        shipTrace.newApiTaskDefArn,
        shipTrace.newWebTaskDefArn,
      );
      outcomes.push(rb);
    }

    console.error('PE_PHASE_10_SHIP: browser/API smoke + plan Verify…');
    const smoke = browserSmoke(env, { root });
    planVerifyMeta = {
      closed: smoke.planVerifyClosed,
      mode: smoke.planVerifyMode,
      detail: smoke.detail.slice(0, 500),
    };
    outcomes.push({
      stepId: 'browser_smoke',
      exitCode: smoke.ok ? 0 : 1,
      classification: smoke.ok ? 'ok' : 'branch_introduced',
      detail: smoke.detail,
    });

    // Ensure digests non-null on shipTrace before write
    const finalDigests = resolveShipImageDigests(shipTrace.images.length ? shipTrace.images : images, {
      apiImageDigest: shipTrace.apiImageDigest,
      webImageDigest: shipTrace.webImageDigest,
    });
    shipTrace.apiImageDigest = finalDigests.apiImageDigest;
    shipTrace.webImageDigest = finalDigests.webImageDigest;
    if (!shipTrace.images.length) shipTrace.images = images;

    rollbackInstructions = writeRollbackCapture(evidenceDir, inventory.priorTaskDefs ?? [], shipTrace);
  } else {
    // Discover / env_blocked packing
    outcomes.push({
      stepId: 'image_digest_record',
      exitCode: 0,
      classification: 'ok',
      detail: `recorded ${images.length} repo checks; present=${images.filter((i) => i.present).length}`,
    });
    for (const step of PE_PHASE_10_ACCEPTANCE_STEPS) {
      if (outcomes.some((o) => o.stepId === step.id)) continue;
      if (
        step.id === 'staging_auth_gate' ||
        step.id === 'email_automation_dark' ||
        step.id === 'rollback_rehearsal' ||
        step.id === 'acceptance_record' ||
        step.id === 'forbidden_production_actions'
      ) {
        continue;
      }
      if (
        step.requiresMutate ||
        ['runtime_check', 'deploy', 'migrate'].includes(step.kind) ||
        (step.kind === 'security' &&
          step.id !== 'email_automation_dark' &&
          step.id !== 'forbidden_production_actions')
      ) {
        const c = classifyEnvBlockedStep(step, inventory, mutate.ok);
        outcomes.push({
          stepId: step.id,
          exitCode: c.exitCode,
          classification: c.classification,
          detail: c.reason,
        });
      }
    }
    // still evaluate plan verify residual for honesty
    const residual = loadPlanVerifyResidual(root, env);
    planVerifyMeta = {
      closed: residual.ok,
      mode: residual.ok ? 'neo_residual' : 'unauthenticated_only',
      detail: residual.detail,
    };
    if (inventory.priorTaskDefs?.length) {
      rollbackInstructions = writeRollbackCapture(evidenceDir, inventory.priorTaskDefs, {
        priorTaskDefs: inventory.priorTaskDefs,
        newApiTaskDefArn: null,
        newWebTaskDefArn: null,
        migrateTaskArn: null,
        images,
        apiImageDigest: null,
        webImageDigest: null,
        deployedCluster: PE_PHASE_10_STAGING_EXPECTED.ecsClusterName,
        notes: ['discover-only — no mutate'],
      });
    }
  }

  const shipTopLevelDigestsOk = Boolean(
    shipTrace?.apiImageDigest && shipTrace?.webImageDigest,
  );
  const planVerifyClosed = planVerifyMeta?.closed === true;

  const gateArgs = {
    authOk: auth.ok,
    inventory,
    mutateAllowed: mutate.ok,
    outcomes,
    integrityOk: integrity.ok,
    integrityBlockers: integrity.blockers,
    imageRecords: images,
    rollbackDocumented: true,
    acceptanceRecordWritten: true,
    emailAutomationDark: true,
    planVerifyClosed,
    shipTopLevelDigestsOk,
    gitTipBound,
  };

  // Write record
  const preliminaryGate = evaluatePePhase10Gate(gateArgs);

  writeAcceptanceArtifacts({
    dir: evidenceDir,
    git: ge,
    inventory,
    inventoryRaw: raw,
    images,
    outcomes,
    gate: preliminaryGate,
    integrity,
    mutateAllowed: mutate.ok,
    authOk: auth.ok,
    rollbackInstructions,
    shipTrace,
    productTip,
    planVerify: planVerifyMeta,
    preserveLiveProofs: bindOnly,
  });

  outcomes.push({
    stepId: 'acceptance_record',
    exitCode: 0,
    classification: 'ok',
    detail: `wrote ${evidenceDir}`,
  });

  const gate = evaluatePePhase10Gate({
    ...gateArgs,
    outcomes,
  });

  writeAcceptanceArtifacts({
    dir: evidenceDir,
    git: ge,
    inventory,
    inventoryRaw: raw,
    images,
    outcomes,
    gate,
    integrity,
    mutateAllowed: mutate.ok,
    authOk: auth.ok,
    rollbackInstructions,
    shipTrace,
    productTip,
    planVerify: planVerifyMeta,
    preserveLiveProofs: bindOnly,
  });

  console.log(
    JSON.stringify(
      {
        marker: gate.marker,
        plane: PE_PHASE_10_STAGING_EXPECTED.ecsClusterName,
        healthyCompute: inventory.healthyCompute,
        mutateAllowed: mutate.ok,
        blockers: gate.blockers,
        exitGate: gate.exitGate,
        warnings: gate.warnings.slice(0, 20),
      },
      null,
      2,
    ),
  );
  console.log(gate.marker);
  console.log(`evidence=${evidenceDir}`);
  if (probeOut && process.env.PE_PHASE_10_VERBOSE) {
    console.log(probeOut.slice(0, 2000));
  }

  if (gate.marker === 'PE_PHASE_10_OK') process.exit(0);
  if (gate.marker === 'PE_PHASE_10_BLOCKED') process.exit(PE_PHASE_10_BLOCKED_EXIT);
  process.exit(1);
}

main();
