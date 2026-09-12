const base = require('./jest.config.cjs');
// Focused behavioral run; the API's separate tsc gate still checks all types.
module.exports = { ...base, transform: { ...base.transform, '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', isolatedModules: true, diagnostics: false }] } };
