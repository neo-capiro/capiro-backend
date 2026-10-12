const path = require('node:path');
const config = require('./focused.jest.cjs');
module.exports = { ...config, roots: [path.join(config.rootDir, 'apps/api'), path.join(config.rootDir, 'packages/shared')] };
