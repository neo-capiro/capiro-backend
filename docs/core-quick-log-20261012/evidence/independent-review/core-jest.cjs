const c = require('/workspace/capirov2-review-quicklog/apps/api/jest.config.cjs');
c.rootDir = '/workspace/capirov2-review-quicklog/apps/api';
Object.values(c.transform).forEach(t => { if (t[0] === 'ts-jest') t[1].isolatedModules = true; });
module.exports = c;
