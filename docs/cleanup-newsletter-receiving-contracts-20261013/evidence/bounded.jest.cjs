module.exports = {
 rootDir: process.env.NEWSLETTER_SOURCE_TEST_ROOT || '/tmp/capirov2-four-runtime-controls-review',
 roots: ['<rootDir>/apps/api/src/engagement'],
 testMatch: ['**/newsletter-outreach-admission.spec.ts'],
 testEnvironment: 'node', setupFiles: [], cache: false,
 modulePathIgnorePatterns: ['<rootDir>/apps/api/src/engagement/engagement\\.service\\.ts$'],
 transform: { '^.+\\.tsx?$': [require.resolve('ts-jest', {paths:['/workspace/capirov2/apps/api']}), { diagnostics: false, tsconfig: { target: 'ES2022', module: 'commonjs', esModuleInterop: true, isolatedModules: true } }] },
 moduleNameMapper: { '^typescript$': '/workspace/capirov2/node_modules/typescript' },
};
