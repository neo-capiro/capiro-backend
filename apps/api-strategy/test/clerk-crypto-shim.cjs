// Jest-only stand-in for @clerk/backend's internal `#crypto` subpath import
// (dist/runtime/node/crypto.js). That file is resolved in production via the
// package's `imports` map (Node honors it for private "#" specifiers even
// though the path isn't publicly `exports`-ed), but jest-resolve applies the
// `exports` restriction to moduleNameMapper substitution targets, so pointing
// straight at the real file 404s under jest. The real file is one line —
// mirrored here so DI-graph specs can construct ClerkService.
module.exports.webcrypto = require('node:crypto').webcrypto;
