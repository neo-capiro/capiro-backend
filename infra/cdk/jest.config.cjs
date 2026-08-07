/**
 * The FIRST test runner this package has had.
 *
 * infra/cdk shipped with zero tests before P16 — no jest, no ts-jest, no
 * "test" script. That is a real gap, not a deliberate choice this config
 * preserves: CDK stacks are exactly the kind of code where a synthesized
 * CloudFormation template can be silently wrong (a secret on the wrong task, an
 * HTTP URL where HTTPS was required) with no runtime signal until deployment.
 * P16 needed to prove "the key is absent from serve/migrate containers and
 * present only in sync when configured" against a REAL synthesized template,
 * not a source-level guess, so this had to exist before that proof could.
 */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
};
