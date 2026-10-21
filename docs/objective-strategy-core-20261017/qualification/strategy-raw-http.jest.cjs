const base = require('./core-integration.jest.cjs');
module.exports = {
  ...base,
  // This receiving checkout includes historical package manifests under docs.
  // Limit discovery to this suite; imported current source still resolves normally.
  roots: ['<rootDir>/apps/api-strategy/src/bootstrap'],
  testMatch: ['<rootDir>/apps/api-strategy/src/bootstrap/objective-generation-raw-body.int.spec.ts'],
};
