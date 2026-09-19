#!/usr/bin/env node
/**
 * Meri/Hermes Phase 0 — schema inventory generator ("comprehensive data access" workstream).
 *
 * Parses every application-owned Prisma schema with a small hand-written parser (no
 * dependencies beyond Node builtins), classifies each model with the Phase 0 heuristics
 * (scope / sensitivity / kind / existingReadPath / decryptionRequired) and writes:
 *
 *   docs/meri/hermes/phase-0/data-inventory.json           full machine-readable inventory
 *   docs/meri/hermes/phase-0/data-inventory.md             human summary + coverage-gap list
 *   docs/meri/hermes/phase-0/data-inventory.baseline.json  model list keyed by owner+name
 *                                                          (written when missing, or with --write-baseline)
 *
 * Usage:
 *   node scripts/meri-hermes/generate-data-inventory.mjs                  regenerate json + md
 *   node scripts/meri-hermes/generate-data-inventory.mjs --write-baseline  also (re)write the baseline
 *   node scripts/meri-hermes/generate-data-inventory.mjs --check           write nothing; exit 1 if any
 *       model has `unknown` scope, or a canonical/business model with no read path is NEW vs. the baseline
 *
 * Only schema METADATA is emitted — never data values. All classification is heuristic and
 * requires owner review; field-level policy annotation is Phase 2A work.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, 'docs', 'meri', 'hermes', 'phase-0');
const OUT_JSON = join(OUT_DIR, 'data-inventory.json');
const OUT_MD = join(OUT_DIR, 'data-inventory.md');
const OUT_BASELINE = join(OUT_DIR, 'data-inventory.baseline.json');
const GIT_COMMIT_HINT = process.env.GIT_COMMIT_HINT || '19a1834ac'; // no git calls from this script
const SCHEMA_SEARCH_ROOTS = ['apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.turbo', 'coverage']);

/** Read-path sources. Matching is case-insensitive WHOLE-WORD containment (see readPathsFor). */
const READ_PATH_SOURCES = {
  meri_tool: [
    { file: 'packages/shared/src/index.ts', mode: 'registry_descriptions' },
    { file: 'apps/api/src/meri/meri-tools.service.ts', mode: 'accessor_or_table' },
  ],
  retrieval_adapter: [{ dir: 'apps/api/src/retrieval/adapters', glob: /\.ts$/, exclude: /\.spec\.ts$/, mode: 'any' }],
  analytics_registry: [{ file: 'apps/api/src/meri/analytics/global-dataset-registry.ts', mode: 'any' }],
};

// Classification regexes — kept verbatim from the Phase 0 brief so the output is reproducible.
const RX_CREDENTIAL = /token|secret|password|passwd|apikey|api_key|privatekey|encrypted|cipher|nonce|signing/i;
const RX_PII = /email|phone|address|ssn|dob|birth/i;
const RX_SYSTEM = /outbox|queue|job|lease|audit|log|migration|checkpoint|idempot|webhook|session|nonce|cache|snapshot|projection/i;
const RX_DECRYPT = /encrypted|cipher|ciphertext|iv$|nonce/i;
const RX_PROJECTION_DOC = /\b(projection|projected|denormali[sz]ed|duplicate[sd]?|mirror(?:s|ed)?|materiali[sz]ed|read[- ]?model|non-?canonical|copy of|derived from)\b/i;
const RX_PROJECTION_NAME = /(Projection|Denormali[sz]ed|Mirror|ReadModel|Duplicate|Materiali[sz]ed)/;
const RX_SCOPE_LIKE_NONSTANDARD = /^(org|organization|organisation|account|workspace|firm|company)Id$/;
const USER_SCOPE_FIELDS = ['userId', 'ownerUserId', 'createdByUserId'];

// ---------------------------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------------------------
/** Strip a trailing `//` comment that is not inside a string literal. Returns [code, comment|null]. */
function splitTrailingComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '/' && line[i + 1] === '/') return [line.slice(0, i), line.slice(i)];
  }
  return [line, null];
}

/** Split `s` on `sep` at nesting depth 0 (ignores separators inside (), [], and strings). */
function splitTopLevel(s, sep) {
  const out = []; let depth = 0, q = null, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === '\\') { cur += s[++i] ?? ''; } else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim() !== '' || out.length) out.push(cur);
  return out.map((p) => p.trim()).filter((p) => p !== '');
}

const unquote = (s) => (s && /^["'].*["']$/.test(s.trim()) ? s.trim().slice(1, -1) : s?.trim());
const parseIdentList = (s) => splitTopLevel(s.trim().replace(/^\[|\]$/g, ''), ',').map((f) => f.match(/^\w+/)?.[0] ?? f);
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lcFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/** Parse `name: value, "positional", other: [a,b]` attribute args into { positional: [], named: {} }. */
function parseArgs(argStr) {
  const res = { positional: [], named: {} };
  if (!argStr) return res;
  for (const part of splitTopLevel(argStr, ',')) {
    const m = part.match(/^(\w+)\s*:\s*([\s\S]+)$/);
    if (m) res.named[m[1]] = m[2].trim(); else res.positional.push(part);
  }
  return res;
}

/** Split the attribute tail of a field line into [{ name, args, raw }] — handles `@db.VarChar(32)`. */
function parseFieldAttributes(tail) {
  const attrs = [];
  for (const piece of splitTopLevel(tail, '@')) {
    const m = piece.match(/^([\w.]+)(?:\(([\s\S]*)\))?\s*$/);
    if (m) attrs.push({ name: m[1], args: m[2] ?? null, raw: '@' + piece.trim() });
    else attrs.push({ name: '?', args: null, raw: '@' + piece.trim(), unparsed: true });
  }
  return attrs;
}

// ---------------------------------------------------------------------------------------------
// Prisma schema parser
// ---------------------------------------------------------------------------------------------
const RX_BLOCK_HEADER = /^(model|enum|view|type|generator|datasource)\s+(\w+)\s*\{\s*$/;
const RX_FIELD = /^(\w+)\s+([A-Za-z_]\w*(?:\((?:"[^"]*"|[^)])*\))?)(\[\])?(\?)?(?:\s+(@[\s\S]*))?$/;

/**
 * Parse one schema file. Returns { models, views, enums, compositeTypes, skippedBlocks, unparsed }.
 * `unparsed` lists every line/block the parser could not interpret — nothing is dropped silently.
 */
function parseSchema(text, relPath) {
  const lines = text.split(/\r?\n/);
  const res = { models: [], views: [], enums: [], compositeTypes: [], skippedBlocks: [], unparsed: [] };
  let pendingDocs = []; // contiguous comment lines directly above the next block
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i], t = raw.trim();
    if (t === '') { pendingDocs = []; continue; }
    if (t.startsWith('//')) { pendingDocs.push(t.replace(/^\/{2,3}\s?/, '')); continue; }
    const h = t.match(RX_BLOCK_HEADER);
    if (!h) { res.unparsed.push({ file: relPath, line: i + 1, text: t, reason: 'top-level line is not a block header or comment' }); pendingDocs = []; continue; }
    const [, kind, name] = h; const startLine = i + 1; const body = [];
    let closed = false;
    for (i++; i < lines.length; i++) { if (lines[i].trim() === '}') { closed = true; break; } body.push([i + 1, lines[i]]); }
    if (!closed) res.unparsed.push({ file: relPath, line: startLine, text: `${kind} ${name} {`, reason: 'block not closed before EOF' });
    const docComment = pendingDocs.join('\n') || null; pendingDocs = [];
    if (kind === 'generator' || kind === 'datasource') { res.skippedBlocks.push({ kind, name, line: startLine }); continue; }
    if (kind === 'enum') { res.enums.push(parseEnumBody(name, body, docComment, relPath, startLine, res.unparsed)); continue; }
    const block = parseModelBody(kind, name, body, docComment, relPath, startLine, res.unparsed);
    (kind === 'model' ? res.models : kind === 'view' ? res.views : res.compositeTypes).push(block);
  }
  return res;
}

function parseEnumBody(name, body, docComment, file, line, unparsed) {
  const e = { name, docComment, values: [], map: null, file, line };
  for (const [ln, rawLine] of body) {
    const [code] = splitTrailingComment(rawLine); const t = code.trim();
    if (t === '' || rawLine.trim().startsWith('//')) continue;
    if (/^@@map\(/.test(t)) { e.map = unquote(t.match(/^@@map\(([\s\S]*)\)$/)?.[1]); continue; }
    if (/^\w+(\s+@map\(.*\))?$/.test(t)) { e.values.push(t.split(/\s+/)[0]); continue; }
    unparsed.push({ file, line: ln, text: t, reason: `unrecognised line in enum ${name}` });
  }
  return e;
}

function parseModelBody(kind, name, body, docComment, file, line, unparsed) {
  const m = { kind, name, table: null, docComment, fields: [], indexes: [], blockAttributes: [], file, line };
  let fieldDocs = [];
  for (const [ln, rawLine] of body) {
    if (rawLine.trim().startsWith('//')) { fieldDocs.push(rawLine.trim().replace(/^\/{2,3}\s?/, '')); continue; }
    const [code] = splitTrailingComment(rawLine); const t = code.trim();
    if (t === '') { fieldDocs = []; continue; }
    if (t.startsWith('@@')) {
      const am = t.match(/^@@(\w+)(?:\(([\s\S]*)\))?$/);
      if (!am) { unparsed.push({ file, line: ln, text: t, reason: `unrecognised block attribute in ${kind} ${name}` }); continue; }
      const [, an, argStr] = am; const args = parseArgs(argStr);
      if (an === 'map') m.table = unquote(args.positional[0]);
      else if (an === 'index' || an === 'unique' || an === 'id') {
        m.indexes.push({ kind: an, fields: parseIdentList(args.positional[0] ?? ''), map: unquote(args.named.map ?? args.named.name) ?? null, type: args.named.type ?? null });
      } else m.blockAttributes.push({ name: an, args: argStr ?? null }); // @@schema, @@ignore, @@fulltext, ...
      continue;
    }
    const fm = t.match(RX_FIELD);
    if (!fm) { unparsed.push({ file, line: ln, text: t, reason: `unrecognised field line in ${kind} ${name}` }); fieldDocs = []; continue; }
    const [, fname, ftype, list, opt, tail] = fm;
    const attributes = tail ? parseFieldAttributes(tail) : [];
    for (const a of attributes) if (a.unparsed) unparsed.push({ file, line: ln, text: a.raw, reason: `unparsed attribute on ${name}.${fname}` });
    const get = (n) => attributes.find((a) => a.name === n);
    const rel = get('relation'); const relArgs = rel ? parseArgs(rel.args) : null;
    m.fields.push({
      name: fname, type: ftype, isList: !!list, isOptional: !!opt,
      map: get('map') ? unquote(parseArgs(get('map').args).positional[0]) : null,
      isId: !!get('id'), isUnique: !!get('unique'),
      default: get('default')?.args ?? null,
      dbType: attributes.find((a) => a.name.startsWith('db.'))?.raw ?? null,
      relation: rel ? { name: unquote(relArgs.positional[0]) ?? null, fields: relArgs.named.fields ? parseIdentList(relArgs.named.fields) : [], references: relArgs.named.references ? parseIdentList(relArgs.named.references) : [], onDelete: relArgs.named.onDelete ?? null } : null,
      attributes: attributes.map((a) => a.raw), // raw `@...` strings; map/default/db/relation are extracted above
      docComment: fieldDocs.length ? fieldDocs.join('\n') : null,
    });
    fieldDocs = [];
  }
  return m;
}

// ---------------------------------------------------------------------------------------------
// Schema discovery
// ---------------------------------------------------------------------------------------------
function findSchemas() {
  const found = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir)) {
      if (SKIP_DIRS.has(ent)) continue;
      const p = join(dir, ent); const st = statSync(p);
      if (st.isDirectory()) walk(p); else if (ent === 'schema.prisma') found.push(p);
    }
  };
  for (const r of SCHEMA_SEARCH_ROOTS) if (existsSync(join(ROOT, r))) walk(join(ROOT, r));
  // Sort by owner label so `api` lists before `api/<sub-schema>` in every output.
  return found.map((abs) => relative(ROOT, abs).split(sep).join('/')).sort((a, b) => ownerFromPath(a).localeCompare(ownerFromPath(b)));
}

/** `apps/api/prisma/phase6-projection/schema.prisma` -> `api/phase6-projection`; `apps/workspace/prisma/schema.prisma` -> `workspace`. */
const ownerFromPath = (rel) => rel.replace(/^(apps|packages)\//, '').replace(/\/prisma\//, '/').replace(/\/?schema\.prisma$/, '').replace(/\/$/, '');

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------
/** Outgoing FK relations (this model holds the foreign key) — the direction along which scope is inherited. */
const fkRelations = (m) => m.fields.filter((f) => f.relation && f.relation.fields.length > 0);

function classifyScopes(models) {
  const byName = new Map(models.map((m) => [m.name, m]));
  // Pass 1 — direct evidence from field names (+ root-entity special cases).
  for (const m of models) {
    const names = new Set(m.fields.map((f) => f.name));
    if (names.has('tenantId')) { m.scope = 'tenant'; m.scopeEvidence = 'field tenantId'; }
    else if (m.name === 'Tenant') { m.scope = 'tenant'; m.scopeEvidence = 'root entity special-case: Tenant is the tenant itself'; }
    else if (USER_SCOPE_FIELDS.some((f) => names.has(f))) { const f = USER_SCOPE_FIELDS.find((x) => names.has(x)); m.scope = 'user'; m.scopeEvidence = `field ${f}`; }
    else if (m.name === 'User') { m.scope = 'user'; m.scopeEvidence = 'root entity special-case: User is the user itself'; }
    else if (names.has('clientId')) {
      const fk = m.fields.find((f) => f.relation?.fields.includes('clientId')); // show what clientId actually points at
      m.scope = 'client'; m.scopeEvidence = fk ? `field clientId (FK -> ${fk.type})` : 'field clientId (no FK relation declared)';
    }
  }
  // Pass 2 — inherited: BFS over outgoing FK relations (max 2 hops) to a model with direct scope evidence.
  for (const m of models.filter((x) => !x.scope)) {
    const queue = [[m, []]]; const seen = new Set([m.name]); let hit = null;
    while (queue.length && !hit) {
      const [cur, path] = queue.shift();
      if (path.length >= 2) continue;
      for (const f of fkRelations(cur)) {
        const target = byName.get(f.type); if (!target || seen.has(target.name)) continue;
        const p = [...path, `${cur.name}.${f.name} -> ${target.name}`];
        if (target.scope && ['tenant', 'user', 'client'].includes(target.scope)) { hit = { p, target }; break; }
        seen.add(target.name); queue.push([target, p]);
      }
    }
    if (hit) { m.scope = 'inherited'; m.scopeEvidence = `${hit.p.join(' ; ')} (${hit.target.scope}: ${hit.target.scopeEvidence})`; m.inheritancePath = hit.p; }
  }
  // Pass 3 — global_reference by fixpoint: no scope field and every outgoing FK target is itself global_reference.
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of models.filter((x) => !x.scope)) {
      const nonStd = m.fields.find((f) => RX_SCOPE_LIKE_NONSTANDARD.test(f.name));
      if (nonStd) continue; // leave for `unknown` with evidence below
      const targets = fkRelations(m).map((f) => byName.get(f.type)).filter((t) => t && t.name !== m.name);
      if (targets.every((t) => t.scope === 'global_reference')) {
        m.scope = 'global_reference';
        m.scopeEvidence = targets.length ? `no tenant/user/client field; all FK targets are global_reference (${targets.map((t) => t.name).join(', ')})` : 'no tenant/user/client field and no outgoing FK relations';
        changed = true;
      }
    }
  }
  // Pass 4 — everything else is unknown; explain why.
  for (const m of models.filter((x) => !x.scope)) {
    const nonStd = m.fields.find((f) => RX_SCOPE_LIKE_NONSTANDARD.test(f.name));
    const targets = fkRelations(m).map((f) => `${f.name} -> ${f.type} (${byName.get(f.type)?.scope ?? 'unresolved'})`);
    m.scope = 'unknown';
    m.scopeEvidence = nonStd ? `non-standard scope-like field ${nonStd.name}; needs owner review` : `no scope field; FK targets not resolvable to tenant within 2 hops or not global: ${targets.join(', ') || 'none'}`;
  }
}

function classifySensitivity(m) {
  const cred = m.fields.filter((f) => RX_CREDENTIAL.test(f.name)).map((f) => f.name);
  const pii = m.fields.filter((f) => RX_PII.test(f.name)).map((f) => f.name);
  if (cred.length) return ['credential', `fields: ${cred.join(', ')}`];
  if (pii.length) return ['pii_contact', `fields: ${pii.join(', ')}`];
  return ['business', 'no credential/pii field-name match'];
}

function classifyKind(m, allModelNames) {
  const nameHit = m.name.match(RX_SYSTEM)?.[0] ?? m.table?.match(RX_SYSTEM)?.[0];
  const projDoc = m.docComment?.match(RX_PROJECTION_DOC)?.[0]; const projName = m.name.match(RX_PROJECTION_NAME)?.[0];
  let canonicalCandidate = null;
  if (projDoc || projName) {
    // (a) a known model name mentioned in the doc comment; (b) the name with its projection-ish suffix stripped.
    const mentioned = [...(m.docComment ?? '').matchAll(/\b([A-Z][A-Za-z0-9]+)\b/g)].map((x) => x[1])
      .filter((n) => n !== m.name && allModelNames.has(n)).sort((a, b) => b.length - a.length)[0]; // longest = most specific
    const stripped = m.name.replace(/(Audit)?(Projection|Snapshot|Mirror|Denormali[sz]ed|ReadModel|Duplicate|Materiali[sz]ed|View|Cache)s?$/, '');
    canonicalCandidate = mentioned ?? (stripped !== m.name && allModelNames.has(stripped) ? stripped : null);
  }
  if (nameHit) return ['outbox_or_system', `name/table matches /${nameHit}/`, canonicalCandidate];
  if (projDoc || projName) return ['projection_duplicate', projName ? `name matches /${projName}/` : `doc comment mentions "${projDoc}"`, canonicalCandidate];
  return ['canonical', 'no system/projection signal', null];
}

/** Load read-path source texts once; returns { key: [{ label, text, mode }] }. */
function loadReadPathSources() {
  const out = {};
  for (const [key, specs] of Object.entries(READ_PATH_SOURCES)) {
    out[key] = [];
    for (const s of specs) {
      const files = s.dir ? (existsSync(join(ROOT, s.dir)) ? readdirSync(join(ROOT, s.dir)).filter((f) => s.glob.test(f) && !(s.exclude && s.exclude.test(f))).map((f) => `${s.dir}/${f}`) : []) : [s.file];
      for (const f of files) {
        if (!existsSync(join(ROOT, f))) { console.warn(`[warn] read-path source missing: ${f}`); continue; }
        let text = readFileSync(join(ROOT, f), 'utf8'); let label = f;
        if (s.mode === 'registry_descriptions') {
          const start = text.indexOf('export const MERI_CAPABILITY_REGISTRY');
          const end = start >= 0 ? text.indexOf('\n]', start) : -1; // closes with `] as const satisfies ...;`
          if (start < 0 || end < 0) console.warn('[warn] MERI_CAPABILITY_REGISTRY not found; scanning whole file');
          else {
            const slice = text.slice(start, end);
            const descs = [...slice.matchAll(/description:\s*((?:(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)\s*\+?\s*)+)/g)].map((x) => x[1]);
            text = descs.join('\n'); label = `${f}#MERI_CAPABILITY_REGISTRY.descriptions`;
          }
        }
        out[key].push({ label, text, mode: s.mode });
      }
    }
  }
  return out;
}

/** Heuristic: case-insensitive whole-word containment of model name / table name / Prisma accessor in each source. */
function readPathsFor(m, sources) {
  const paths = [], evidence = [];
  const probes = [{ kind: 'model', rx: new RegExp(`\\b${escapeRx(m.name)}\\b`, 'i') }];
  if (m.table) probes.push({ kind: 'table', rx: new RegExp(`\\b${escapeRx(m.table)}\\b`, 'i') });
  const accessor = { kind: 'accessor', rx: new RegExp(`\\b(?:tx|prisma)\\.${escapeRx(lcFirst(m.name))}\\b`) };
  for (const [key, srcs] of Object.entries(sources)) {
    for (const src of srcs) {
      const active = src.mode === 'accessor_or_table' ? [accessor, ...probes.filter((p) => p.kind === 'table')] : src.mode === 'any' ? [accessor, ...probes] : probes;
      const hit = active.find((p) => p.rx.test(src.text));
      if (hit) { if (!paths.includes(key)) paths.push(key); evidence.push({ path: key, source: src.label, matched: hit.kind === 'accessor' ? `(tx|prisma).${lcFirst(m.name)}` : hit.kind === 'table' ? m.table : m.name }); }
    }
  }
  return { paths: paths.length ? paths : ['none'], evidence };
}

// ---------------------------------------------------------------------------------------------
// Build inventory
// ---------------------------------------------------------------------------------------------
function buildInventory() {
  const schemaPaths = findSchemas();
  const schemas = [], models = [], enums = [], views = [], unparsed = [];
  for (const rel of schemaPaths) {
    const owner = ownerFromPath(rel);
    const parsed = parseSchema(readFileSync(join(ROOT, rel), 'utf8'), rel);
    for (const t of parsed.compositeTypes) unparsed.push({ file: rel, line: t.line, text: `type ${t.name}`, reason: 'composite type block parsed but not classified' });
    unparsed.push(...parsed.unparsed);
    const scoped = [...parsed.models, ...parsed.views].map((m) => ({ schemaOwner: owner, ...m }));
    classifyScopes(scoped); // relations only resolve within one schema
    models.push(...scoped); views.push(...parsed.views.map((v) => ({ schemaOwner: owner, name: v.name })));
    enums.push(...parsed.enums.map((e) => ({ schemaOwner: owner, name: e.name, map: e.map, valueCount: e.values.length })));
    schemas.push({ owner, path: rel, modelCount: parsed.models.length, enumCount: parsed.enums.length, viewCount: parsed.views.length, skippedBlocks: parsed.skippedBlocks.map((b) => `${b.kind} ${b.name}`) });
  }
  const allModelNames = new Set(models.map((m) => m.name));
  const sources = loadReadPathSources();
  const out = models.map((m) => {
    const [sensitivity, sensitivityEvidence] = classifySensitivity(m);
    const [kind, kindEvidence, canonicalCandidate] = classifyKind(m, allModelNames);
    const rp = readPathsFor(m, sources);
    return {
      schemaOwner: m.schemaOwner, name: m.name, table: m.table ?? m.name, isView: m.kind === 'view', docComment: m.docComment,
      fieldCount: m.fields.length, fields: m.fields,
      relations: m.fields.filter((f) => f.relation || allModelNames.has(f.type)).map((f) => ({ field: f.name, targetModel: f.type, isList: f.isList, fields: f.relation?.fields ?? [], references: f.relation?.references ?? [], name: f.relation?.name ?? null, onDelete: f.relation?.onDelete ?? null })),
      indexes: m.indexes, blockAttributes: m.blockAttributes,
      scope: m.scope, scopeEvidence: m.scopeEvidence, inheritancePath: m.inheritancePath ?? null,
      sensitivity, sensitivityEvidence, kind, kindEvidence, canonicalCandidate,
      existingReadPath: rp.paths, existingReadPathEvidence: rp.evidence,
      decryptionRequired: m.fields.some((f) => RX_DECRYPT.test(f.name)),
      decryptionFields: m.fields.filter((f) => RX_DECRYPT.test(f.name)).map((f) => f.name),
    };
  });
  const count = (arr, key) => arr.reduce((acc, x) => ((acc[x[key]] = (acc[x[key]] ?? 0) + 1), acc), {});
  const gaps = out.filter(isBusinessGap);
  return {
    generatedAt: new Date().toISOString(), gitCommitHint: GIT_COMMIT_HINT,
    generator: 'scripts/meri-hermes/generate-data-inventory.mjs',
    heuristicsNote: 'All scope/sensitivity/kind/readPath values are heuristic (field-name regexes, one/two-hop FK inheritance, case-insensitive whole-word string containment for read paths) and require owner review. Field-level policy annotation is Phase 2A work. Schema metadata only — no data values.',
    schemas, models: out, enums, views,
    summary: {
      totalModels: out.length, totalEnums: enums.length, totalViews: views.length,
      modelsPerSchema: Object.fromEntries(schemas.map((s) => [s.owner, s.modelCount])),
      byScope: count(out, 'scope'), bySensitivity: count(out, 'sensitivity'), byKind: count(out, 'kind'),
      byReadPath: out.reduce((acc, m) => { for (const p of m.existingReadPath) acc[p] = (acc[p] ?? 0) + 1; return acc; }, {}),
      businessCanonicalNoReadPath: gaps.length, decryptionRequired: out.filter((m) => m.decryptionRequired).length,
      unknownScope: out.filter((m) => m.scope === 'unknown').length, unparsedConstructs: unparsed.length,
    },
    unparsed,
  };
}

/** The "coverage gap" predicate: canonical, not credential, and nothing reads it today. */
const isBusinessGap = (m) => m.kind === 'canonical' && m.sensitivity !== 'credential' && m.existingReadPath.includes('none');
const modelKey = (m) => `${m.schemaOwner}::${m.name}`;

// ---------------------------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------------------------
function renderMarkdown(inv) {
  const L = [];
  const table = (headers, rows) => { L.push(`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`); for (const r of rows) L.push(`| ${r.map((c) => String(c ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`); L.push(''); };
  const kv = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]);
  const gaps = inv.models.filter(isBusinessGap).sort((a, b) => b.fieldCount - a.fieldCount || a.name.localeCompare(b.name));
  L.push('# Meri/Hermes Phase 0 — Data Inventory', '',
    `Generated ${inv.generatedAt} from commit hint \`${inv.gitCommitHint}\` by \`${inv.generator}\`.`, '',
    '> **Heuristic output — owner review required.** Scope, sensitivity, kind and read-path values come from field-name regexes, one/two-hop FK inheritance and case-insensitive whole-word string containment against the Meri tool registry, `meri-tools.service.ts`, `retrieval/adapters/*.ts` (specs excluded) and `global-dataset-registry.ts`. Nothing here is a policy decision; field-level policy annotation is **Phase 2A** work. This document contains schema metadata only — no data values.', '');
  L.push('## Totals per schema', '');
  table(['Schema owner', 'Path', 'Models', 'Enums', 'Views'], inv.schemas.map((s) => [s.owner, `\`${s.path}\``, s.modelCount, s.enumCount, s.viewCount]));
  L.push(`Total: **${inv.summary.totalModels} models**, ${inv.summary.totalEnums} enums, ${inv.summary.totalViews} views across ${inv.schemas.length} schemas.`, '');
  L.push('## Classification counts', '');
  table(['Scope', 'Models'], kv(inv.summary.byScope)); table(['Sensitivity', 'Models'], kv(inv.summary.bySensitivity)); table(['Kind', 'Models'], kv(inv.summary.byKind)); table(['Existing read path', 'Models'], kv(inv.summary.byReadPath));
  L.push('Read-path caveat: `meri_tool` = model/table name appears in a `MERI_CAPABILITY_REGISTRY` description, or `tx.<model>` / `prisma.<model>` / table name appears in `meri-tools.service.ts`; `retrieval_adapter` = accessor, model or table name appears in a non-spec adapter file; `analytics_registry` = model or table name appears in `global-dataset-registry.ts`. Short names (e.g. `Client`, `Meeting`) over-match; the `sensitivity: credential` regex also matches LLM `*tokens*` counters. Review the per-model evidence in the JSON.', '');
  L.push(`## Coverage gap — canonical business models with no existing read path (${gaps.length})`, '', 'Every `kind: canonical` model whose sensitivity is not `credential` and that no Meri tool, retrieval adapter or analytics dataset reads today, largest first.', '');
  table(['Model', 'Schema', 'Scope', 'Sensitivity', 'Fields'], gaps.map((m) => [m.name, m.schemaOwner, m.scope, m.sensitivity, m.fieldCount]));
  const inherited = inv.models.filter((m) => m.scope === 'inherited');
  L.push(`## Inherited-scope models (${inherited.length})`, '', 'No `tenantId`; scope is inherited through the FK path shown (one hop, or two where needed).', '');
  table(['Model', 'Schema', 'Inheritance path'], inherited.map((m) => [m.name, m.schemaOwner, m.scopeEvidence]));
  const unknown = inv.models.filter((m) => m.scope === 'unknown');
  L.push(`## Unknown-scope models — unclassified gaps (${unknown.length})`, '', 'These need an owner decision before they can be exposed.', '');
  table(['Model', 'Schema', 'Kind', 'Why unknown'], unknown.map((m) => [m.name, m.schemaOwner, m.kind, m.scopeEvidence]));
  const creds = inv.models.filter((m) => m.sensitivity === 'credential');
  L.push(`## Credential / secret models — exclude from generic reads (${creds.length})`, '');
  table(['Model', 'Schema', 'Kind', 'Matching fields'], creds.map((m) => [m.name, m.schemaOwner, m.kind, m.sensitivityEvidence.replace(/^fields: /, '')]));
  const dec = inv.models.filter((m) => m.decryptionRequired);
  L.push(`## Decryption required — service-mediated reads only (${dec.length})`, '');
  table(['Model', 'Schema', 'Encrypted fields'], dec.map((m) => [m.name, m.schemaOwner, m.decryptionFields.join(', ')]));
  const proj = inv.models.filter((m) => m.kind === 'projection_duplicate' || m.canonicalCandidate);
  L.push(`## Projection / duplicate signals (${proj.length})`, '');
  table(['Model', 'Schema', 'Kind', 'Canonical candidate', 'Signal'], proj.map((m) => [m.name, m.schemaOwner, m.kind, m.canonicalCandidate ?? '—', m.kindEvidence]));
  L.push(`## Parser: constructs not parsed (${inv.unparsed.length})`, '');
  if (inv.unparsed.length) table(['File', 'Line', 'Text', 'Reason'], inv.unparsed.map((u) => [`\`${u.file}\``, u.line, `\`${u.text}\``, u.reason])); else L.push('None — every block in every schema was parsed as a model, view, enum, generator or datasource.', '');
  L.push('## How to regenerate', '', '```', 'node scripts/meri-hermes/generate-data-inventory.mjs', '```', '',
    'Add `--write-baseline` to refresh `data-inventory.baseline.json`, or `--check` (writes nothing, exits non-zero) to fail when any model has `unknown` scope or when a canonical business model with no read path is new relative to the baseline — the prototype migration coverage check.', '');
  return L.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------
function main() {
  const args = new Set(process.argv.slice(2));
  const inv = buildInventory();
  const baselineOf = (i) => ({ generatedAt: i.generatedAt, gitCommitHint: i.gitCommitHint, models: Object.fromEntries(i.models.map((m) => [modelKey(m), { scope: m.scope, sensitivity: m.sensitivity, kind: m.kind, existingReadPath: m.existingReadPath }])) });
  if (args.has('--check')) {
    const failures = [];
    for (const m of inv.models.filter((x) => x.scope === 'unknown')) failures.push(`unknown scope: ${modelKey(m)} — ${m.scopeEvidence}`);
    if (!existsSync(OUT_BASELINE)) failures.push(`baseline missing: ${relative(ROOT, OUT_BASELINE)} (run without --check, or with --write-baseline, first)`);
    else {
      const base = JSON.parse(readFileSync(OUT_BASELINE, 'utf8'));
      for (const m of inv.models.filter((x) => isBusinessGap(x) && x.sensitivity === 'business' && !(modelKey(x) in base.models))) failures.push(`new business model with no read path: ${modelKey(m)} (${m.fieldCount} fields, scope ${m.scope})`);
    }
    for (const u of inv.unparsed) console.warn(`[warn] unparsed: ${u.file}:${u.line} ${u.reason}`);
    if (failures.length) { console.error(`data-inventory --check FAILED (${failures.length}):`); for (const f of failures) console.error(`  - ${f}`); process.exit(1); }
    console.log(`data-inventory --check passed: ${inv.summary.totalModels} models, 0 unknown, no new uncovered business models.`);
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_JSON, JSON.stringify(inv, null, 2) + '\n');
  writeFileSync(OUT_MD, renderMarkdown(inv) + '\n');
  if (args.has('--write-baseline') || !existsSync(OUT_BASELINE)) { writeFileSync(OUT_BASELINE, JSON.stringify(baselineOf(inv), null, 2) + '\n'); console.log(`wrote ${relative(ROOT, OUT_BASELINE)}`); }
  console.log(`wrote ${relative(ROOT, OUT_JSON)} and ${relative(ROOT, OUT_MD)}`);
  console.log(JSON.stringify(inv.summary, null, 2));
  for (const u of inv.unparsed) console.warn(`[warn] unparsed: ${u.file}:${u.line} ${u.text} — ${u.reason}`);
}

main();
