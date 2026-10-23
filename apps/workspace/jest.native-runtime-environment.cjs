'use strict';

// Jest loads environments with native Node require, outside the per-suite VM.
// Anchor both resolutions to this Workspace importer, never to Core's install.
const path = require('node:path');
const { createRequire } = require('node:module');
const workspaceRequire = createRequire(path.join(__dirname, 'package.json'));
const jestRequire = createRequire(workspaceRequire.resolve('jest/package.json'));
const { TestEnvironment: NodeEnvironment } = jestRequire('jest-environment-node');
const sanitizeHtml = workspaceRequire('sanitize-html');
if (typeof NodeEnvironment !== 'function' || typeof sanitizeHtml !== 'function') {
  throw new Error('Workspace native environment requires real Jest and sanitize-html exports.');
}

const SANITIZE_GLOBAL_KEY = '__CAPIRO_JEST_NATIVE_SANITIZE_HTML__';
class WorkspaceNativeRuntimeEnvironment extends NodeEnvironment {
  constructor(config, context) {
    super(config, context);
    Object.defineProperty(this.global, SANITIZE_GLOBAL_KEY, {
      configurable: true, enumerable: false, writable: false, value: sanitizeHtml,
    });
  }

  async teardown() {
    try {
      if (this.global) delete this.global[SANITIZE_GLOBAL_KEY];
    } finally {
      await super.teardown();
    }
  }
}

module.exports = WorkspaceNativeRuntimeEnvironment;
