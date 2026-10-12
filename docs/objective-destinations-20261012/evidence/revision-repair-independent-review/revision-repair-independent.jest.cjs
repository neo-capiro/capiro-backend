const path = require('node:path');
const base = require('../independent-review/objective-independent.jest.cjs');
module.exports = { ...base,
  roots: [...base.roots, path.resolve(__dirname)],
};
