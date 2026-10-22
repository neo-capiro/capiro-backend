// Sequential, restoring mutation check for every new mailbox-oauth.a1 case.
// Usage: node mutation-check.cjs <jest.js> <jest-config.cjs> <output-dir> [http]
// Requires a green unmodified suite. Never runs a live provider or a build.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const [jest, config, output, mode] = process.argv.slice(2);
const httpOnly = mode === 'http';
if (!jest || !config || !output)
  throw new Error('Expected Jest path, config path and output directory');
fs.mkdirSync(output, { recursive: true });
const base = 'apps/api/src/engagement/';
const helper = base + 'mailbox-oauth-authority.ts';
const ms = base + 'microsoft/microsoft-oauth.service.ts';
const graph = base + 'microsoft/microsoft-graph-sync.service.ts';
const google = base + 'google/google-oauth.service.ts';
const googleToken = base + 'google/google-token.service.ts';
const originals = new Map(
  [helper, ms, graph, google, googleToken].map((p) => [
    p,
    fs.readFileSync(path.join(root, p), 'utf8'),
  ]),
);
const change = (source, pattern, replacement) => {
  const result = source.replace(pattern, replacement);
  if (result === source) throw new Error(`Mutation did not match: ${pattern}`);
  return result;
};
const both = (fn) => [
  [ms, fn],
  [google, fn],
];
const mutants = [
  [
    'block-transient-recovery',
    [
      [
        helper,
        (s) =>
          change(
            s,
            "!['connected', 'error'].includes(connection.status)",
            "connection.status !== 'connected'",
          ),
      ],
    ],
  ],
  [
    'allow-reconnect-required-token',
    [[helper, (s) => change(s, "!['connected', 'error'].includes(connection.status)", 'false')]],
  ],
  [
    'skip-google-cached-token-admission',
    [
      [
        googleToken,
        (s) =>
          change(
            s,
            /    await this\.prisma\.withTenant\(tenantId, \(tx\) =>\s*admitMailboxRefresh\(tx, tenantId, connectionId, EngagementProvider\.google_workspace, token\),?\s*\);/,
            '    // mutation: use a cached Google token without admission',
          ),
      ],
    ],
  ],
  [
    'ignore-start-owner',
    both((s) => change(s, 'connection.createdByUserId !== ctx.userId', 'false')),
  ],
  [
    'reuse-existing-mailbox',
    both((s) =>
      change(
        s,
        'const connection = input.connectionId\n        ? await lockMailboxConnection(tx, ctx.tenantId, input.connectionId)',
        "const connection = (input.connectionId || 'connection-A')\n        ? await lockMailboxConnection(tx, ctx.tenantId, input.connectionId || 'connection-A')",
      ),
    ),
  ],
  [
    'discard-cursors',
    [
      [
        helper,
        (s) =>
          change(s, 'return rest as Prisma.InputJsonValue;', 'return {} as Prisma.InputJsonValue;'),
      ],
    ],
  ],
  [
    'permit-account-replacement',
    [[helper, (s) => change(s, "(state.i === 'reconnect' && state.h !== accountId)", 'false')]],
  ],
  [
    'ignore-registered-email',
    [
      [
        helper,
        (s) =>
          change(s, "(state.i === 'add' && state.a && state.a !== email.toLowerCase())", 'false'),
      ],
    ],
  ],
  ['ignore-duplicate-mailbox', [[helper, (s) => change(s, 'if (duplicate)', 'if (false)')]]],
  [
    'skip-preexchange-admission',
    both((s) =>
      change(
        s,
        /    await this\.prisma\.withTenant\(decoded\.t, \(tx\) =>\s*admitMailboxOAuthAttempt\(tx, decoded, EngagementProvider\.\w+, 'pending'\),?\s*\);/,
        '    // mutation: dispatch code exchange without current admission',
      ),
    ),
  ],
  [
    'skip-current-finalization',
    both((s) =>
      change(
        s,
        /await admitMailboxOAuthAttempt\(\s*tx,\s*(state|decoded),\s*EngagementProvider\.\w+,\s*'exchanging',?\s*\)/g,
        (_all, state) => `await lockMailboxConnection(tx, ${state}.t, ${state}.c)`,
      ),
    ),
  ],
  [
    'ignore-historical-lineage',
    both((s) =>
      change(
        s,
        /if \(input\.connectionId && !connection\.token\)\s*await assertUnboundMailboxIsFresh\(tx, connection\);/,
        '// mutation: permit rebinding history with a missing token',
      ),
    ),
  ],
  ['accept-state-suffix', both((s) => change(s, ' || extra !== undefined', ''))],
  [
    'wrong-account-cache-fallback',
    [
      [
        ms,
        (s) =>
          change(
            s,
            'return matched?.secret;',
            'return (matched ?? entries[entries.length - 1])?.secret;',
          ),
      ],
      [
        graph,
        (s) =>
          change(
            change(s, 'if (!homeAccountId) return undefined;', ''),
            'return matched?.secret;',
            'return (matched ?? entries[entries.length - 1])?.secret;',
          ),
      ],
    ],
  ],
  [
    'shared-refresh-client',
    [
      [
        graph,
        (s) =>
          change(
            s,
            'return new ConfidentialClientApplication(config);',
            'return ((this as any).__sharedMsal ??= new ConfidentialClientApplication(config));',
          ),
      ],
    ],
  ],
  [
    'ignore-returned-account-and-scopes',
    [
      [
        graph,
        (s) =>
          change(
            s,
            'if (result.account?.homeAccountId !== token.homeAccountId || !hasRequiredResourceScopes(result.scopes))',
            'if (false)',
          ),
      ],
    ],
  ],
  [
    'skip-refresh-outcome-fence',
    [
      [
        graph,
        (s) => {
          const at = s.indexOf('  private async persistRefreshedAccessToken(');
          return (
            s.slice(0, at) +
            change(
              s.slice(at),
              'await admitMailboxRefresh(tx, tenantId, connectionId, EngagementProvider.microsoft_365, snapshot);',
              '// mutation: allow stale refresh result',
            )
          );
        },
      ],
    ],
  ],
  [
    'skip-cached-token-admission',
    [
      [
        graph,
        (s) =>
          change(
            s,
            /    await this\.prisma\.withTenant\(tenantId, \(tx\) =>\s*admitMailboxRefresh\(tx, tenantId, connectionId, EngagementProvider\.microsoft_365, token\)\);/,
            '    // mutation: use cached token without current admission',
          ),
      ],
    ],
  ],
  [
    'lose-rotated-token',
    [
      [
        graph,
        (s) =>
          change(
            s,
            'const rotatedRefresh = this.extractRotatedRefreshToken(msal, snapshot.homeAccountId);',
            'const rotatedRefresh = undefined;',
          ),
      ],
    ],
  ],
  [
    'skip-google-refresh-outcome-fence',
    [
      [
        googleToken,
        (s) =>
          change(
            s,
            /      await admitMailboxRefresh\(\s*tx,\s*tenantId,\s*connectionId,\s*EngagementProvider\.google_workspace,\s*token,?\s*\);/,
            '      // mutation: persist a late Google refresh without fencing',
          ),
      ],
    ],
  ],
  [
    'skip-google-returned-identity',
    [
      [
        google,
        (s) =>
          change(
            s,
            /    const claims = this\.decodeIdToken\(token\.id_token\);\s*await this\.prisma\.withTenant\(decoded\.t, async \(tx\) => \{[\s\S]*?\n    \}\);/,
            '    const claims = this.decodeIdToken(token.id_token);',
          ),
      ],
    ],
  ],
];

const selectedMutants = httpOnly
  ? mutants.filter(([name]) =>
      [
        'ignore-start-owner',
        'skip-preexchange-admission',
        'skip-cached-token-admission',
        'skip-google-cached-token-admission',
        'block-transient-recovery',
        'allow-reconnect-required-token',
      ].includes(name),
    )
  : mutants;

const run = (name) => {
  const report = path.join(output, `${name}.json`);
  fs.rmSync(report, { force: true });
  const result = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=1024',
      jest,
      '--config',
      config,
      '--roots',
      './src',
      '--runInBand',
      '--runTestsByPath',
      'src/engagement/mailbox-oauth.a1.spec.ts',
      ...(httpOnly ? ['--testNamePattern', 'direct HTTP|transient sync error'] : []),
      'src/engagement/mailbox-oauth.a1.http.spec.ts',
      '--json',
      '--outputFile',
      report,
    ],
    { cwd: path.join(root, 'apps/api'), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  fs.writeFileSync(
    path.join(output, `${name}.log`),
    `${result.stdout ?? ''}${result.stderr ?? ''}`,
  );
  if (!fs.existsSync(report)) throw new Error(`${name}: Jest did not produce a report`);
  const parsed = JSON.parse(fs.readFileSync(report, 'utf8'));
  const assertions = parsed.testResults
    .flatMap((r) => r.assertionResults)
    .filter((t) => t.status !== 'pending');
  if (!assertions.length) throw new Error(`${name}: no tests collected`);
  return { status: result.status, parsed, assertions };
};

const baseline = run('green');
if (baseline.status !== 0 || baseline.parsed.numFailedTests)
  throw new Error('Unmodified suite is not green');
const killedByTest = new Map(baseline.assertions.map((t) => [t.fullName, []]));
const summary = [];
try {
  for (const [name, edits] of selectedMutants) {
    for (const [file, transform] of edits)
      fs.writeFileSync(path.join(root, file), transform(originals.get(file)));
    try {
      const result = run(name);
      const failed = result.assertions.filter((t) => t.status === 'failed');
      if (!failed.length || result.status === 0) throw new Error(`${name}: mutant survived`);
      for (const test of failed) killedByTest.get(test.fullName)?.push(name);
      summary.push({ mutant: name, killedBy: failed.map((t) => t.fullName) });
      process.stdout.write(`${name}: killed by ${failed.length} tests\n`);
    } finally {
      for (const [file] of edits) fs.writeFileSync(path.join(root, file), originals.get(file));
    }
  }
} finally {
  for (const [file, source] of originals) fs.writeFileSync(path.join(root, file), source);
  fs.writeFileSync(
    path.join(output, 'summary.json'),
    JSON.stringify(
      {
        tests: baseline.assertions.length,
        mutants: summary,
        coverage: Object.fromEntries(killedByTest),
      },
      null,
      2,
    ),
  );
}
const uncovered = [...killedByTest].filter(([, killed]) => !killed.length).map(([name]) => name);
if (uncovered.length) throw new Error(`New tests without a killed mutant: ${uncovered.join('; ')}`);
process.stdout.write(`All ${baseline.assertions.length} new cases killed a relevant mutant.\n`);
