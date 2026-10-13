const fs = require('node:fs');
const original = fs.readFileSync;
const overlay = process.env.NEWSLETTER_ADMISSION_OVERLAY_SOURCE;
if (!overlay) throw new Error('Explicit inert source overlay is required');
const bytes = original(overlay, 'utf8');
fs.readFileSync = function(path, ...args) {
 if (/[/\\]engagement[/\\]newsletter-outreach\.service\.ts$/.test(String(path))) return bytes;
 return original.call(this, path, ...args);
};
