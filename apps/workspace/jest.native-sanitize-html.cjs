'use strict';

// Exact-specifier bridge only. The environment publishes the actual installed
// Workspace sanitizer; requiring it here would re-enter Jest's ESM-broken VM.
const sanitizeHtml = globalThis.__CAPIRO_JEST_NATIVE_SANITIZE_HTML__;
if (typeof sanitizeHtml !== 'function') {
  throw new Error('Workspace native sanitize-html export is missing; refusing a stub or fallback.');
}
module.exports = sanitizeHtml;
