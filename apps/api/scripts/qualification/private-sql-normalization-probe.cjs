const assert = require('node:assert/strict');

// Qualification delegates to the same compiled owner that gates the private DB
// reader. No alternate normalization implementation or permissive fallback.
function assertPrivateSqlNormalizationRuntime(appRequire) {
  const owner = appRequire('./dist/meri/analytics/private-sql-normalization-runtime.js');
  const { PRIVATE_SQL_NORMALIZATION_PINS: pins } = appRequire('./dist/meri/analytics/private-sql-normalization-pins.js');
  assert.equal(owner.privateSqlNormalizationVersionMatches(process.versions), true,
    'private SQL normalization runtime tuple differs from canonical pins');
  assert.equal(owner.privateSqlNormalizationRuntimeAdmitted(), true,
    'private SQL normalization behavior differs from canonical pins');
  return {
    versions: Object.fromEntries(Object.keys(pins.versions).map(key => [key, process.versions[key]])),
    expectedVersions: pins.versions,
    expectedBehaviorSha256: pins.behaviorSha256,
    canonicalOwnerAdmitted: true,
  };
}

module.exports = { assertPrivateSqlNormalizationRuntime };
