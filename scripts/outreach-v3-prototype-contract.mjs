#!/usr/bin/env node
/**
 * Outreach V3 prototype interaction contract extractor (schema version 1).
 *
 * Turns the bundled standalone prototype into a compact, deterministic manifest
 * so later phases can consume the UI contract without reverse-engineering
 * 874 KB of HTML again.
 *
 * SAFETY CONTRACT — this module never executes prototype code.
 *
 *   - No eval, no new Function, no node:vm, no dynamic import of bundle content.
 *   - No DOM, no browser, no script tag is ever run.
 *   - The bundle is read as text; JSON payloads are parsed with JSON.parse,
 *     which is data-only.
 *   - Font and image assets are never decoded. Their bytes never reach output.
 *   - Output is scanned before it is returned: base64-looking blobs, data URIs
 *     and email addresses are rejected.
 *
 * Usage:
 *   node scripts/outreach-v3-prototype-contract.mjs --out <file>
 *   node scripts/outreach-v3-prototype-contract.mjs --check <file>
 *
 * Environment:
 *   OUTREACH_V3_PROTOTYPE_PATH             absolute path to the prototype HTML
 *   EXPECTED_OUTREACH_V3_PROTOTYPE_SHA256  locked SHA-256 of that file
 *
 * Both may be supplied as --prototype / --expected-sha256 instead.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export const SCHEMA_VERSION = 1;

/** Mime prefixes whose bytes must never be decoded or stored. */
const OPAQUE_ASSET_MIME = /^(font|image|audio|video)\//i;
/** Mimes that are text and may be integrity-checked by decompressing. */
const TEXT_ASSET_MIME = /^(text\/|application\/(javascript|json|xml))/i;

export class PrototypeContractError extends Error {}

function fail(message) {
  throw new PrototypeContractError(message);
}

// ───────────────────────────────────────────────────────── bundle extraction

/**
 * Pull one `<script type="__bundler/NAME">` payload out of the bundle as raw
 * text. String scanning only — no HTML parser, no DOM, nothing executed.
 */
export function readBundlerBlock(html, name) {
  const open = `<script type="__bundler/${name}">`;
  const start = html.indexOf(open);
  if (start < 0) return null;
  const from = start + open.length;
  const end = html.indexOf('</script>', from);
  if (end < 0) fail(`Bundle block "${name}" is not terminated`);
  return html.slice(from, end).trim();
}

/**
 * Parse the bundle envelope. Fails closed when either required block is absent
 * so a truncated or non-bundled file cannot silently yield an empty contract.
 */
export function readBundle(html) {
  const manifestRaw = readBundlerBlock(html, 'manifest');
  const templateRaw = readBundlerBlock(html, 'template');
  if (manifestRaw === null) fail('Bundle manifest block is missing');
  if (templateRaw === null) fail('Bundle template block is missing');

  let manifest;
  let template;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (error) {
    fail(`Bundle manifest is not valid JSON: ${error.message}`);
  }
  try {
    template = JSON.parse(templateRaw);
  } catch (error) {
    fail(`Bundle template is not valid JSON: ${error.message}`);
  }
  if (typeof template !== 'string') fail('Bundle template must decode to a string');
  if (!manifest || typeof manifest !== 'object') fail('Bundle manifest must decode to an object');

  return { manifest, template };
}

/**
 * Integrity-check bundled assets without retaining any of their bytes.
 *
 * Compressed *text* entries are decompressed purely to prove they are intact —
 * a corrupt asset must fail extraction rather than produce a partial contract.
 * Opaque assets (fonts, images) are counted and never decoded at all.
 */
export function summarizeAssets(manifest) {
  let textAssets = 0;
  let opaqueAssets = 0;
  const mimes = new Set();

  for (const [uuid, entry] of Object.entries(manifest)) {
    if (!entry || typeof entry !== 'object') fail(`Asset ${uuid} is malformed`);
    const mime = String(entry.mime ?? '');
    mimes.add(mime);

    if (OPAQUE_ASSET_MIME.test(mime)) {
      opaqueAssets += 1;
      continue; // bytes are never touched
    }
    if (!TEXT_ASSET_MIME.test(mime)) continue;

    textAssets += 1;
    if (!entry.compressed) continue;
    let bytes;
    try {
      bytes = Buffer.from(String(entry.data ?? ''), 'base64');
    } catch (error) {
      fail(`Asset ${uuid} has undecodable base64: ${error.message}`);
    }
    try {
      gunzipSync(bytes); // discarded — integrity check only
    } catch (error) {
      fail(`Asset ${uuid} (${mime}) is a corrupt compressed asset: ${error.message}`);
    }
  }

  return { textAssets, opaqueAssets, mimes: [...mimes].sort() };
}

/**
 * Locate the prototype's own source: the `text/x-dc` script inside the decoded
 * template. Returned as inert text.
 */
export function extractPrototypeSource(template) {
  const marker = 'type="text/x-dc"';
  const at = template.indexOf(marker);
  if (at < 0) fail('Prototype source script (text/x-dc) is missing from the template');
  const open = template.indexOf('>', at);
  if (open < 0) fail('Prototype source script tag is not terminated');
  const end = template.indexOf('</script>', open);
  if (end < 0) fail('Prototype source script is not terminated');
  const source = template.slice(open + 1, end);
  if (source.trim().length === 0) fail('Prototype source script is empty');
  return source;
}

// ─────────────────────────────────────────────────── inert source primitives

const QUOTES = new Set(["'", '"', '`']);

/** Scan a balanced bracket region starting at `from`. Quote-aware, never executed. */
function balancedRegion(source, from) {
  let depth = 0;
  let quote = null;
  for (let i = from; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (QUOTES.has(c)) {
      quote = c;
      continue;
    }
    if (c === '[' || c === '{' || c === '(') depth += 1;
    else if (c === ']' || c === '}' || c === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  fail('Unbalanced region while reading prototype source');
  return '';
}

/** Read the balanced region that follows an anchor string. */
function regionAfter(source, anchor, openChar) {
  const at = source.indexOf(anchor);
  if (at < 0) fail(`Prototype source anchor not found: ${anchor.trim()}`);
  const open = source.indexOf(openChar, at + anchor.length);
  if (open < 0) fail(`Prototype source anchor has no ${openChar}: ${anchor.trim()}`);
  return balancedRegion(source, open);
}

/**
 * Read the balanced region that follows a *pattern* anchor.
 *
 * Needed wherever a call site can precede the declaration it names — anchoring
 * `draftStatus(id)` by substring would otherwise match `this.draftStatus(id)`
 * hundreds of lines earlier and silently read the wrong block.
 */
function regionAfterPattern(source, pattern, openChar, description) {
  const match = pattern.exec(source);
  if (!match) fail(`Prototype source anchor not found: ${description}`);
  const open = source.indexOf(openChar, match.index + match[0].length - 1);
  if (open < 0) fail(`Prototype source anchor has no ${openChar}: ${description}`);
  return balancedRegion(source, open);
}

/** Decode a single-quoted / double-quoted JS string literal body. */
function decodeLiteral(raw) {
  return raw
    .slice(1, -1)
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

const STRING_LITERAL = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;

/** Every string literal in a region, in source order. */
function literalsIn(region) {
  return (region.match(STRING_LITERAL) ?? []).map(decodeLiteral);
}

/** A flat `['a','b',...]` array literal that follows an anchor. */
function stringArrayAfter(source, anchor) {
  return literalsIn(regionAfter(source, anchor, '['));
}

/** Deterministic slug for a prototype label. */
export function slugify(label) {
  return label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['‘’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ─────────────────────────────────────────────────────────── contract pieces

/** The `v.stateMenu` groups, each with its items, in source order. */
export function extractStateMenu(source) {
  const region = regionAfter(source, 'v.stateMenu', '[');
  const groupRe = /\{\s*label:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*,\s*items:\s*\[/g;
  const heads = [];
  let match;
  while ((match = groupRe.exec(region)) !== null) {
    heads.push({ label: decodeLiteral(match[1]), at: match.index });
  }
  if (heads.length === 0) fail('Prototype state menu contains no groups');

  const itemRe = /\{\s*label:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*,\s*go:/g;
  return heads.map((head, index) => {
    const to = index + 1 < heads.length ? heads[index + 1].at : region.length;
    const segment = region.slice(head.at, to);
    const items = [];
    let item;
    itemRe.lastIndex = 0;
    while ((item = itemRe.exec(segment)) !== null) items.push(decodeLiteral(item[1]));
    if (items.length === 0) fail(`Prototype state-menu group "${head.label}" has no items`);
    return { group: head.label, items };
  });
}

/** Turn menu items into PrototypeState records. */
function toStates(group, items) {
  return items.map((label, index) => {
    const flow = /^(\d+)\s*·\s*(.*)$/.exec(label);
    return {
      id: slugify(flow ? flow[2] : label),
      label,
      menuGroup: group,
      order: index,
      flowNumber: flow ? Number(flow[1]) : null,
    };
  });
}

/** `[['id','Label'], ...]` pair tables such as v.tabs. */
function pairTableAfter(source, anchor) {
  const region = regionAfter(source, anchor, '[');
  const rows = [];
  const rowRe = /\[\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*,\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
  let row;
  while ((row = rowRe.exec(region)) !== null) {
    rows.push({ id: decodeLiteral(row[1]), label: decodeLiteral(row[2]) });
  }
  if (rows.length === 0) fail(`Prototype pair table is empty: ${anchor}`);
  return rows;
}

/** `{id:'x', label:'Y', ...}` object tables such as v.deliveryOptions. */
function objectTableAfter(source, anchor) {
  const region = regionAfter(source, anchor, '[');
  const rows = [];
  const rowRe =
    /\{\s*id:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*,\s*label:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
  let row;
  while ((row = rowRe.exec(region)) !== null) {
    rows.push({ id: decodeLiteral(row[1]), label: decodeLiteral(row[2]) });
  }
  if (rows.length === 0) fail(`Prototype object table is empty: ${anchor}`);
  return rows;
}

/** Statuses returned by draftStatus(), in precedence order. */
function extractDraftStatuses(source) {
  const region = regionAfterPattern(
    source,
    /(^|\n)\s*draftStatus\(\s*id\s*\)\s*\{/,
    '{',
    'draftStatus(id) declaration',
  );
  const statuses = [];
  const re = /return\s+('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
  let hit;
  while ((hit = re.exec(region)) !== null) {
    const value = decodeLiteral(hit[1]);
    if (!statuses.includes(value)) statuses.push(value);
  }
  if (statuses.length === 0) fail('draftStatus() yielded no status literals');
  return statuses;
}

/** Governed-context categories declared on context items. */
function extractContextCategories(source) {
  const found = new Set();
  const re = /\bcat:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
  let hit;
  while ((hit = re.exec(source)) !== null) found.add(decodeLiteral(hit[1]));
  if (found.size === 0) fail('No governed-context categories found');
  return [...found].sort();
}

/**
 * Read a whole assignment statement, stopping at the first `;` outside any
 * bracket or string.
 */
function statementFrom(source, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (QUOTES.has(c)) {
      quote = c;
      continue;
    }
    if (c === '[' || c === '{' || c === '(') depth += 1;
    else if (c === ']' || c === '}' || c === ')') depth -= 1;
    else if (c === ';' && depth === 0) return source.slice(start, i);
  }
  return source.slice(start);
}

/**
 * The reusable `C.<NAME>` controls.
 *
 * Read as whole statements rather than as `= { label:` object literals: the
 * send control is a three-branch conditional, so an object-literal-only match
 * would silently omit the single most safety-critical control in the flow.
 */
function extractCommands(source) {
  const re = /\bC\.([A-Z_]+)\s*=/g;
  const commands = [];
  const seen = new Set();
  let hit;
  while ((hit = re.exec(source)) !== null) {
    const id = hit[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const statement = statementFrom(source, hit.index + hit[0].length);

    const labels = [];
    let dynamicLabel = false;
    const labelRe = /\blabel:\s*/g;
    let label;
    while ((label = labelRe.exec(statement)) !== null) {
      const rest = statement.slice(label.index + label[0].length);
      const literal = /^('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*[,}]/.exec(rest);
      if (literal) labels.push(decodeLiteral(literal[1]));
      else dynamicLabel = true;
    }

    const kinds = [];
    const kindRe = /\bkind:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
    let kind;
    while ((kind = kindRe.exec(statement)) !== null) {
      const value = decodeLiteral(kind[1]);
      if (!kinds.includes(value)) kinds.push(value);
    }

    commands.push({
      id,
      staticLabels: [...new Set(labels)].sort(),
      dynamicLabel,
      kinds: kinds.sort(),
    });
  }
  if (commands.length === 0) fail('No reusable command controls found');
  commands.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return commands;
}

/** Scenario identifiers reachable through setScenario(). */
function extractScenarios(source) {
  const found = new Set();
  const re = /setScenario\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*\)/g;
  let hit;
  while ((hit = re.exec(source)) !== null) found.add(decodeLiteral(hit[1]));
  if (found.size === 0) fail('No prototype scenarios found');
  return [...found].sort();
}

/** `pair([[k, v], ...])` note tables. */
function noteTable(source, anchor) {
  const rows = pairTableAfter(source, anchor);
  return rows.map(({ id, label }) => ({ name: id, note: label }));
}

/** Responsive rules, keyed by breakpoint name. */
function extractResponsive(source) {
  const rows = noteTable(source, 'v.notesResponsive');
  const byName = (needle) => rows.find((r) => r.name.toLowerCase().startsWith(needle));
  const desktop = byName('desktop');
  const tablet = byName('tablet');
  const mobile = byName('mobile');
  if (!desktop || !tablet || !mobile) fail('Responsive contract is incomplete');
  return { desktop, tablet, mobile };
}

/**
 * Derive the layout contract from the prototype's own invariant rules rather
 * than from styling, so a real layout change is what moves it.
 */
function extractLayout(source, rules, responsive) {
  const ruleText = rules.join(' \n ').toLowerCase();
  const notSplit = ruleText.includes('the screen is not split');
  const bottomDocked = /conversation docked across the bottom/.test(ruleText);
  const expandableHistory = /history expandable over the work/.test(ruleText);
  const leftPane = /conversation (pane|column) on the left|left conversation pane/.test(ruleText);
  const mobileStacked = /stacked\.?\s*conversation first/i.test(responsive.mobile.note);

  if (leftPane && bottomDocked) {
    fail('Prototype declares both a left conversation pane and a bottom-docked bar');
  }

  return {
    workbench: notSplit ? 'single' : 'split',
    conversation: bottomDocked ? 'bottom_docked' : leftPane ? 'left_pane' : 'unknown',
    history: expandableHistory ? 'expandable_overlay' : 'unknown',
    mobile: mobileStacked ? 'stacked_conversation_first' : 'unknown',
  };
}

// ───────────────────────────────────────────────────────────── output guards

const BASE64_BLOB = /[A-Za-z0-9+/]{64,}={0,2}/;
const DATA_URI = /data:[a-z]+\/[a-z0-9.+-]+;base64,/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * Refuse to emit asset bytes, embedded resources, or contact data. This is the
 * mechanical form of "store no font bytes, no base64 payload, no recipient".
 */
export function assertOutputIsClean(manifest) {
  const serialized = JSON.stringify(manifest);
  if (DATA_URI.test(serialized)) fail('Manifest contains a data: URI');
  // A SHA-256 is 64 lowercase hex characters, which is a subset of the base64
  // alphabet. Mask the hashes we deliberately record so the blob check stays
  // strict for everything else instead of being loosened to accommodate them.
  const withoutHashes = serialized.replace(/\b[0-9a-f]{64}\b/g, '<sha256>');
  if (BASE64_BLOB.test(withoutHashes)) fail('Manifest contains a base64-looking blob');
  const email = EMAIL.exec(serialized);
  if (email) fail(`Manifest contains an email address: ${email[0]}`);
  if (/"extractedAt":\s*(?!null)/.test(serialized)) fail('Manifest contains a volatile timestamp');
}

// ─────────────────────────────────────────────────────────────── entry point

/**
 * Build the contract manifest from prototype bytes.
 *
 * @param {Buffer} bytes raw prototype file
 * @param {{expectedSha256?: string}} options
 */
export function buildManifest(bytes, options = {}) {
  const prototypeSha256 = createHash('sha256').update(bytes).digest('hex');
  const { expectedSha256 } = options;
  if (expectedSha256) {
    if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
      fail(`Expected SHA-256 is malformed: ${expectedSha256}`);
    }
    if (expectedSha256 !== prototypeSha256) {
      fail(
        `Prototype checksum mismatch\n  expected ${expectedSha256}\n  actual   ${prototypeSha256}`,
      );
    }
  }

  const html = bytes.toString('utf8');
  const { manifest: assets, template } = readBundle(html);
  const assetSummary = summarizeAssets(assets);
  const source = extractPrototypeSource(template);

  const internalStages = stringArrayAfter(source, 'STAGES =');
  const visibleStages = stringArrayAfter(source, 'GROUP_LABELS =');
  const stageEntryPoints = stringArrayAfter(source, 'GROUP_ENTRY =');
  const menu = extractStateMenu(source);
  const rules = literalsIn(regionAfter(source, 'v.notesRules', '['));
  const responsive = extractResponsive(source);

  const commands = extractCommands(source);
  const groupStates = new Map(menu.map(({ group, items }) => [group, toStates(group, items)]));
  const take = (name) => groupStates.get(name) ?? fail(`State-menu group "${name}" is missing`);

  // Six declared buckets, seven source groups: the two non-happy-path narrative
  // groups both land in edgeStates. Every state keeps its source group, so the
  // mapping is lossless and auditable.
  const primaryFlowStates = take('Flow');
  const edgeStates = [...take('New in this version'), ...take('Target and context edge cases')];
  const loadingStates = take('Loading');
  const errorStates = take('Error and timeout');
  const emptyStates = take('Empty');
  const systemStates = take('System');

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    prototypeSha256,
    extractedAt: null,

    layout: extractLayout(source, rules, responsive),

    visibleStages,
    internalStages,
    stageEntryPoints,

    primaryFlowStates,
    edgeStates,
    loadingStates,
    errorStates,
    emptyStates,
    systemStates,

    sponsorScopes: pairTableAfter(source, 'v.sponsorOptions'),
    targetSources: pairTableAfter(source, 'v.tabs'),
    deliveryPatterns: objectTableAfter(source, 'v.deliveryOptions'),
    contextCategories: extractContextCategories(source),
    draftStatuses: extractDraftStatuses(source),
    commands,
    commandLabels: [...new Set(commands.flatMap((c) => c.staticLabels))].sort(),
    scenarios: extractScenarios(source),

    responsive,
    invariantRules: rules,

    assetSummary,

    provenance: {
      sourceBlock: 'template > script[type="text/x-dc"]',
      scenarioDataIsFictional: true,
      note:
        'Scenario people, offices, bills and campaign text in the prototype are ' +
        'fictional fixture content authored for the mockup. They are not production ' +
        'data and must never be treated as truth. No contact detail is extracted here.',
    },
  };

  assertOutputIsClean(manifest);
  return manifest;
}

/** Stable JSON serialization for byte-comparable fixtures. */
export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function resolveInputs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) fail(`Unexpected argument: ${arg}`);
    const [raw, inline] = arg.slice(2).split('=', 2);
    const key = raw.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    const value = inline ?? argv[++i];
    if (value === undefined || String(value).startsWith('--')) fail(`Missing value for --${raw}`);
    args[key] = value;
  }
  const prototype = args.prototype ?? process.env.OUTREACH_V3_PROTOTYPE_PATH;
  const expectedSha256 =
    args.expectedSha256 ?? process.env.EXPECTED_OUTREACH_V3_PROTOTYPE_SHA256 ?? undefined;
  if (!prototype) {
    fail('Set OUTREACH_V3_PROTOTYPE_PATH (or pass --prototype <path>)');
  }
  return { ...args, prototype, expectedSha256 };
}

function main(argv) {
  const args = resolveInputs(argv);
  const bytes = readFileSync(args.prototype);
  const manifest = buildManifest(bytes, { expectedSha256: args.expectedSha256 });
  const serialized = serializeManifest(manifest);

  if (args.check) {
    const current = readFileSync(args.check, 'utf8');
    if (current !== serialized) {
      fail(
        `Prototype contract drift: ${args.check} does not match the prototype.\n` +
          'Re-run with --out to regenerate, then review the diff.',
      );
    }
    console.log(`OK  ${args.check} matches prototype ${manifest.prototypeSha256}`);
    return;
  }
  if (args.out) {
    writeFileSync(args.out, serialized);
    console.log(`Wrote ${args.out} for prototype ${manifest.prototypeSha256}`);
    return;
  }
  process.stdout.write(serialized);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly || process.argv[1]?.endsWith('outreach-v3-prototype-contract.mjs')) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof PrototypeContractError) {
      console.error(`FAIL  ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
