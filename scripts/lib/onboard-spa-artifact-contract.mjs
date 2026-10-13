import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Static byte/closure qualification only; this does not qualify Onboard flows. */
export const ONBOARD_PUBLIC_ASSETS = Object.freeze({
  'favicon.svg': '6b853e45dfd9c0b5de548d2d1fa779330c09f6cda89f52c1d1bf6b3ca44904c4',
  'legal-docs/Capiro-Subscription-Agreement.pdf': '2ae1437094f9310c9e9cf49c71aa1725e06823c02fba6cb546d40e3cedd33ff5',
  'legal-docs/Capiro-Terms-of-Service.pdf': '94e03031d00eaf759c7e55795aa89edfa5429bf667c3ce9f975f8f2b69b6d5d2',
});
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => { throw new Error(`Onboard SPA artifact refused: ${message}`); };
const objectKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

function pinsContract(pins) {
  if (!pins || ['manifestSha256', 'sourceCommit', 'sourceRepository'].some((key) =>
    typeof pins[key] !== 'string' || !pins[key] || pins[key].trim() !== pins[key] || /[\s\u0000-\u001f\u007f]/.test(pins[key])) ||
      !/^[a-f0-9]{64}$/.test(pins.manifestSha256) ||
      !/^[a-f0-9]{40}$/.test(pins.sourceCommit ?? '') ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(pins.sourceRepository ?? '')) {
    fail('explicit manifest SHA256, source repository and source commit are required');
  }
}

function safePath(value) {
  if (typeof value !== 'string' || /[\s\u0000-\u001f\u007f]/.test(value) || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
      value.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.')) ||
      !/\.(?:html|js|mjs|css|pdf|svg|ico|png|jpe?g|gif|webp|avif|woff2?|ttf|otf|eot|json|wasm|mp4|webm|map)$/.test(value)) {
    fail(`unsafe static file path: ${value}`);
  }
  return value;
}

function parseManifest(bytes, pins) {
  pinsContract(pins);
  if (!Buffer.isBuffer(bytes) || digest(bytes) !== pins.manifestSha256) fail('manifest SHA256 mismatch');
  let manifest;
  const text = bytes.toString('utf8');
  try { manifest = JSON.parse(text); } catch { fail('malformed or truncated manifest'); }
  // JSON.parse permits repeated keys; the digest-bound contract refuses ambiguity.
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' || text[i] === '[') stack.push(text[i] === '{' ? new Set() : null);
    else if (text[i] === '}' || text[i] === ']') stack.pop();
    else if (text[i] === '"') {
      const start = i++;
      for (; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      const key = JSON.parse(text.slice(start, i + 1));
      if (/^\s*:/.test(text.slice(i + 1)) && stack.at(-1)) {
        if (stack.at(-1).has(key)) fail('duplicate manifest key');
        stack.at(-1).add(key);
      }
    }
  }
  if (!objectKeys(manifest, ['schemaVersion', 'artifactType', 'source', 'files']) ||
      manifest.schemaVersion !== 1 || manifest.artifactType !== 'capiro-onboard-static-spa' ||
      !objectKeys(manifest.source, ['repository', 'commit']) ||
      manifest.source.repository !== pins.sourceRepository || manifest.source.commit !== pins.sourceCommit ||
      !Array.isArray(manifest.files) || manifest.files.length === 0) fail('manifest/source identity contract');
  const seen = new Set();
  for (const file of manifest.files) {
    if (!objectKeys(file, ['path', 'bytes', 'sha256']) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 ||
        !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) fail('malformed file proof');
    safePath(file.path);
    if (seen.has(file.path)) fail(`duplicate file proof: ${file.path}`);
    seen.add(file.path);
  }
  if (!seen.has('index.html')) fail('index.html is required');
  return manifest;
}

function referencePath(from, reference, kind) {
  if (!reference || /[\s\\\0]/.test(reference) || /%/.test(reference)) fail(`unsafe ${kind} reference in ${from}`);
  if (reference.startsWith('#')) return null;
  if (/^data:(?:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)|font\/[^;,]+)[;,]/i.test(reference) && kind !== 'module') return null;
  if (/^https?:\/\//i.test(reference) && kind !== 'module') return null; // remote behavior remains unqualified
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference) || reference.startsWith('//')) fail(`unsafe ${kind} reference in ${from}`);
  const path = reference.split(/[?#]/, 1)[0];
  if (!path) return null;
  if (kind === 'module' && !path.startsWith('/') && !path.startsWith('./') && !path.startsWith('../')) {
    fail(`unbundled module reference in ${from}: ${reference}`);
  }
  const local = path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(from), path);
  return safePath(local);
}

/** Conservative static linkage: no evaluation of HTML, JavaScript or CSS. */
function resourceReferences(path, text) {
  const refs = [];
  const add = (value, kind = 'asset') => refs.push([value, kind]);
  if (/\.(?:html|svg)$/.test(path)) {
    for (const match of text.matchAll(/<(script|link|img|source|video|audio|iframe|input|object|embed|image|use)\b([^>]*)>/gi)) {
      const attrs = new Map();
      for (const attr of match[2].matchAll(/\b(src|href|poster|data|srcset|type|rel)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
        if (attrs.has(attr[1].toLowerCase())) fail(`duplicate resource attribute in ${path}`);
        attrs.set(attr[1].toLowerCase(), attr[2] ?? attr[3] ?? attr[4]);
      }
      for (const attr of ['src', 'href', 'poster', 'data']) {
        if (attrs.has(attr)) add(attrs.get(attr), match[1].toLowerCase() === 'script' ? 'module' : 'asset');
      }
      if (attrs.has('srcset')) {
        for (const entry of attrs.get('srcset').split(',')) add(entry.trim().split(/\s+/)[0]);
      }
    }
    for (const match of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) refs.push(...resourceReferences('inline.js', match[1]));
    for (const match of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) refs.push(...resourceReferences(path + '.css', match[1]));
    refs.push(...resourceReferences(path + '.css', text)); // includes inline style attributes
    // Public download links are resources; application navigation is a browser-flow obligation.
    for (const match of text.matchAll(/\bhref\s*=\s*["']([^"']+\.(?:pdf|svg|ico)(?:[?#][^"']*)?)["']/gi)) add(match[1]);
  }
  // Token separators may contain comments; quoted reference bytes are never stripped.
  const cssTrivia = String.raw`(?:\s|\/\*[\s\S]*?\*\/)*`;
  const jsTrivia = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*`;
  if (path.endsWith('.css')) {
    for (const match of text.matchAll(new RegExp(String.raw`\burl${cssTrivia}\(${cssTrivia}(?:"([^"]+)"|'([^']+)'|([^\s)]+))${cssTrivia}\)`, 'gi'))) add(match[1] ?? match[2] ?? match[3]);
    for (const match of text.matchAll(new RegExp(String.raw`@import\b${cssTrivia}["']([^"']+)["']`, 'gi'))) add(match[1]);
  }
  if (/\.(?:m?js)$/.test(path)) {
    for (const match of text.matchAll(new RegExp(String.raw`\b(?:import|export)\b${jsTrivia}(?:[^;'"()]*?\bfrom\b${jsTrivia})?["']([^"']+)["']`, 'g'))) add(match[1], 'module');
    const literal = new RegExp(String.raw`^${jsTrivia}(["'])([^"']+)\1${jsTrivia}$`);
    const imports = new Set();
    for (const match of text.matchAll(new RegExp(String.raw`\bimport\b${jsTrivia}\(([^)]*)\)`, 'g'))) {
      imports.add(match.index);
      const value = literal.exec(match[1]);
      if (!value) fail(`nonstatic module reference in ${path}`);
      add(value[2], 'module');
    }
    for (const match of text.matchAll(new RegExp(String.raw`\bimport\b${jsTrivia}\(`, 'g'))) {
      if (!imports.has(match.index)) fail(`unsupported module reference in ${path}`);
    }
    const urls = new Set();
    for (const match of text.matchAll(new RegExp(String.raw`\bnew\b${jsTrivia}URL\b${jsTrivia}\(([^)]*),${jsTrivia}import\b${jsTrivia}\.${jsTrivia}meta\b${jsTrivia}\.${jsTrivia}url\b${jsTrivia}\)`, 'g'))) {
      urls.add(match.index);
      const value = literal.exec(match[1]);
      if (!value) fail(`nonstatic asset reference in ${path}`);
      add(value[2]);
    }
    for (const match of text.matchAll(new RegExp(String.raw`\bnew\b${jsTrivia}URL\b${jsTrivia}\(`, 'g'))) {
      if (!urls.has(match.index)) fail(`unsupported asset reference in ${path}`);
    }
    // Covers emitted Vite dependency/asset tables as well as direct public asset paths.
    for (const match of text.matchAll(/["']((?:\.?\.?\/|assets\/)[^"'\\\s]+\.(?:js|mjs|css|pdf|svg|ico|png|jpe?g|gif|webp|avif|woff2?|ttf|otf|eot|json|wasm|mp4|webm)(?:[?#][^"'\\\s]*)?)["']/gi)) {
      add(match[1].startsWith('assets/') ? '/' + match[1] : match[1]);
    }
  }
  return refs;
}

export function validateOnboardSpaArtifact({ manifestBytes, files }, pins) {
  const manifest = parseManifest(manifestBytes, pins);
  if (!(files instanceof Map) || files.size !== manifest.files.length) fail('file inventory mismatch');
  const expected = new Set(manifest.files.map((file) => file.path));
  for (const path of files.keys()) if (!expected.has(safePath(path))) fail(`unlisted file: ${path}`);
  for (const file of manifest.files) {
    const bytes = files.get(file.path);
    if (!Buffer.isBuffer(bytes) || bytes.length !== file.bytes || digest(bytes) !== file.sha256) fail(`file proof mismatch: ${file.path}`);
  }
  for (const [path, sha256] of Object.entries(ONBOARD_PUBLIC_ASSETS)) {
    if (!files.has(path) || digest(files.get(path)) !== sha256) fail(`original public asset missing or changed: /${path}`);
  }
  const index = files.get('index.html').toString('utf8');
  if (!/<!doctype\s+html\s*>/i.test(index) || !/<html\b/i.test(index) || !/<\/html\s*>/i.test(index) ||
      !/<body\b/i.test(index) || !/<\/body\s*>/i.test(index) || !/<script\b[^>]*\bsrc\s*=/i.test(index)) fail('static application shell is incomplete');
  for (const [path, bytes] of files) {
    if (!/\.(?:html|m?js|css|svg)$/.test(path)) continue;
    for (const [reference, kind] of resourceReferences(path, bytes.toString('utf8'))) {
      const target = referencePath(path, reference, kind);
      if (target && !files.has(target)) fail(`missing ${kind} closure: ${path} -> ${reference}`);
    }
  }
  return { receipt: 'ONBOARD_STATIC_SPA_ARTIFACT_VALIDATED', manifestSha256: pins.manifestSha256,
    source: manifest.source, files: files.size, qualification: 'static-byte-contract-only' };
}

/** All filesystem effects are ports; every ancestor is checked before reads. */
export function readOnboardSpaArtifact(directory, pins, ports = { lstatSync, readdirSync, readFileSync }) {
  pinsContract(pins);
  if (typeof directory !== 'string' || !directory || directory.includes('\0')) fail('artifact directory is required');
  const root = resolve(directory);
  const check = (path, type) => {
    const ancestors = [];
    for (let current = path; ; current = dirname(current)) {
      ancestors.unshift(current);
      if (dirname(current) === current) break;
    }
    for (const current of ancestors) {
      const stat = ports.lstatSync(current);
      if (stat.isSymbolicLink() || !(current === path && type === 'file' ? stat.isFile() : stat.isDirectory())) fail(`unsafe filesystem entry: ${current}`);
    }
  };
  check(root, 'directory');
  if (ports.readdirSync(root).sort().join(',') !== 'manifest.json,site') fail('artifact root must contain only manifest.json and site');
  const manifestPath = join(root, 'manifest.json'); check(manifestPath, 'file');
  const manifestBytes = ports.readFileSync(manifestPath);
  const manifest = parseManifest(manifestBytes, pins);
  const expected = new Set(manifest.files.map((file) => file.path));
  const dirs = new Set();
  for (const file of expected) {
    for (let path = posix.dirname(file); path !== '.'; path = posix.dirname(path)) dirs.add(path);
  }
  const files = new Map();
  const walk = (path, relative = '') => {
    check(path, 'directory');
    for (const name of ports.readdirSync(path)) {
      if (typeof name !== 'string' || /[\s\u0000-\u001f\u007f]/.test(name) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) fail('unsafe filesystem name');
      const file = relative ? `${relative}/${name}` : name;
      const absolute = join(path, name);
      const stat = ports.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail(`symbolic artifact entry: ${file}`);
      if (stat.isDirectory()) {
        if (!dirs.has(file)) fail(`unlisted directory: ${file}`);
        walk(absolute, file);
      } else {
        if (!expected.has(file)) fail(`unlisted file: ${file}`);
        check(absolute, 'file');
        files.set(file, ports.readFileSync(absolute));
      }
    }
  };
  walk(join(root, 'site'));
  return validateOnboardSpaArtifact({ manifestBytes, files }, pins);
}

export function parseOnboardSpaArtifactInvocation(args) {
  const names = new Map([['--artifact-dir', 'directory'], ['--manifest-sha256', 'manifestSha256'],
    ['--source-repository', 'sourceRepository'], ['--source-commit', 'sourceCommit']]);
  const options = {};
  if (!Array.isArray(args) || args.length !== 8) fail('provide all four named arguments exactly once');
  for (let i = 0; i < args.length; i += 2) {
    const key = names.get(args[i]); const value = args[i + 1];
    if (!key || options[key] !== undefined || typeof value !== 'string' || !value || value.trim() !== value || /[\0\r\n]/.test(value)) fail('malformed or duplicate invocation');
    options[key] = value;
  }
  pinsContract(options);
  return options;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseOnboardSpaArtifactInvocation(process.argv.slice(2));
    console.log(JSON.stringify(readOnboardSpaArtifact(options.directory, options)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
