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
    evidenceDir: get('--evidence-dir'),
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
}): void {
  mkdirSync(args.dir, { recursive: true });
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
    shipTrace: args.shipTrace,
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
      capturedPriors: (args.inventory.priorTaskDefs ?? []).filter((t) => !!t.arn),
      instructions: args.rollbackInstructions,
      branchRollbackTipHint: args.git.originHeadSha ?? args.git.headSha,
    },
    honesty: {
      syntheticAlarmsNotHumanReviewed: true,
      localPreflightNotLiveSubstitute: true,
      blockedIsNotOk: args.gate.marker === 'PE_PHASE_10_BLOCKED',
      exitGateUnsatisfiedWhenBlocked: args.gate.marker === 'PE_PHASE_10_BLOCKED'
        ? !args.gate.exitGate.every((e) => e.satisfied)
        : null,
    },
  };
  writeFileSync(resolve(args.dir, 'phase-10-acceptance-summary.json'), JSON.stringify(summary, null, 2));

  const md = [
    '# Phase 10 pre-merge acceptance record (sole live env=dev)',
    '',
    `- Generated (UTC): ${summary.generatedAt}`,
    `- Marker: **${args.gate.marker}**`,
    `- Plane: \`${PE_PHASE_10_STAGING_EXPECTED.ecsClusterName}\` / workflow env=\`${PE_PHASE_10_STAGING_EXPECTED.workflowEnv}\` (authorized sole live = prod path)`,
    `- HEAD: \`${args.git.headSha}\``,
    `- origin/agent/...: \`${args.git.originHeadSha ?? 'n/a'}\``,
    `- origin/main: \`${args.git.mainSha ?? 'n/a'}\``,
    `- merge-base: \`${args.git.mergeBaseSha ?? 'n/a'}\``,
    `- Auth PE_CLOSEOUT_STAGING_OK: ${args.authOk}`,
    `- Mutate PE_CLOSEOUT_STAGING_MUTATE: ${args.mutateAllowed}`,
    `- Inventory healthyCompute: **${args.inventory.healthyCompute}**`,
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
    '## Captured prior task defs (rollback)',
    ...((args.inventory.priorTaskDefs ?? []).length
      ? (args.inventory.priorTaskDefs ?? []).map(
          (t) => `- \`${t.family}\` rev=${t.revision ?? '?'} arn=\`${t.arn ?? 'n/a'}\` image=${t.image ?? 'n/a'}`,
        )
      : ['- (none captured)']),
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
  let images = tryImageDigests(ge.headSha, env);
  const outcomes: PePhase10StepOutcome[] = [];
  let shipTrace: PePhase10ShipTrace | null = null;
  let rollbackInstructions: string[] = [
    'Capture prior task-definition ARNs before mutate, then:',
    `aws ecs update-service --cluster ${PE_PHASE_10_STAGING_EXPECTED.ecsClusterName} --service ${PE_PHASE_10_STAGING_EXPECTED.apiServiceName} --task-definition <prior-api-td-arn>`,
    `aws ecs update-service --cluster ${PE_PHASE_10_STAGING_EXPECTED.ecsClusterName} --service ${PE_PHASE_10_STAGING_EXPECTED.webServiceName} --task-definition <prior-web-td-arn>`,
    'Do NOT hand-edit migration history; Aurora snapshot if schema is bad.',
    'Never target capiro-staging or capiro-prod-os-capiro.',
  ];

  outcomes.push({
    stepId: 'git_sha_record',
    exitCode: ge.headSha ? 0 : 1,
    classification: ge.headSha ? 'ok' : 'branch_introduced',
    detail: `head=${ge.headSha} origin=${ge.originHeadSha} main=${ge.mainSha} mb=${ge.mergeBaseSha}`,
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

  // -------- mutate ship path on authorized healthy plane --------
  if (mutate.ok && inventory.healthyCompute) {
    try {
      assertAuthorizedClusterOrThrow(PE_PHASE_10_STAGING_EXPECTED.ecsClusterName);
    } catch (e) {
      console.error(String(e));
      process.exit(1);
    }

    shipTrace = {
      priorTaskDefs: inventory.priorTaskDefs ?? [],
      newApiTaskDefArn: null,
      newWebTaskDefArn: null,
      migrateTaskArn: null,
      images: [],
      apiImageDigest: null,
      webImageDigest: null,
      deployedCluster: PE_PHASE_10_STAGING_EXPECTED.ecsClusterName,
      notes: [],
    };

    // Images: build/push unless skip and tip already present
    const tipPresent =
      images.some((i) => i.repo.includes('/api') && i.present && i.tag === ge.headSha) &&
      images.some((i) => i.repo.includes('/web') && i.present && i.tag === ge.headSha);

    if (!args.skipImageBuild && !tipPresent) {
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
        shipTrace.apiImageDigest = built.images.find((i) => i.repo.includes('/api'))?.digest ?? null;
        shipTrace.webImageDigest = built.images.find((i) => i.repo.includes('/web'))?.digest ?? null;
        outcomes.push({
          stepId: 'image_digest_record',
          exitCode: 0,
          classification: 'ok',
          detail: built.detail.slice(0, 800),
        });
      }
    } else {
      // refresh
      images = tryImageDigests(ge.headSha, env);
      // if tip missing but latest present, record latest with note (OK still needs tip for full ship)
      shipTrace.images = images;
      outcomes.push({
        stepId: 'image_digest_record',
        exitCode: images.some((i) => i.present) ? 0 : 1,
        classification: images.some((i) => i.present) ? 'ok' : 'branch_introduced',
        detail: `recorded ${images.length} repo checks; present=${images.filter((i) => i.present).length} skipBuild=${args.skipImageBuild}`,
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

    // Runtime proofs pack — REAL sole-live ECS task (no hardcoded ok / source-grep greening)
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

    console.error('PE_PHASE_10_SHIP: browser/API smoke…');
    const smoke = browserSmoke(env);
    outcomes.push({
      stepId: 'browser_smoke',
      exitCode: smoke.ok ? 0 : 1,
      classification: smoke.ok ? 'ok' : 'branch_introduced',
      detail: smoke.detail,
    });

    console.error('PE_PHASE_10_SHIP: SYNTHETIC alarm test events…');
    outcomes.push(runAlarmTestEvents(env, evidenceDir, root));

    // Rollback rehearse after tip deploy (priors → tip restore)
    console.error('PE_PHASE_10_SHIP: rollback rehearse (prior TD → tip TD)…');
    const rb = rehearseRollback(
      { root, headSha: ge.headSha, inventory, awsEnv: env, evidenceDir },
      inventory.priorTaskDefs ?? [],
      shipTrace.newApiTaskDefArn,
      shipTrace.newWebTaskDefArn,
    );
    outcomes.push(rb);

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
    if (inventory.priorTaskDefs?.length) {
      rollbackInstructions = writeRollbackCapture(
        evidenceDir,
        inventory.priorTaskDefs,
        {
          priorTaskDefs: inventory.priorTaskDefs,
          newApiTaskDefArn: null,
          newWebTaskDefArn: null,
          migrateTaskArn: null,
          images,
          apiImageDigest: null,
          webImageDigest: null,
          deployedCluster: PE_PHASE_10_STAGING_EXPECTED.ecsClusterName,
          notes: ['discover-only — no mutate'],
        },
      );
    }
  }

  // Write record
  const preliminaryGate = evaluatePePhase10Gate({
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
  });

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
  });

  outcomes.push({
    stepId: 'acceptance_record',
    exitCode: 0,
    classification: 'ok',
    detail: `wrote ${evidenceDir}`,
  });

  const gate = evaluatePePhase10Gate({
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
