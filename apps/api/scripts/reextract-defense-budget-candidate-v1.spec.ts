import {
  assertReextractionEnvironmentV1,
  parseReextractionArgsV1,
  reextractionExitCodeV1,
  reextractionRuntimeConfigSha256V1,
} from './reextract-defense-budget-candidate-v1.js';

const operationId = '11111111-1111-4111-8111-111111111111';
const releaseRevision = 'abcdef0123456789abcdef0123456789abcdef01';
const values: Record<string, string> = {
  '--operation-id': operationId,
  '--outbox-row-id': '22222222-2222-4222-8222-222222222222',
  '--old-candidate-id': '33333333-3333-4333-8333-333333333333',
  '--expected-old-verification-run-id': '44444444-4444-4444-8444-444444444444',
  '--expected-source-sha256': 'a'.repeat(64),
  '--expected-old-extraction-artifact-sha256': 'b'.repeat(64),
  '--actor': 'operator@example.test',
  '--reason-file': '/tmp/operator-reason.txt',
  '--expected-release-revision': releaseRevision,
  '--env': 'production',
};

function argv(overrides: Record<string, string> = {}): string[] {
  return Object.entries({ ...values, ...overrides }).flatMap(([flag, value]) => [flag, value]);
}

function actionOptions(extra: string[] = []) {
  const options = parseReextractionArgsV1([...argv(), ...extra]);
  if (options.mode !== 'preview' && options.mode !== 'commit') throw new Error('Expected extraction options');
  return options;
}

const abandonValues: Record<string, string> = {
  '--operation-id': operationId,
  '--env': 'production',
  '--actor': 'operator@example.test',
  '--reason-file': '/tmp/operator-reason.txt',
};

function abandonArgv(overrides: Record<string, string> = {}): string[] {
  return ['--abandon-expired', ...Object.entries({ ...abandonValues, ...overrides }).flat()];
}

function abandonOptions(extra: string[] = []) {
  const options = parseReextractionArgsV1([...abandonArgv(), ...extra]);
  if (options.mode !== 'abandon_expired') throw new Error('Expected abandonment options');
  return options;
}

describe('parseReextractionArgsV1', () => {
  it('defaults to preview and preserves the explicitly named source and old candidate bindings', () => {
    expect(parseReextractionArgsV1(argv({ '--actor': '  operator@example.test  ' }))).toEqual({
      mode: 'preview',
      environment: 'production',
      reasonFile: '/tmp/operator-reason.txt',
      request: {
        operationId,
        outboxRowId: values['--outbox-row-id'],
        oldCandidateId: values['--old-candidate-id'],
        expectedOldVerificationRunId: values['--expected-old-verification-run-id'],
        expectedSourceSha256: values['--expected-source-sha256'],
        expectedOldExtractionArtifactSha256: values['--expected-old-extraction-artifact-sha256'],
        actor: 'operator@example.test',
        releaseRevision,
      },
    });
  });

  it('requires an explicit commit flag and retains its environment confirmation', () => {
    expect(parseReextractionArgsV1([...argv(), '--commit', '--confirm', 'production'])).toMatchObject({
      mode: 'commit', environment: 'production', confirm: 'production',
    });
  });

  it.each([
    { confirmation: [] },
    { confirmation: ['--confirm', 'staging'] },
    { confirmation: ['--confirm', 'Production'] },
  ])(
    'rejects commit without an exact environment confirmation: $confirmation', ({ confirmation }) => {
      expect(() => parseReextractionArgsV1([...argv(), '--commit', ...confirmation])).toThrow();
    },
  );

  it('accepts a status lookup using only its operation ID', () => {
    expect(parseReextractionArgsV1(['--status', '--operation-id', operationId])).toEqual({
      mode: 'status', operationId,
    });
  });

  it.each(Object.keys(values))('rejects omission of required action flag %s', omitted => {
    const incomplete = Object.entries(values).filter(([flag]) => flag !== omitted).flat();
    expect(() => parseReextractionArgsV1(incomplete)).toThrow();
  });

  it.each(Object.entries(values))('rejects a duplicate %s even when values agree', (flag, value) => {
    expect(() => parseReextractionArgsV1([...argv(), flag, value])).toThrow();
  });

  it.each([
    ['unknown flag', ['--force']],
    ['unknown valued flag', ['--dry-run', 'false']],
    ['positional argument', ['production']],
    ['equals syntax that could bypass validation', ['--commit=true']],
    ['explicit boolean value', ['--commit', 'false']],
    ['repeated commit', ['--commit', '--commit']],
    ['repeated confirmation', ['--confirm', 'production', '--confirm', 'production']],
    ['missing final value', ['--confirm']],
    ['flag consumed as a value', ['--confirm', '--commit']],
  ])('rejects %s', (_name, extra) => {
    expect(() => parseReextractionArgsV1([...argv(), ...extra])).toThrow();
  });

  it.each([
    ['missing operation ID', ['--status']],
    ['missing operation ID value', ['--status', '--operation-id']],
    ['invalid operation ID', ['--status', '--operation-id', 'latest']],
    ['duplicate status', ['--status', '--status', '--operation-id', operationId]],
    ['mixed commit', ['--status', '--operation-id', operationId, '--commit']],
    ['mixed environment', ['--status', '--operation-id', operationId, '--env', 'production']],
    ['mixed action request', [...argv(), '--status']],
  ])('rejects status with %s', (_name, input) => {
    expect(() => parseReextractionArgsV1(input)).toThrow();
  });

  it.each([
    '--operation-id', '--outbox-row-id', '--old-candidate-id', '--expected-old-verification-run-id',
  ])('rejects malformed UUID in %s', flag => {
    expect(() => parseReextractionArgsV1(argv({ [flag]: 'not-a-uuid' }))).toThrow();
  });

  it.each(['--expected-source-sha256', '--expected-old-extraction-artifact-sha256'])(
    'requires a full lowercase SHA-256 in %s', flag => {
      for (const value of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)]) {
        expect(() => parseReextractionArgsV1(argv({ [flag]: value }))).toThrow();
      }
    },
  );

  it.each(['UNVERIFIED', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40)])(
    'rejects invalid release revision %s', value => {
      expect(() => parseReextractionArgsV1(argv({ '--expected-release-revision': value }))).toThrow();
    },
  );

  it.each(['--actor', '--reason-file', '--env'])('rejects an empty %s', flag => {
    expect(() => parseReextractionArgsV1(argv({ [flag]: '   ' }))).toThrow();
  });
});

describe('expired-operation abandonment arguments', () => {
  it('defaults to a preview of the named operation without extraction or release bindings', () => {
    expect(parseReextractionArgsV1(abandonArgv({ '--actor': '  operator@example.test  ' }))).toEqual({
      mode: 'abandon_expired', commit: false, operationId, environment: 'production',
      actor: 'operator@example.test', reasonFile: '/tmp/operator-reason.txt',
    });
  });

  it('requires explicit commit and exact environment confirmation to close an operation', () => {
    expect(abandonOptions(['--commit', '--confirm', 'production'])).toMatchObject({
      mode: 'abandon_expired', commit: true, confirm: 'production',
    });
  });

  it.each(Object.keys(abandonValues))('requires %s', omitted => {
    const incomplete = Object.entries(abandonValues).filter(([flag]) => flag !== omitted).flat();
    expect(() => parseReextractionArgsV1(['--abandon-expired', ...incomplete])).toThrow();
  });

  it.each(Object.entries(abandonValues))('rejects a repeated %s', (flag, value) => {
    expect(() => parseReextractionArgsV1([...abandonArgv(), flag, value])).toThrow();
  });

  it.each([
    '--outbox-row-id', '--old-candidate-id', '--expected-old-verification-run-id',
    '--expected-source-sha256', '--expected-old-extraction-artifact-sha256', '--expected-release-revision',
  ])('rejects extraction-only flag %s', flag => {
    expect(() => parseReextractionArgsV1([...abandonArgv(), flag, values[flag]!])).toThrow();
  });

  it.each([
    { extra: ['--status'] },
    { extra: ['--abandon-expired'] },
    { extra: ['--commit'] },
    { extra: ['--confirm', 'production'] },
    { extra: ['--commit', '--confirm', 'staging'] },
    { extra: ['--commit', '--confirm', 'Production'] },
    { extra: ['--commit', '--confirm', 'production', '--commit'] },
    { extra: ['--commit', '--confirm', 'production', '--confirm', 'production'] },
    { extra: ['--force'] },
    { extra: ['--commit=true'] },
    { extra: ['--commit', 'false'] },
  ])('rejects incompatible or bypass flags: $extra', ({ extra }) => {
    expect(() => parseReextractionArgsV1([...abandonArgv(), ...extra])).toThrow();
  });

  it('rejects a malformed operation UUID', () => {
    expect(() => parseReextractionArgsV1(abandonArgv({ '--operation-id': 'latest' }))).toThrow();
  });

  it.each(['--actor', '--reason-file', '--env'])('rejects empty %s', flag => {
    expect(() => parseReextractionArgsV1(abandonArgv({ [flag]: '   ' }))).toThrow();
  });

  it('applies the same actor length limit as extraction', () => {
    expect(() => parseReextractionArgsV1(abandonArgv({ '--actor': 'a'.repeat(256) }))).not.toThrow();
    expect(() => parseReextractionArgsV1(abandonArgv({ '--actor': 'a'.repeat(257) }))).toThrow();
  });
});

describe('assertReextractionEnvironmentV1', () => {
  it('allows a status lookup without action environment, release, or parser settings', () => {
    const options = parseReextractionArgsV1(['--status', '--operation-id', operationId]);
    expect(() => assertReextractionEnvironmentV1(options, {})).not.toThrow();
  });

  it('accepts preview only with matching environment and real runtime release', () => {
    expect(() => assertReextractionEnvironmentV1(actionOptions(), {
      APP_ENV: 'production', GIT_SHA: releaseRevision,
    })).not.toThrow();
  });

  it('uses NODE_ENV when APP_ENV is absent', () => {
    expect(() => assertReextractionEnvironmentV1(actionOptions(), {
      NODE_ENV: 'production', GIT_SHA: releaseRevision,
    })).not.toThrow();
  });

  it('does not let a matching NODE_ENV override a different APP_ENV', () => {
    expect(() => assertReextractionEnvironmentV1(actionOptions(), {
      APP_ENV: 'staging', NODE_ENV: 'production', GIT_SHA: releaseRevision,
    })).toThrow();
  });

  it.each([undefined, 'staging', 'Production'])('rejects absent or mismatched environment %s', APP_ENV => {
    expect(() => assertReextractionEnvironmentV1(actionOptions(), { APP_ENV, GIT_SHA: releaseRevision })).toThrow();
  });

  it.each([undefined, 'UNVERIFIED', 'a'.repeat(40), releaseRevision.toUpperCase(), releaseRevision.slice(0, 7)])(
    'rejects absent, unverified, malformed, or mismatched runtime revision %s', GIT_SHA => {
      expect(() => assertReextractionEnvironmentV1(actionOptions(), { APP_ENV: 'production', GIT_SHA })).toThrow();
    },
  );

  it('accepts commit only with the matching environment confirmation', () => {
    expect(() => assertReextractionEnvironmentV1(actionOptions(['--commit', '--confirm', 'production']), {
      APP_ENV: 'production', GIT_SHA: releaseRevision,
    })).not.toThrow();
  });

  it.each([undefined, 'staging', 'Production'])('rejects commit confirmation %s', confirm => {
    // Construct the options directly so this verifies the runtime guard independently of parsing.
    const options = { ...actionOptions(), mode: 'commit' as const, confirm };
    expect(() => assertReextractionEnvironmentV1(options, {
      APP_ENV: 'production', GIT_SHA: releaseRevision,
    })).toThrow();
  });
});

describe('expired-operation abandonment environment guard', () => {
  it.each([undefined, 'UNVERIFIED', 'a'.repeat(40)])(
    'allows abandonment preview without a matching extraction release: %s', GIT_SHA => {
      expect(() => assertReextractionEnvironmentV1(abandonOptions(), {
        APP_ENV: 'production', GIT_SHA,
      })).not.toThrow();
    },
  );

  it('allows committed abandonment without a release when the environment is confirmed', () => {
    expect(() => assertReextractionEnvironmentV1(abandonOptions(['--commit', '--confirm', 'production']), {
      APP_ENV: 'production',
    })).not.toThrow();
  });

  it('falls back to NODE_ENV when APP_ENV is absent', () => {
    expect(() => assertReextractionEnvironmentV1(abandonOptions(), { NODE_ENV: 'production' })).not.toThrow();
  });

  it('does not let NODE_ENV bypass a mismatched APP_ENV', () => {
    expect(() => assertReextractionEnvironmentV1(abandonOptions(), {
      APP_ENV: 'staging', NODE_ENV: 'production',
    })).toThrow();
  });

  it.each([undefined, 'staging', 'Production'])('rejects absent or mismatched actual environment %s', APP_ENV => {
    expect(() => assertReextractionEnvironmentV1(abandonOptions(), { APP_ENV })).toThrow();
  });

  it.each([undefined, 'staging', 'Production'])('independently rejects commit confirmation %s', confirm => {
    const options = { ...abandonOptions(), commit: true, confirm };
    expect(() => assertReextractionEnvironmentV1(options, { APP_ENV: 'production' })).toThrow();
  });
});

describe('reextractionRuntimeConfigSha256V1', () => {
  it('ignores insertion order and surrounding whitespace of nonsecret settings', () => {
    const first = reextractionRuntimeConfigSha256V1({
      BUDGET_PARSER_TIMEOUT_MS: ' 30000 ', DEFENSE_BUDGET_OCR_ENABLED: ' true ', AWS_REGION: ' us-west-2 ',
    });
    const second = reextractionRuntimeConfigSha256V1({
      AWS_REGION: 'us-west-2', DEFENSE_BUDGET_OCR_ENABLED: 'true', BUDGET_PARSER_TIMEOUT_MS: '30000',
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(second);
  });

  it('hashes the effective default AWS region', () => {
    expect(reextractionRuntimeConfigSha256V1({})).toBe(reextractionRuntimeConfigSha256V1({ AWS_REGION: 'us-east-1' }));
    expect(reextractionRuntimeConfigSha256V1({})).not.toBe(reextractionRuntimeConfigSha256V1({ AWS_REGION: 'us-west-2' }));
  });

  it('excludes secrets and unrelated process settings', () => {
    const settings = { BUDGET_PARSER_TIMEOUT_MS: '30000' };
    expect(reextractionRuntimeConfigSha256V1({
      ...settings,
      BUDGET_API_KEY: 'first-secret', DEFENSE_BUDGET_TOKEN: 'second-secret', BUDGET_PASSWORD: 'third-secret',
      AWS_SECRET_ACCESS_KEY: 'fourth-secret', DATABASE_URL: 'postgres://private', PATH: '/different/path',
    })).toBe(reextractionRuntimeConfigSha256V1(settings));
  });

  it.each(['BUDGET_PARSER_TIMEOUT_MS', 'DEFENSE_BUDGET_OCR_ENABLED'])(
    'changes when effective nonsecret configuration %s changes', key => {
      expect(reextractionRuntimeConfigSha256V1({ [key]: 'one' })).not.toBe(
        reextractionRuntimeConfigSha256V1({ [key]: 'two' }),
      );
    },
  );
});

describe('reextractionExitCodeV1', () => {
  it('returns zero for a successful preview', () => {
    expect(reextractionExitCodeV1({ outcome: 'preview', operation: null })).toBe(0);
  });

  it.each(['PASS', 'REVIEW'])('returns zero for completed persisted %s', verifierDecision => {
    expect(reextractionExitCodeV1({ outcome: 'completed', operation: { terminal: { verifierDecision } } })).toBe(0);
  });

  it('makes a completed REJECT visible to shell callers', () => {
    expect(reextractionExitCodeV1({
      outcome: 'completed', operation: { terminal: { verifierDecision: 'REJECT' } },
    })).toBe(4);
  });

  it.each(['busy', 'blocked', 'conflict', 'ineligible', 'failed', 'unknown'])(
    'returns a refusal code for %s', outcome => {
      expect(reextractionExitCodeV1({ outcome, operation: null })).toBe(3);
    },
  );

  it.each([null, { terminal: null }, { terminal: {} }, { terminal: { verifierDecision: 'UNKNOWN' } }])(
    'does not report success for completion without an established decision: %j', operation => {
      expect(reextractionExitCodeV1({ outcome: 'completed', operation })).toBe(3);
    },
  );
});
