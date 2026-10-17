const base = require('./core-integration.jest.cjs');
module.exports = {
  ...base,
  testMatch: ['<rootDir>/apps/api-strategy/src/bootstrap/objective-generation-raw-body.int.spec.ts'],
};
