// Jest 29 cannot parse this installed dependency's transitive ESM package.
// Delegate only this unchanged npm package to Node 24's actual CJS/ESM loader.
// No sanitizer replacement, dependency install, or product source edit.
module.exports = require('node:module').createRequire(require('node:path').resolve(__dirname, '../../../apps/api/package.json'))('sanitize-html');
