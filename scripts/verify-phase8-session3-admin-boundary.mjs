#!/usr/bin/env node
// Phase 8 Session 3 permanent verifier — governed Program-graph admin boundary.
//
// Origin: the security model this checks comes from the concurrent Session 3
// branch (PR #1044). This verifier is adapted to the consolidated layout, where
// the governed calls live in `programs.service.ts` beside the validation they
// belong with rather than in two parallel *-parity services.
//
// What it proves STATICALLY:
//   1. every global Program-graph mutation in defense-api goes through a
//      SECURITY DEFINER function, and no Prisma DML on those tables remains;
//   2. each function is fixed-shape: locked empty search_path, fully-qualified
//      object names, scalar parameters only (no caller-supplied SQL), revoked
//      from PUBLIC, granted to capiro_defense_serve alone;
//   3. every function re-checks capiro_admin at execution time;
//   4. the migration collapses the serve role to SELECT-only on those tables;
//   5. audit rows use the real physical timestamp column (occurred_at) — there is
//      no audit_logs.created_at, and writing to it silently fails.
//
// This is the STATIC half. The authoritative proof is the disposable-DB
// rehearsal (`pnpm verify:phase8-session3:db`), which reads the ACTUAL granted
// privileges out of information_schema and executes the real allow/deny cases as
// the real roles. A static token scan cannot be fooled into passing by SQL
// formatting there; here it can, which is exactly why both exist.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const failures = [];

const read = (relative) => {
  const target = path.join(root, relative);
  if (!fs.existsSync(target)) {
    failures.push(`missing required file: ${relative}`);
    return '';
  }
  return fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
};

const requireTokens = (relative, tokens, label = 'missing') => {
  const source = read(relative);
  for (const token of tokens) {
    if (!source.includes(token)) failures.push(`${relative} ${label} ${token}`);
  }
  return source;
};

const BOUNDARY_MIGRATION =
  'apps/api/prisma/migrations/20261120210200_phase8_defense_program_admin_boundary/migration.sql';
const PROGRAMS_SERVICE = 'apps/defense-api/src/program-elements/programs.service.ts';

const GOVERNED_FUNCTIONS = [
  { name: 'capiro_defense_resolve_program_match', signature: '(uuid, uuid, uuid, text, text)' },
  { name: 'capiro_defense_create_program_alias', signature: '(uuid, uuid, uuid, text, text, text, text)' },
  { name: 'capiro_defense_update_program_alias', signature: '(uuid, uuid, uuid, text, text, text)' },
  { name: 'capiro_defense_delete_program_alias', signature: '(uuid, uuid, uuid)' },
  { name: 'capiro_defense_merge_programs', signature: '(uuid, uuid, uuid, uuid)' },
];

/** Global Program-graph tables: no tenant_id, no RLS -> serve must be SELECT-only. */
const GLOBAL_GRAPH_TABLES = [
  'program',
  'program_alias',
  'pe_program_match',
  'person_role',
  'program_office_program_link',
  'provision_pe_link',
];

// ---------------------------------------------------------------------------
// 1. The migration defines the gate and every governed function.
// ---------------------------------------------------------------------------
const migration = requireTokens(BOUNDARY_MIGRATION, [
  'capiro_defense_require_admin',
  ...GOVERNED_FUNCTIONS.map((f) => f.name),
]);

// The admin gate must not be callable by the serve role directly: it is an
// internal helper, not a membership oracle an HTTP request can aim at a tenant.
if (!/REVOKE ALL ON FUNCTION public\.capiro_defense_require_admin\(uuid, uuid\) FROM capiro_defense_serve/.test(migration)) {
  failures.push('capiro_defense_require_admin is not revoked from capiro_defense_serve');
}

for (const fn of GOVERNED_FUNCTIONS) {
  const declaration = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${fn.name}\\(([\\s\\S]*?)\\$fn\\$;`,
  ).exec(migration);
  if (!declaration) {
    failures.push(`${fn.name} is not declared in ${BOUNDARY_MIGRATION}`);
    continue;
  }
  const body = declaration[1];

  if (!body.includes('SECURITY DEFINER')) failures.push(`${fn.name} is not SECURITY DEFINER`);
  if (!/SET search_path = ''/.test(body)) {
    failures.push(`${fn.name} does not lock search_path to the empty string`);
  }
  if (!body.includes('PERFORM public.capiro_defense_require_admin(')) {
    failures.push(`${fn.name} does not re-check capiro_admin at execution time`);
  }
  // Every table reference must be schema-qualified; with an empty search_path an
  // unqualified name would not resolve at all, so this is correctness AND safety.
  for (const table of [...GLOBAL_GRAPH_TABLES, 'audit_logs', 'tenant_memberships']) {
    const unqualified = new RegExp(`(?<!public\\.)\\b(?:FROM|INTO|UPDATE|JOIN)\\s+${table}\\b`, 'i');
    if (unqualified.test(body)) {
      failures.push(`${fn.name} references ${table} without a public. qualifier`);
    }
  }
  // No dynamic SQL assembled from parameters.
  if (/\bEXECUTE\s+(?:format\(|'|p_)/i.test(body)) {
    failures.push(`${fn.name} builds dynamic SQL — parameters must never be concatenated into a statement`);
  }
  // Audit rows must use the real physical column.
  if (body.includes('audit_logs') && !body.includes('occurred_at')) {
    failures.push(`${fn.name} writes audit_logs without occurred_at`);
  }
  if (/audit_logs[\s\S]{0,400}\bcreated_at\b/.test(body)) {
    failures.push(`${fn.name} writes the nonexistent audit_logs.created_at`);
  }

  const revoked = new RegExp(
    `REVOKE ALL ON FUNCTION public\\.${fn.name}${escapeSignature(fn.signature)} FROM PUBLIC`,
  );
  if (!revoked.test(migration)) failures.push(`${fn.name} is not revoked from PUBLIC`);

  const granted = new RegExp(
    `GRANT EXECUTE ON FUNCTION public\\.${fn.name}${escapeSignature(fn.signature)} TO capiro_defense_serve`,
  );
  if (!granted.test(migration)) failures.push(`${fn.name} does not grant EXECUTE to capiro_defense_serve`);

  const jobRevoked = new RegExp(
    `REVOKE ALL ON FUNCTION public\\.${fn.name}${escapeSignature(fn.signature)} FROM capiro_defense_job`,
  );
  if (!jobRevoked.test(migration)) {
    failures.push(`${fn.name} is not explicitly revoked from capiro_defense_job`);
  }
}

// ---------------------------------------------------------------------------
// 2. The migration collapses the serve role to SELECT-only on the graph.
// ---------------------------------------------------------------------------
for (const table of GLOBAL_GRAPH_TABLES) {
  if (!new RegExp(`'${table}'`).test(migration)) {
    failures.push(`${BOUNDARY_MIGRATION} does not lock down global graph table ${table}`);
  }
}
if (!/REVOKE ALL ON TABLE public\.%I FROM capiro_defense_serve/.test(migration)) {
  failures.push(`${BOUNDARY_MIGRATION} does not revoke prior grants before re-granting SELECT`);
}
if (!/GRANT SELECT ON TABLE public\.%I TO capiro_defense_serve/.test(migration)) {
  failures.push(`${BOUNDARY_MIGRATION} does not re-grant SELECT on the locked-down tables`);
}

// ---------------------------------------------------------------------------
// 3. defense-api performs every graph mutation through a governed function.
// ---------------------------------------------------------------------------
const programsService = requireTokens(
  PROGRAMS_SERVICE,
  [
    ...GOVERNED_FUNCTIONS.map((f) => `public.${f.name}(`),
    'active capiro_admin membership required',
    'ForbiddenException',
  ],
  'does not call',
);

// No Prisma DML on the global graph may remain anywhere in defense-api. This is
// the check that would have caught a half-finished migration to the governed path.
const PRISMA_MODELS = [
  'program',
  'programAlias',
  'peProgramMatch',
  'personRole',
  'programOfficeProgramLink',
  'provisionPeLink',
];
const DML_METHODS = ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'];
const defenseApiSrc = path.join(root, 'apps/defense-api/src');
for (const file of walkTs(defenseApiSrc)) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  // Integration specs legitimately seed and assert against the graph as the
  // ADMIN connection, which is a different role than the serve runtime.
  if (relative.endsWith('.spec.ts')) continue;
  const contents = stripComments(fs.readFileSync(file, 'utf8'));
  for (const model of PRISMA_MODELS) {
    for (const method of DML_METHODS) {
      if (new RegExp(`\\.${model}\\.${method}\\(`).test(contents)) {
        failures.push(
          `${relative} performs Prisma ${model}.${method}() on a global Program graph table — it must go through a governed SECURITY DEFINER function`,
        );
      }
    }
  }
}

// The governed helper must not be wrapped in a tenant transaction: the function
// authorizes from its own parameters, and running it inside a transaction would
// let the app.bypass_rls its admin check sets outlive the statement.
const governedHelper = /private async governedMutation<T>\([\s\S]*?\n  \}/.exec(programsService);
if (!governedHelper) {
  failures.push(`${PROGRAMS_SERVICE} has no governedMutation helper`);
} else if (/withTenant(?:Actor)?\(/.test(governedHelper[0])) {
  failures.push('governedMutation wraps the governed call in a tenant transaction');
}

// ---------------------------------------------------------------------------
// 4. The DB rehearsal must actually exercise the boundary.
// ---------------------------------------------------------------------------
requireTokens(
  'scripts/verify-phase8-session3-db.sh',
  [
    'capiro_defense_merge_programs',
    'capiro_defense_require_admin',
    'information_schema.table_privileges',
    'standard_user',
  ],
  'does not exercise',
);

requireTokens(
  'apps/defense-api/src/program-elements/programs-admin-security.integration.spec.ts',
  ['REHEARSAL_SERVE_URL', 'standard_user', 'capiro_admin', 'ForbiddenException'],
  'does not prove',
);

function escapeSignature(signature) {
  return signature.replace(/[()]/g, (c) => `\\${c}`);
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function walkTs(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (['node_modules', 'generated', 'dist'].includes(entry.name)) continue;
      walkTs(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

if (failures.length) {
  console.error(`SESSION3_ADMIN_BOUNDARY_FAIL (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('SESSION3_ADMIN_BOUNDARY_PASS');
console.log(
  `${GOVERNED_FUNCTIONS.length} governed mutations: locked search_path, fully-qualified, admin-rechecked in-DB, revoked from PUBLIC and the job role, granted to capiro_defense_serve only; global Program graph is SELECT-only with no Prisma DML remaining.`,
);
