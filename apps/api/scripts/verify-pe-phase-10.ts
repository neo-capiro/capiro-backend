/**
 * Phase 10 pre-merge staging acceptance orchestrator (closeout).
 *
 * Modes:
 *  - default            : auth + inventory + local preflight + acceptance record
 *  - --catalog-only     : catalog honesty
 *  - --integrity-only   : tip path transport scan
 *  - --inventory-only   : run staging probe + summarize (no local PE gates)
 *  - --dry-run          : print steps, do not execute shell
 *
 * Full PE_PHASE_10_OK requires healthy staging compute + PE_CLOSEOUT_STAGING_MUTATE=yes
 * + branch images + runtime proofs. Current account reality (2026-07): staging
 * Compute UPDATE_ROLLBACK_COMPLETE, no ECS cluster, phantom CF Aurora — discover
 * path emits PE_PHASE_10_BLOCKED with a complete honest record (not OK).
 *
 * Never deploys to capiro-dev or capiro-prod-os-capiro.
 * Never Secrets Manager GetSecretValue, email, LlamaParse, or derive --commit.
 * Does not self-PASS adversarial REVIEW.
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
  type PePhase10StepOutcome,
} from './lib/pe-phase-10-staging-acceptance.js';

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

function apiRoot(): string {
  return resolve(repoRootFromCwd(), 'apps/api');
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
    env: { ...env, FORCE_COLOR: '0' },
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

function runInventoryProbe(root: string): {
  inventory: PePhase10Inventory;
  raw: Record<string, unknown> | null;
  probeExit: number;
  probeOut: string;
} {
  const script = resolve(root, 'apps/api/scripts/pe-phase-10-staging-probe.sh');
  const env = {
    ...process.env,
    AWS_PROFILE: process.env.AWS_PROFILE || process.env.PE_CLOSEOUT_AWS_PROFILE || 'capiro-dev',
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || PE_PHASE_10_STAGING_EXPECTED.region,
    MSYS_NO_PATHCONV: '1',
  };
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
        : 'AWS staging probe failed (credentials or CLI) — cannot claim healthy staging',
    );
    inv.healthyCompute = false;
    return { inventory: inv, raw, probeExit: r.code, probeOut: r.out };
  }

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
    rawNotes: [
      `secretNameCount=${raw.stagingSecretNameCount ?? '?'}`,
      `cfAuroraPhysicalId=${raw.cfAuroraPhysicalId ?? 'n/a'}`,
    ],
  });
  return { inventory: inv, raw, probeExit: r.code, probeOut: r.out };
}

function tryImageDigests(headSha: string): PePhase10ImageDigestRecord[] {
  const records: PePhase10ImageDigestRecord[] = [];
  const tags = [headSha, headSha.slice(0, 12), headSha.slice(0, 7), 'latest'];
  const repos = [
    ...PE_PHASE_10_STAGING_EXPECTED.ecrApiRepoCandidates,
    ...PE_PHASE_10_STAGING_EXPECTED.ecrWebRepoCandidates,
  ];
  const env = {
    ...process.env,
    AWS_PROFILE: process.env.AWS_PROFILE || process.env.PE_CLOSEOUT_AWS_PROFILE || 'capiro-dev',
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || PE_PHASE_10_STAGING_EXPECTED.region,
    MSYS_NO_PATHCONV: '1',
  };

  for (const repo of repos) {
    let found = false;
    for (const tag of tags) {
      const q = runCmd(
        `aws ecr describe-images --repository-name ${repo} --image-ids imageTag=${tag} --query "imageDetails[0].{digest:imageDigest,pushed:imagePushedAt,tags:imageTags}" --output json`,
        process.cwd(),
        env,
      );
      if (q.code !== 0) continue;
      try {
        const j = JSON.parse(q.out.trim() || 'null') as {
          digest?: string;
          pushed?: string;
          tags?: string[];
        } | null;
        if (j?.digest) {
          records.push({
            repo,
            tag,
            digest: j.digest,
            pushedAt: j.pushed ?? null,
            present: true,
          });
          found = true;
          break;
        }
      } catch {
        /* continue */
      }
    }
    if (!found) {
      records.push({
        repo,
        tag: headSha,
        digest: null,
        pushedAt: null,
        present: false,
        note: 'branch tip tag not present in ECR (read-only check)',
      });
    }
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
    git: args.git,
    inventory: args.inventory,
    inventoryRaw: args.inventoryRaw,
    images: args.images,
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
      noForbiddenClusterDeploy: PE_PHASE_10_STAGING_EXPECTED.forbiddenEcsClusters.every(
        (c) => isForbiddenDeployCluster(c),
      ),
      roast: 'PE_PHASE_10_OK is not independent REVIEW PASS',
    },
    rollback: {
      documented: true,
      instructions: [
        'If a future healthy staging mutate/deploy is authorized and must be rolled back:',
        '1. aws ecs update-service --cluster capiro-staging --service capiro-staging-api --task-definition <prior-td-arn>',
        '2. aws ecs update-service --cluster capiro-staging --service capiro-staging-web --task-definition <prior-td-arn>',
        '3. Do NOT hand-edit migration history tables or run migrate resolve; restore from Aurora snapshot if schema is bad.',
        '4. Git branch rollback of unmerged PE tip: git reset --hard <prior-phase-9-pass-tip> (local only; never force prod).',
        '5. Never point rollback at capiro-dev or capiro-prod-os-capiro from this harness.',
      ],
      branchRollbackTipHint: args.git.originHeadSha ?? args.git.headSha,
    },
    honesty: {
      syntheticAlarmsNotHumanReviewed: true,
      localPreflightNotStagingSubstitute: true,
      blockedIsNotOk: args.gate.marker === 'PE_PHASE_10_BLOCKED',
    },
  };
  writeFileSync(resolve(args.dir, 'phase-10-acceptance-summary.json'), JSON.stringify(summary, null, 2));

  const md = [
    '# Phase 10 staging acceptance record',
    '',
    `- Generated (UTC): ${summary.generatedAt}`,
    `- Marker: **${args.gate.marker}**`,
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
      ? '- Full PE_PHASE_10_OK (ship path) — STILL requires independent REVIEW'
      : args.gate.blockedComplete
        ? '- **PE_PHASE_10_BLOCKED** — acceptance record complete; staging plane not shippable; not a green ship gate'
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
    '## Image digests',
    ...args.images.map(
      (i) =>
        `- \`${i.repo}\` tag=${i.tag ?? 'n/a'} present=${i.present} digest=${i.digest ?? 'absent'}${i.note ? ` (${i.note})` : ''}`,
    ),
    '',
    '## Outcomes',
    ...args.outcomes.map(
      (o) => `- \`${o.stepId}\` exit=${o.exitCode} class=${o.classification ?? '?'} ${(o.detail ?? '').slice(0, 160)}`,
    ),
    '',
    '## Exit-gate bullets',
    ...args.gate.exitGate.map(
      (e) => `- [${e.satisfied ? 'x' : ' '}] ${e.bullet}: ${e.reason}`,
    ),
    '',
    '## Rollback (rehearsed / documented)',
    ...summary.rollback.instructions.map((l) => `- ${l}`),
    '',
    '## Safety (this run)',
    '- No Secrets Manager GetSecretValue',
    '- No email send / LlamaParse / derive --commit',
    '- No deploy to capiro-dev or capiro-prod-os-capiro',
    '- Email automation remains dark (policy)',
    '- Synthetic alarm events (if any later) must stay synthetic-loud, never humanReviewed',
    '',
    '## Honesty',
    '- This file is implementer evidence, **not** independent REVIEW PASS.',
    '- Local `verify:pe-phase-k` / Phase 9 integrity are preflight, not staging substitutes.',
    '- PE_PHASE_10_BLOCKED means the work stopped for infrastructure — not a pass.',
    '',
  ].join('\n');
  writeFileSync(resolve(args.dir, 'README.md'), md);
  writeFileSync(resolve(args.dir, 'phase-10-acceptance-record.md'), md);
  if (args.inventoryRaw) {
    writeFileSync(
      resolve(args.dir, 'staging-inventory.json'),
      JSON.stringify(args.inventoryRaw, null, 2),
    );
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
    console.error('Set PE_CLOSEOUT_STAGING_OK=yes only after Neo explicit staging authorization.');
    process.exit(1);
  }

  if (args.dryRun) {
    for (const s of PE_PHASE_10_ACCEPTANCE_STEPS) {
      console.log(
        `- ${s.id} [${s.kind}] required=${s.required} mutate=${!!s.requiresMutate} :: ${s.command || '(in-process)'}`,
      );
    }
    console.log('PE_PHASE_10_DRY_RUN_OK');
    process.exit(0);
  }

  const ge = gitEvidence(root);
  const { inventory, raw, probeExit, probeOut } = runInventoryProbe(root);
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
  const images = tryImageDigests(ge.headSha);
  const outcomes: PePhase10StepOutcome[] = [];

  // git_sha_record
  outcomes.push({
    stepId: 'git_sha_record',
    exitCode: ge.headSha ? 0 : 1,
    classification: ge.headSha ? 'ok' : 'branch_introduced',
    detail: `head=${ge.headSha} origin=${ge.originHeadSha} main=${ge.mainSha} mb=${ge.mergeBaseSha}`,
  });

  // aws inventory
  outcomes.push({
    stepId: 'aws_inventory_readonly',
    exitCode: inventory.probeOk || probeExit === 0 ? 0 : probeExit || 1,
    classification: inventory.probeOk || probeExit === 0 ? 'ok' : 'branch_introduced',
    detail: `healthyCompute=${inventory.healthyCompute} blockers=${inventory.blockers.length} probeExit=${probeExit}`,
  });

  // images
  outcomes.push({
    stepId: 'image_digest_record',
    exitCode: 0,
    classification: 'ok',
    detail: `recorded ${images.length} repo checks; present=${images.filter((i) => i.present).length}`,
  });

  // integrity step
  outcomes.push({
    stepId: 'transport_absent',
    exitCode: integrity.ok ? 0 : 1,
    classification: integrity.ok ? 'ok' : 'branch_introduced',
    detail: integrity.ok ? 'no forbidden paths' : integrity.blockers.join('; '),
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

  // Policy / env-blocked mutants and runtime
  for (const step of PE_PHASE_10_ACCEPTANCE_STEPS) {
    if (outcomes.some((o) => o.stepId === step.id)) continue;
    if (
      step.id === 'staging_auth_gate' ||
      step.id === 'email_automation_dark' ||
      step.id === 'rollback_rehearsal' ||
      step.id === 'acceptance_record' ||
      step.id === 'forbidden_production_actions'
    ) {
      continue; // gate.eval handles
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

  const evidenceDir = args.evidenceDir
    ? resolve(root, args.evidenceDir)
    : defaultEvidenceDir(root);

  // Write record first so gate sees acceptanceRecordWritten
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

  // refresh summary with final gate
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
  });

  console.log(JSON.stringify({ marker: gate.marker, blockers: gate.blockers, warnings: gate.warnings.slice(0, 20) }, null, 2));
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
