const c = require('/workspace/capirov2-review-memory-wording/apps/api/jest.config.cjs');
c.rootDir = '/workspace/capirov2-review-memory-wording/apps/api';
Object.values(c.transform).forEach(t => { if (t[0] === 'ts-jest') t[1].isolatedModules = true; });
module.exports = c;
