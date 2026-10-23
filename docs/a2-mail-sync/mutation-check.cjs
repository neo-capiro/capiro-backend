const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '../..');
const prefix = 'apps/api/src/engagement/';
const google = prefix + 'google/google-sync.service.ts';
const microsoft = prefix + 'microsoft/microsoft-graph-sync.service.ts';
const token = prefix + 'google/google-token.service.ts';
const policy = prefix + 'mail-sync-failure.ts';
const base = 'ca4de503fb6ec09caf0daf8b976a0f649c6b9665';
const mutations = [
  ...[[google, 'google_workspace|Google quota'], [microsoft, 'microsoft_365|Microsoft']]
    .map(([file, pattern]) => ({
      name: file === google ? 'google-swallowed-error' : 'microsoft-swallowed-error',
      file, pattern,
      from: `await this.markSyncError(tenantId, connectionId, err${file === microsoft ? ', { holdMailboxAbsence: true }' : ''});\n      throw err;`,
      to: `await this.markSyncError(tenantId, connectionId, err${file === microsoft ? ', { holdMailboxAbsence: true }' : ''});\n      return { connectionId };`,
    })),
  {
    name: 'reconnect-becomes-transient', file: policy,
    pattern: 'invalid grant|mailbox-not-enabled|typed|missing-identity|wrong-identity|missing-scopes|missing refresh',
    from: "const requiresReconnect = kind === 'needs_reconnect' || kind === 'mailbox_not_enabled';",
    to: 'const requiresReconnect = false;',
  },
  {
    name: 'terminal-retry-hint', file: policy,
    pattern: 'invalid grant|mailbox-not-enabled|missing refresh',
    from: 'nextSyncAt: requiresReconnect ? null : new Date(Date.now() + 15 * 60 * 1000)',
    to: 'nextSyncAt: new Date(Date.now() + 15 * 60 * 1000)',
  },
  ...[google, microsoft].map(file => ({
    name: file === google ? 'google-clobbers-held-state' : 'microsoft-clobbers-held-state',
    file, pattern: 'late transient failure cannot overwrite',
    from: "where: { id: connectionId, status: { in: ['connected', 'error'] } }",
    to: 'where: { id: connectionId }',
  })),
  {
    name: 'ignore-typed-consent', file: microsoft, pattern: 'typed',
    from: "if (['invalid_grant', 'interaction_required', 'consent_required', 'login_required'].includes(code))",
    to: 'if (false)',
  },
  {
    name: 'resource-denial-becomes-reconnect-hold', file: policy,
    pattern: 'resource permission|access-token expiry',
    from: "const requiresReconnect = kind === 'needs_reconnect' || kind === 'mailbox_not_enabled';",
    to: "const requiresReconnect = kind !== 'transient';",
  },
  {
    name: 'calendar-window-inherits-mailbox-hold', file: microsoft,
    pattern: 'calendar-window mailbox absence',
    from: "options.holdMailboxAbsence && err instanceof Error && err.message.includes('MailboxNotEnabledForRESTAPI')",
    to: "err instanceof Error && err.message.includes('MailboxNotEnabledForRESTAPI')",
  },
];

// Mutate only the compiler input. Tracked files are never rewritten, including
// while another reviewer reads this worktree. Import/compiler failures do not
// count as killed mutants.
module.exports.createTransformer = (options) => {
  const transformer = require(require.resolve('ts-jest', { paths: [path.join(repo, 'apps/api')] }))
    .default.createTransformer(options);
  const original = transformer.process.bind(transformer);
  transformer.process = (source, filename, settings) => {
    const relative = path.relative(repo, filename).replace(/\\/g, '/');
    const mode = process.env.A2_MAIL_MUTATION;
    if (mode?.startsWith('exact-base-') && [google, microsoft, token].includes(relative)) {
      source = execFileSync('git', ['show', `${base}:${relative}`], { cwd: repo, encoding: 'utf8' });
    }
    const mutation = mutations.find(candidate => candidate.name === mode);
    if (mutation?.file === relative) {
      if (!source.includes(mutation.from)) throw new Error(`Mutation target missing: ${mode}`);
      source = source.replace(mutation.from, mutation.to);
    }
    return original(source, filename, settings);
  };
  return transformer;
};

if (require.main === module) {
  const evidence = path.resolve(process.argv[2] || path.join(repo, '.tmp/a2-mail-mutations'));
  fs.mkdirSync(evidence, { recursive: true });
  const config = require('./jest.config.cjs');
  const [expression, [, options]] = Object.entries(config.transform)[0];
  config.testMatch = ['**/mail-sync-reconnect.a2.spec.ts'];
  config.transform = { [expression]: [__filename, options] };
  const checks = [...mutations,
    { name: 'exact-base-red-check', pattern: 'invalid grant remains', expectFailure: true },
    { name: 'exact-base-regressions', pattern: 'late resource permission|access-token expiry', expectedPassed: 4 },
    { name: 'exact-base-calendar-window', pattern: 'calendar-window mailbox absence', expectedPassed: 2 },
  ];
  const results = [];
  for (const check of checks) {
    const reportPath = path.join(evidence, `${check.name}.json`);
    const run = spawnSync(process.execPath, [
      path.join(repo, 'apps/api/node_modules/jest/bin/jest.js'),
      '--config', JSON.stringify(config), '--runInBand', '--testNamePattern', check.pattern,
      '--json', '--outputFile', reportPath,
    ], { cwd: repo, encoding: 'utf8', env: { ...process.env, A2_MAIL_MUTATION: check.name } });
    fs.writeFileSync(path.join(evidence, `${check.name}.log`), run.stdout + run.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const failures = report.testResults.flatMap(suite => suite.assertionResults)
      .filter(test => test.status === 'failed').map(test => test.fullName);
    results.push({ name: check.name, exitCode: run.status, passed: report.numPassedTests,
      failed: report.numFailedTests, assertionFailures: failures });
    fs.writeFileSync(path.join(evidence, 'mutation-summary.json'), JSON.stringify(results, null, 2) + '\n');
    console.log(`${check.name}: ${report.numPassedTests} passed; ${failures.length} assertion failures`);
    const expectFailure = check.expectedPassed === undefined;
    if (report.numRuntimeErrorTestSuites || (expectFailure
      ? !failures.length || run.status !== 1
      : failures.length || run.status !== 0 || report.numPassedTests !== check.expectedPassed)) {
      throw new Error(`Unexpected mutation/base comparison result: ${check.name}`);
    }
  }
}
