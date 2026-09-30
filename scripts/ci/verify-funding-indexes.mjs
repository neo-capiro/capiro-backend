import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scopedMigration = /_funding_opportunit|_tango_|_engagement_task/;
const ident = '(?:"[a-z_][a-z0-9_]*"|[a-z_][a-z0-9_]*)';
const unquote = (s) => s.replaceAll('"', '');
const fail = (message) => {
  throw new Error(message);
};

// Split only at top-level SQL semicolons. Comments and quoted bodies must not
// manufacture index declarations; unfamiliar index operations stop the gate.
export function statements(sql) {
  const out = [];
  let part = '';
  for (let i = 0; i < sql.length;) {
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
      part += ' ';
      continue;
    }
    if (sql.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) fail('Unclosed SQL comment');
      part += ' ';
      continue;
    }
    const quote = sql[i];
    if (quote === "'" || quote === '"') {
      const start = i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i++] === quote) {
          if (sql[i] === quote) i++;
          else {
            closed = true;
            break;
          }
        }
      }
      if (!closed) fail('Unclosed SQL quote');
      part += sql.slice(start, i);
      continue;
    }
    const dollar = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length);
      if (end < 0) fail('Unclosed SQL body');
      part += sql.slice(i, end + dollar.length);
      i = end + dollar.length;
      continue;
    }
    if (sql[i] === ';') {
      if (part.trim()) out.push(part.trim());
      part = '';
      i++;
    } else part += sql[i++];
  }
  if (part.trim()) out.push(part.trim());
  return out;
}

function splitKeys(text) {
  const out = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "'") {
      if (quoted && text[i + 1] === "'") i++;
      else quoted = !quoted;
    }
    if (quoted) continue;
    if (text[i] === '(') depth++;
    if (text[i] === ')') depth--;
    if (depth < 0) fail('Unbalanced index keys');
    if (text[i] === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (depth || quoted) fail('Unbalanced index expression');
  out.push(text.slice(start));
  return out;
}

export function keySignature(text) {
  const s = unquote(text).trim().replace(/\s+/g, ' ');
  let m = s.match(/^([a-z_][a-z0-9_]*)(?: (ASC|DESC))?(?: NULLS (FIRST|LAST))?$/i);
  if (m) {
    const order = (m[2] || 'asc').toLowerCase();
    return {
      column: m[1],
      order,
      nulls: (m[3] || (order === 'asc' ? 'last' : 'first')).toLowerCase(),
    };
  }
  m = s.match(/^COALESCE\(\s*([a-z_][a-z0-9_]*)\s*,\s*''(?:::text)?\s*\)$/i);
  if (m) return { coalesceEmptyText: m[1] };
  fail(`Unsupported index key: ${s}`);
}

export function predicateSignature(text) {
  if (!text) return null;
  // Restricted grammar, not arbitrary whitespace/parenthesis erasure: only
  // conjunctions of IS NOT NULL and boolean equalities are currently owned.
  const tokens = unquote(text).match(/[a-z_][a-z0-9_]*|[()=]|\S/gi) || [];
  let at = 0;
  function atom() {
    if (tokens[at] === '(') {
      at++;
      const value = conjunction();
      if (tokens[at++] !== ')') fail('Unbalanced predicate');
      return value;
    }
    const column = tokens[at++];
    if (!/^[a-z_][a-z0-9_]*$/.test(column || '')) fail('Unsupported predicate column');
    if (
      tokens[at]?.toLowerCase() === 'is' &&
      tokens[at + 1]?.toLowerCase() === 'not' &&
      tokens[at + 2]?.toLowerCase() === 'null'
    ) {
      at += 3;
      return [{ column, notNull: true }];
    }
    if (tokens[at] === '=' && ['true', 'false'].includes(tokens[at + 1]?.toLowerCase())) {
      const value = tokens[at + 1].toLowerCase() === 'true';
      at += 2;
      return [{ column, equalsBoolean: value }];
    }
    fail('Unsupported predicate operator');
  }
  function conjunction() {
    let terms = atom();
    while (tokens[at]?.toLowerCase() === 'and') {
      at++;
      terms = terms.concat(atom());
    }
    return terms;
  }
  const result = conjunction();
  if (at !== tokens.length) fail('Unsupported predicate tail');
  return result;
}

export function parseIndex(sql) {
  const header = new RegExp(
    `^CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${ident})\\s+ON\\s+(?:(?:"public"|public)\\.)?(${ident})(?:\\s+USING\\s+(\\w+))?\\s*\\(`,
    'i',
  );
  const m = sql.trim().match(header);
  if (!m) fail('Unsupported CREATE INDEX statement');
  const s = sql.trim();
  let depth = 1;
  let i = m[0].length;
  const start = i;
  let quoted = false;
  for (; i < s.length && depth; i++) {
    if (s[i] === "'") {
      if (quoted && s[i + 1] === "'") {
        i++;
        continue;
      }
      quoted = !quoted;
    }
    if (!quoted) {
      if (s[i] === '(') depth++;
      if (s[i] === ')') depth--;
    }
  }
  if (depth || quoted) fail('Unclosed CREATE INDEX keys');
  const tail = s.slice(i).trim().replace(/;$/, '').trim();
  if (tail && !/^WHERE\s/i.test(tail)) fail('Unsupported index suffix');
  const method = (m[4] || 'btree').toLowerCase();
  if (method !== 'btree') fail(`Unsupported index method: ${method}`);
  return {
    name: unquote(m[2]),
    table: unquote(m[3]),
    unique: Boolean(m[1]),
    method,
    keys: splitKeys(s.slice(start, i - 1)).map(keySignature),
    predicate: predicateSignature(tail.replace(/^WHERE\s+/i, '')),
  };
}

export function indexHistory(migrations) {
  const files = [...migrations].sort((a, b) => a.name.localeCompare(b.name));
  const names = new Set();
  const operations = [];
  for (const file of files) {
    for (const sql of statements(file.sql)) {
      const create = sql.match(
        new RegExp(
          `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${ident})`,
          'i',
        ),
      );
      const drop = sql.match(new RegExp(`^DROP\\s+INDEX\\s+(?:IF\\s+EXISTS\\s+)?(${ident})$`, 'i'));
      if (create || drop) {
        const name = unquote((create || drop)[1]);
        if (create && scopedMigration.test(file.name)) names.add(name);
        operations.push({ kind: create ? 'create' : 'drop', name, sql, migration: file.name });
      } else if (/\b(?:CREATE\s+(?:UNIQUE\s+)?|DROP\s+|ALTER\s+)INDEX\b/i.test(sql)) {
        operations.push({ kind: 'unsupported', sql, migration: file.name });
      }
    }
  }
  if (!names.size) fail('No scoped migration indexes found');
  const active = new Map();
  const removed = new Set();
  const retired = new Map();
  const history = [];
  for (const op of operations) {
    if (op.kind === 'unsupported') {
      if (scopedMigration.test(op.migration) || [...names].some((name) => op.sql.includes(name)))
        fail(`Unreviewed index operation in ${op.migration}`);
      continue;
    }
    if (!names.has(op.name)) continue;
    history.push({ name: op.name, kind: op.kind, migration: op.migration });
    if (op.kind === 'drop') {
      if (active.has(op.name)) retired.set(op.name, active.get(op.name).signature);
      active.delete(op.name);
      removed.add(op.name);
    } else {
      const signature = parseIndex(op.sql);
      const previous = active.get(op.name);
      if (previous && JSON.stringify(previous.signature) !== JSON.stringify(signature))
        fail(`Index recreated without DROP: ${op.name}`);
      active.set(op.name, { signature, migration: op.migration });
      removed.delete(op.name);
      retired.delete(op.name);
    }
  }
  return {
    names: [...names].sort(),
    active,
    removed: [...removed].sort(),
    retired: [...retired.values()],
    history,
  };
}

export function verifyIndexes({ history, generatedSql, sqlOwned, catalog }) {
  const generated = new Map();
  for (const sql of statements(generatedSql)) {
    if (!/^CREATE\s+(?:UNIQUE\s+)?INDEX\s/i.test(sql)) continue;
    const name = sql.match(
      new RegExp(`^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${ident})`, 'i'),
    )?.[1];
    if (!name) fail('Unrecognized generated index name');
    if (
      !history.names.includes(unquote(name)) &&
      !history.retired.some((r) => sql.includes(`ON "${r.table}"`))
    )
      continue;
    const value = parseIndex(sql);
    if (generated.has(value.name)) fail(`Duplicate generated index: ${value.name}`);
    generated.set(value.name, value);
  }
  const owned = new Map();
  for (const entry of sqlOwned) {
    const signature = parseIndex(entry.sql);
    if (owned.has(signature.name)) fail('Duplicate SQL-owned index');
    owned.set(signature.name, { signature, migration: entry.migration });
  }
  const actual = new Map();
  for (const row of catalog) {
    if (actual.has(row.name)) fail(`Duplicate catalog index: ${row.name}`);
    actual.set(row.name, row);
  }
  const same = (a, b, label) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) fail(`Index contract mismatch: ${label}`);
  };
  for (const [name, expected] of history.active) {
    if (owned.has(name)) {
      const contract = owned.get(name);
      same(contract, expected, `SQL-owned ${name}`);
      if (
        !expected.signature.predicate &&
        !expected.signature.keys.some((key) => key.coalesceEmptyText)
      )
        fail(`Representable index cannot bypass Prisma: ${name}`);
      if (generated.has(name)) fail(`SQL-owned index falsely declared in Prisma: ${name}`);
    } else same(generated.get(name), expected.signature, `Prisma ${name}`);
    const row = actual.get(name);
    if (!row || row.schema !== 'public' || !row.valid || !row.ready || !row.live || !row.immediate)
      fail(`Missing or unusable catalog index: ${name}`);
    same(parseIndex(row.definition), expected.signature, `catalog ${name}`);
  }
  for (const name of owned.keys())
    if (!history.active.has(name)) fail(`Stale SQL-owned contract: ${name}`);
  for (const name of history.removed)
    if (generated.has(name) || actual.has(name)) fail(`Removed index resurrected: ${name}`);
  const withoutName = ({ name, ...rest }) => rest;
  for (const retired of history.retired) {
    for (const candidate of [
      ...generated.values(),
      ...catalog
        .filter(
          (r) =>
            r.definition.includes(`public.${retired.table} `) ||
            r.definition.includes(`"${retired.table}"`),
        )
        .map((r) => parseIndex(r.definition)),
    ]) {
      if (JSON.stringify(withoutName(candidate)) === JSON.stringify(withoutName(retired)))
        fail(`Removed index resurrected under another name: ${retired.name}`);
    }
  }
  return {
    scoped: history.names.length,
    active: history.active.size,
    sqlOwned: owned.size,
    removed: history.removed,
  };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--schema-sql')
    fail('Usage: verify-funding-indexes.mjs --schema-sql <generated SQL>');
  const dir = path.join(root, 'apps/api/prisma/migrations');
  const migrations = fs
    .readdirSync(dir)
    .filter((name) => fs.existsSync(path.join(dir, name, 'migration.sql')))
    .map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name, 'migration.sql'), 'utf8') }));
  const history = indexHistory(migrations);
  if (history.names.length < 88) fail('Funding index coverage dropped below 88');
  const url = new URL(process.env.PSQL_DATABASE_URL || '');
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '5486' ||
    url.pathname !== '/fo_v2_test' ||
    url.username !== 'fo_test' ||
    url.search ||
    url.hash
  )
    fail('Expected the owned local Funding CI database');
  const require = createRequire(path.join(root, 'apps/api/package.json'));
  const { Client } = require('pg');
  const client = new Client({
    connectionString: url.toString(),
    options: '-c default_transaction_read_only=on',
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
  });
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    const identity = (
      await client.query(
        "SELECT current_database() AS db,current_user AS role,current_setting('transaction_read_only') AS readonly",
      )
    ).rows[0];
    if (identity.db !== 'fo_v2_test' || identity.role !== 'fo_test' || identity.readonly !== 'on')
      fail('Unexpected catalog read identity');
    const catalog = (
      await client.query(
        `SELECT c.relname AS name,n.nspname AS schema,i.indisvalid AS valid,i.indisready AS ready,i.indislive AS live,i.indimmediate AS immediate,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND (c.relname=ANY($1::text[]) OR t.relname=ANY($2::text[]))`,
        [history.names, history.retired.map((r) => r.table)],
      )
    ).rows;
    const result = verifyIndexes({
      history,
      generatedSql: fs.readFileSync(args[1], 'utf8'),
      sqlOwned: JSON.parse(
        fs.readFileSync(path.join(root, 'scripts/ci/funding-sql-owned-indexes.json'), 'utf8'),
      ),
      catalog,
    });
    console.log(`Funding index contracts PASS: ${JSON.stringify(result)}`);
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
