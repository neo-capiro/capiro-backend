import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Static source invariants ONLY. These tests neither parse nor execute PostgreSQL,
// and cannot qualify SQL validity, real grants/inheritance, FORCE RLS behavior,
// trigger execution, deferred commit checks, concurrency, rollback or deployment.
const readMigration = (name) => readFileSync(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url), 'utf8');
const normalize = (value) => value
  .replace(/--[^\r\n]*/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

const intent = normalize(readMigration('20281015010000_client_objective_work_intents'));
const canonical = normalize(readMigration('20281015020000_client_objective_canonical_plans'));
const operational = normalize(readMigration('20281015030000_client_objective_operational_links'));
const source = readMigration('20281015050000_client_objective_work_reconsent');
const sql = normalize(source);

const CONTROL = 'client_objective_work_controls';
const CONSENT = 'client_objective_work_consents';
const RECEIPT = 'client_objective_work_command_receipts';
const TABLES = [CONTROL, CONSENT, RECEIPT];
const S = ['tenant_id', 'client_id', 'objective_id', 'work_action'];
const P = ['canonical_plan_id', 'canonical_epoch', 'canonical_strategy_id', 'canonical_project_id'];
const R = ['root_intent_id', 'source_revision_id', 'source_objective_version', 'source_snapshot_hash', 'root_actor_user_id'];
const scope = ['tenant_id', 'client_id', 'objective_id'];
const columns = (value) => value.split(',').map((item) => item.trim());

function table(name) {
  const match = sql.match(new RegExp(`\\bcreate table ${name}\\s*\\([\\s\\S]*?;`));
  assert.ok(match, `missing CREATE TABLE ${name}`);
  return match[0];
}

// Small lexical helpers for the asserted source clauses, not a SQL parser.
function closingParen(text, start) {
  let depth = 0;
  let quoted = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") {
      if (quoted && text[index + 1] === "'") { index += 1; continue; }
      quoted = !quoted;
    } else if (!quoted && char === '(') depth += 1;
    else if (!quoted && char === ')' && --depth === 0) return index;
  }
  assert.fail('unterminated asserted source clause');
}

function tableClauses(name) {
  const ddl = table(name);
  const start = ddl.indexOf('(');
  const end = closingParen(ddl, start);
  const clauses = [];
  let clauseStart = start + 1;
  let quoted = false;
  for (let index = clauseStart; index < end; index += 1) {
    const char = ddl[index];
    if (char === "'") {
      if (quoted && ddl[index + 1] === "'") { index += 1; continue; }
      quoted = !quoted;
    } else if (!quoted && char === '(') index = closingParen(ddl, index);
    else if (!quoted && char === ',') {
      clauses.push(ddl.slice(clauseStart, index).trim());
      clauseStart = index + 1;
    }
  }
  clauses.push(ddl.slice(clauseStart, end).trim());
  return clauses;
}

function column(name, field) {
  const clause = tableClauses(name).find((entry) => entry.startsWith(`${field} `));
  assert.ok(clause, `missing ${name}.${field}`);
  return clause;
}

function checks(name) {
  const ddl = table(name);
  return [...ddl.matchAll(/\bcheck\s*\(/g)].map((match) => {
    const start = match.index + match[0].lastIndexOf('(');
    return ddl.slice(start + 1, closingParen(ddl, start));
  });
}

function hasCheck(name, expression) {
  assert.ok(checks(name).some((check) => expression.test(check)),
    `missing CHECK ${expression} in ${name}`);
}

function functionBody(name) {
  const match = sql.match(new RegExp(`\\bcreate function ${name}\\(\\)[\\s\\S]*?\\bas \\$\\$([\\s\\S]*?)\\$\\$;`));
  assert.ok(match, `missing function ${name}`);
  return match[1].trim();
}

function trigger(name) {
  const match = sql.match(new RegExp(`\\bcreate (?:constraint )?trigger ${name}\\b[\\s\\S]*?;`));
  assert.ok(match, `missing trigger ${name}`);
  return match[0];
}

function tupleComparison(text, left, operator, right) {
  const compact = text.replace(/\s/g, '');
  assert.ok(compact.includes(`(${left.join(',')})${operator.replace(/\s/g, '')}(${right.join(',')})`),
    `missing ordered ${operator} comparison: ${left.join(',')} / ${right.join(',')}`);
}

function uniqueTuples(text) {
  return [...text.matchAll(/\bunique\s*\(([^)]*)\)/g)].map((match) => columns(match[1]));
}

function hasUnique(text, expected) {
  assert.ok(uniqueTuples(text).some((tuple) => JSON.stringify(tuple) === JSON.stringify(expected)),
    `missing exact UNIQUE (${expected.join(',')})`);
}

function foreignKeys(text) {
  return [...text.matchAll(/\bforeign key\s*\(([^)]*)\)\s*references\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)([^,;]*)/g)]
    .map((match) => ({ from: columns(match[1]), target: match[2], to: columns(match[3]), suffix: match[4] }));
}

function hasForeignKey(text, from, target, to, { deferred = false } = {}) {
  const matches = foreignKeys(text).filter((key) => key.target === target &&
    JSON.stringify(key.from) === JSON.stringify(from) && JSON.stringify(key.to) === JSON.stringify(to));
  assert.equal(matches.length, 1, `expected one exact FK (${from.join(',')}) -> ${target}(${to.join(',')})`);
  assert.match(matches[0].suffix, /\bon delete cascade\b/);
  assert.match(matches[0].suffix, /\bon update no action\b/);
  if (deferred) assert.match(matches[0].suffix, /\bdeferrable initially deferred\b/);
  else {
    const deferrability = matches[0].suffix.match(/\b(?:not )?deferrable\b/);
    if (deferrability) assert.equal(deferrability[0], 'not deferrable', 'only the consent-to-receipt FK may be deferred');
  }
  return matches[0];
}

test('existing immutable source and reservation migrations expose the required scoped identities', () => {
  hasUnique(intent, [...scope, 'id', 'version']);
  hasUnique(intent, [...scope, 'objective_revision_id', 'purpose']);
  hasUnique(canonical, [...scope, 'id', 'objective_revision_id', 'objective_version', 'snapshot_hash']);
  assert.match(intent, /\bstate varchar\(24\) not null default 'pending' check \(state = 'pending'\)/);
  assert.match(intent, /\bblocked_reason varchar\(48\) not null default 'runtime_authority_unconnected'/);
  assert.match(canonical, /\bepoch integer not null default 1 check \(epoch = 1\)/);
  assert.match(operational, /\bforce row level security\b/);
  assert.match(operational, /\brevoke update,\s*delete on client_objective_operational_receipts from capiro_app\b/);
});

test('the additive migration creates exactly the three scoped control, consent and receipt tables', () => {
  const created = [...sql.matchAll(/\bcreate table\s+([a-z_][a-z0-9_]*)/g)].map((match) => match[1]);
  assert.deepEqual(created.sort(), [...TABLES].sort());
  for (const name of TABLES) {
    const ddl = table(name);
    assert.match(ddl, /\bid uuid primary key default gen_random_uuid\(\)/);
    for (const column of [...scope, 'canonical_plan_id', 'canonical_strategy_id', 'canonical_project_id']) {
      assert.match(ddl, new RegExp(`\\b${column} uuid not null\\b`));
    }
    assert.match(ddl, /\bwork_action varchar\(40\) not null\b/);
    assert.match(ddl, /\bwork_action in\s*\(\s*'objective\.strategy\.draft'\s*,\s*'objective\.plan\.prepare'\s*\)/);
    assert.match(ddl, /\bcanonical_epoch integer not null\b/);
    hasCheck(name, /\bcanonical_epoch\s*=\s*1\b/);
  }
  assert.doesNotMatch(sql, /\breferences\s+sp_[a-z0-9_]+\b/,
    'reservation identity must not claim an owner output row exists');
});

test('stable canonical and original root-intent keys retain exact ordered lineage without mutable binding versions', () => {
  hasUnique(sql, [...scope, 'id', 'epoch', 'canonical_strategy_id', 'canonical_project_id']);
  hasUnique(sql, [...scope, 'id', 'objective_revision_id', 'objective_version', 'snapshot_hash', 'actor_user_id']);
  hasForeignKey(table(CONTROL), [...scope, ...P], 'client_objective_canonical_plans',
    [...scope, 'id', 'epoch', 'canonical_strategy_id', 'canonical_project_id']);
  for (const name of [CONSENT, RECEIPT]) {
    hasForeignKey(table(name), [...scope, ...R], 'client_objective_work_intents',
      [...scope, 'id', 'objective_revision_id', 'objective_version', 'snapshot_hash', 'actor_user_id']);
  }
  for (const key of foreignKeys(sql)) {
    assert.equal(key.from.includes('canonical_binding_version'), false);
    assert.equal(key.to.includes('binding_version'), false);
    if (['users', 'tenant_memberships'].includes(key.target))
      assert.fail('audit actor/membership identities must not acquire deletion-blocking identity FKs');
  }
});

test('control, previous/head consent, receipt and command-revision FKs cannot cross action or scope', () => {
  hasUnique(table(CONTROL), S);
  hasUnique(table(CONTROL), [...S, 'id', ...P]);
  hasUnique(table(CONSENT), [...S, 'control_id', 'id']);
  hasUnique(table(CONSENT), [...S, 'consenting_actor_user_id', 'command_request_id']);
  hasUnique(table(CONSENT), [...S, 'control_id', 'command_receipt_id']);
  hasUnique(table(RECEIPT), [...S, 'actor_user_id', 'request_id']);
  hasUnique(table(RECEIPT), [...S, 'control_id', 'id']);
  for (const name of [CONSENT, RECEIPT]) {
    hasForeignKey(table(name), [...S, 'control_id', ...P], CONTROL, [...S, 'id', ...P]);
  }
  hasForeignKey(sql, [...S, 'control_id', 'previous_consent_id'], CONSENT, [...S, 'control_id', 'id']);
  hasForeignKey(sql, [...S, 'id', 'current_consent_id'], CONSENT, [...S, 'control_id', 'id']);
  for (const column of ['target_consent_id', 'created_consent_id', 'result_consent_id']) {
    hasForeignKey(sql, [...S, 'control_id', column], CONSENT, [...S, 'control_id', 'id']);
  }
  hasForeignKey(table(RECEIPT), [...scope, 'command_revision_id', 'command_objective_version'],
    'client_objective_revisions', [...scope, 'id', 'version']);
  hasForeignKey(sql, [...S, 'control_id', 'command_receipt_id'], RECEIPT,
    [...S, 'control_id', 'id'], { deferred: true });
});

test('immutable consent pins original and newly consenting actors without a user or membership lifecycle FK', () => {
  for (const name of [CONSENT, RECEIPT]) {
    for (const field of ['root_intent_id', 'source_revision_id', 'root_actor_user_id']) {
      assert.match(column(name, field), /\buuid not null\b/);
    }
    assert.match(column(name, 'source_objective_version'), /\binteger not null\b/);
    assert.match(column(name, 'source_snapshot_hash'), /\bchar\(64\) not null\b/);
    assert.match(column(name, 'canonical_binding_version'), /\binteger not null\b/);
  }
  for (const field of ['consenting_actor_user_id', 'consenting_membership_id', 'command_request_id', 'command_receipt_id']) {
    assert.match(column(CONSENT, field), /\buuid not null\b/);
  }
  for (const field of ['actor_user_id', 'actor_membership_id', 'request_id', 'command_revision_id']) {
    assert.match(column(RECEIPT, field), /\buuid not null\b/);
  }
  assert.equal(tableClauses(CONTROL).some((entry) => R.some((field) => entry.startsWith(`${field} `))), false,
    'mutable control must not relabel an immutable consent/receipt source');
});

test('revision-1 policy is explicit and only permits configured/effective durations up to 30 minutes', () => {
  assert.match(column(CONSENT, 'consent_policy_id'), /\bvarchar\(128\) not null\b/);
  assert.match(column(CONSENT, 'consent_policy_revision'), /\binteger not null\b/);
  hasCheck(CONSENT, /\bconsent_policy_id\s*=\s*'capiro\.objective-generation-consent'/);
  hasCheck(CONSENT, /\bconsent_policy_revision\s*=\s*1\b/);
  for (const field of ['configured_duration_ms', 'effective_duration_ms']) {
    const declaration = column(CONSENT, field);
    assert.match(declaration, /\bbigint not null\b/);
    assert.doesNotMatch(declaration, /\bdefault\b/, 'the stored consent must carry actual policy terms');
    hasCheck(CONSENT, new RegExp(`\\b${field} between 1 and 1800000\\b`));
  }
  hasCheck(CONSENT, /\beffective_duration_ms\s*<=\s*configured_duration_ms\b/);
  for (const field of ['confirmed_at', 'expires_at']) {
    assert.match(column(CONSENT, field), /\btimestamptz\(6\) not null\b/);
  }
  hasCheck(CONSENT, /\bexpires_at\s*>\s*confirmed_at\b/);
  hasCheck(CONSENT, /\bexpires_at\s*<=\s*confirmed_at\s*\+[^)]*effective_duration_ms/);
  hasCheck(CONSENT, /\bexpires_at\s*<=\s*confirmed_at\s*\+\s*interval\s*'24 hours'/);
  hasCheck(CONSENT, /\bstricter_expires_at is null\s+or\s+expires_at\s*<=\s*stricter_expires_at\b/);
  hasCheck(CONSENT, /\bstricter_expires_at is null\b[\s\S]*\bstricter_limit_ref is null\b/);
  hasCheck(CONSENT, /\bstricter_expires_at is not null\b[\s\S]*\bstricter_limit_ref is not null\b/);
  hasCheck(CONSENT, /\blength\(btrim\(stricter_limit_ref\)\)\s*>\s*0\b/);
});

test('source/digest formats and bounded integer versions are declared on durable identities', () => {
  assert.match(column(CONTROL, 'version'), /\binteger not null default 0\b/);
  hasCheck(CONTROL, /\bversion\s*>=\s*0\b/);
  for (const name of [CONSENT, RECEIPT]) {
    for (const field of ['source_snapshot_hash', 'payload_digest']) {
      assert.match(column(name, field), /\bchar\(64\) not null\b/);
      hasCheck(name, new RegExp(`\\b${field}\\s*~\\s*'\\^\\[0-9a-f\\]\\{64\\}\\$'`));
    }
    for (const field of ['source_objective_version', 'canonical_binding_version']) {
      assert.match(column(name, field), /\binteger not null\b/);
      hasCheck(name, new RegExp(`\\b${field}\\s*>\\s*0\\b`));
    }
  }
  hasCheck(RECEIPT, /\bcommand_objective_version\s*>\s*0\b/);
  for (const field of ['control_version_before', 'control_version_after']) {
    assert.match(column(RECEIPT, field), /\binteger not null\b/);
    hasCheck(RECEIPT, new RegExp(`\\b${field}\\s*>=\\s*0\\b`));
  }
  hasCheck(CONSENT, /\bprevious_consent_id is null or previous_consent_id\s*<>\s*id\b/);
});

test('cancellation permits an expired original root with a null head and complete cancellation metadata', () => {
  assert.doesNotMatch(column(CONTROL, 'current_consent_id'), /\bnot null\b/);
  for (const field of ['target_consent_id', 'created_consent_id', 'result_consent_id']) {
    assert.doesNotMatch(column(RECEIPT, field), /\bnot null\b/);
  }
  hasCheck(CONTROL, /\bcancelled_at is null and cancelled_by_user_id is null\b/);
  hasCheck(CONTROL, /\bcancelled_at is not null and cancelled_by_user_id is not null\b/);
  hasCheck(CONTROL, /\bversion\s*=\s*0 and current_consent_id is null and cancelled_at is null\b/);
  hasCheck(CONTROL, /\bversion\s*>\s*0 and \(current_consent_id is not null or cancelled_at is not null\)/);
  hasCheck(RECEIPT, /command_kind\s*=\s*'cancel' and created_consent_id is null and result_consent_id is not distinct from target_consent_id/);
  hasCheck(RECEIPT, /outcome\s*=\s*'unchanged' and control_version_after\s*=\s*control_version_before/);
  const guard = functionBody('objective_work_control_guard');
  assert.match(guard, /elsif old\.cancelled_at is not null or new\.current_consent_id is distinct from old\.current_consent_id then/);
  assert.doesNotMatch(guard, /\b(?:expires_at|confirmed_at)\b/,
    'control cancellation must not consume an unexpired historical workload grant');
});

test('receipt commands and transitions are exact, with a distinct new retry identity and no version arithmetic wrap', () => {
  hasCheck(RECEIPT, /\bjsonb_typeof\(command\)\s*=\s*'object'/);
  // SQL keyword normalization must not conceal a JSON wire-key case change.
  const rawCommandCheck = source.match(/\bconstraint\s+objective_work_receipts_command_check\s+check\s*\(\s*command\s*=\s*jsonb_build_object\s*\(/i);
  assert.ok(rawCommandCheck, 'missing raw receipt command argument clause');
  const argumentStart = rawCommandCheck.index + rawCommandCheck[0].lastIndexOf('(');
  const rawArguments = source.slice(argumentStart + 1, closingParen(source, argumentStart));
  const rawKeys = [...rawArguments.matchAll(/'([^']*)'\s*,/g)].map((match) => match[1]);
  assert.deepEqual(rawKeys, [
    'schemaVersion', 'requestId', 'command', 'workAction', 'expectedObjectiveVersion',
    'expectedControlVersion', 'expectedCanonicalBindingVersion', 'targetAuthorizationRequestId',
  ]);
  const commandCheck = checks(RECEIPT).find((check) => /^command\s*=\s*jsonb_build_object\(/.test(check));
  assert.ok(commandCheck, 'receipt must compare the complete command to its relational identity');
  assert.equal(commandCheck.replace(/\s/g, ''),
    "command=jsonb_build_object('schemaversion',1,'requestid',request_id,'command',command_kind,'workaction',work_action," +
    "'expectedobjectiveversion',command_objective_version,'expectedcontrolversion',control_version_before," +
    "'expectedcanonicalbindingversion',canonical_binding_version,'targetauthorizationrequestid',target_consent_id)");
  hasCheck(RECEIPT, /command_kind\s*=\s*'retry' and outcome\s*=\s*'reconsent_recorded' and created_consent_id is not null and result_consent_id is not null and created_consent_id\s*=\s*result_consent_id/);
  hasCheck(RECEIPT, /\bcreated_consent_id is distinct from target_consent_id\b/);
  hasCheck(RECEIPT, /\bcontrol_version_after::bigint\s*=\s*control_version_before::bigint\s*\+\s*1\b/);
  const transitionIndex = sql.match(/create unique index [a-z_][a-z0-9_]* on client_objective_work_command_receipts\s*\(([^)]*)\)\s*where outcome\s*<>\s*'unchanged'/);
  assert.ok(transitionIndex, 'only one advancing receipt may claim a control version');
  assert.deepEqual(columns(transitionIndex[1]), [...S, 'control_id', 'control_version_after']);
});

test('immutable guards freeze consent/receipt rows and only allow a one-step mutable control transition', () => {
  const immutable = functionBody('objective_work_record_immutable');
  assert.match(immutable, /^begin raise exception '[^']+' using errcode\s*=\s*'23514'; end$/);
  assert.match(trigger('objective_work_consents_immutable'),
    /before update on client_objective_work_consents for each row execute function objective_work_record_immutable\(\)/);
  assert.match(trigger('objective_work_receipts_immutable'),
    /before update on client_objective_work_command_receipts for each row execute function objective_work_record_immutable\(\)/);
  const guard = functionBody('objective_work_control_guard');
  assert.match(trigger('objective_work_controls_guard'), /before insert or update on client_objective_work_controls/);
  assert.match(guard, /if tg_op\s*=\s*'insert' then if new\.version\s*<>\s*0 or new\.current_consent_id is not null or new\.cancelled_at is not null then/);
  const allowed = ['version', 'current_consent_id', 'cancelled_at', 'cancelled_by_user_id', 'updated_at'];
  for (const side of ['new', 'old']) {
    const match = guard.match(new RegExp(`to_jsonb\\(${side}\\)\\s*-\\s*array\\[([^\\]]*)\\]`));
    assert.ok(match, `missing ${side} identity comparison`);
    assert.deepEqual(columns(match[1]).map((field) => field.replaceAll("'", '')), allowed);
  }
  assert.match(guard, /\bis distinct from\b/);
  assert.match(guard, /new\.version::bigint\s*<>\s*old\.version::bigint\s*\+\s*1/);
  assert.match(guard, /new\.current_consent_id is null or new\.current_consent_id is not distinct from old\.current_consent_id/);
  assert.match(guard, /raise exception '[^']+' using errcode\s*=\s*'23514'/);
});

test('each advancing control mutation requires a deferred exact before/after receipt', () => {
  assert.match(trigger('objective_work_controls_receipt_guard'),
    /create constraint trigger [a-z_]+ after update on client_objective_work_controls deferrable initially deferred for each row execute function objective_work_control_receipt_guard\(\)/);
  const guard = functionBody('objective_work_control_receipt_guard');
  assert.match(guard, /if not exists \( select 1 from client_objective_work_command_receipts r/);
  tupleComparison(guard,
    [...S, 'control_id', ...P].map((field) => `r.${field}`), '=',
    [...S, 'id', ...P].map((field) => `new.${field}`));
  assert.match(guard, /r\.control_version_before\s*=\s*old\.version and r\.control_version_after\s*=\s*new\.version/);
  assert.match(guard, /r\.target_consent_id is not distinct from old\.current_consent_id/);
  assert.match(guard, /r\.result_consent_id is not distinct from new\.current_consent_id/);
  assert.match(guard, /new\.cancelled_at is null and r\.command_kind\s*=\s*'retry' and r\.outcome\s*=\s*'reconsent_recorded'/);
  assert.match(guard, /new\.cancelled_at is not null and r\.command_kind\s*=\s*'cancel' and r\.outcome\s*=\s*'cancellation_recorded'/);
  assert.match(guard, /r\.actor_user_id\s*=\s*new\.cancelled_by_user_id and new\.cancelled_at\s*<=\s*r\.committed_at/);
  assert.match(guard, /raise exception '[^']+' using errcode\s*=\s*'23514'/);
});

test('both inserted consent and receipt sides receive deferred reciprocal checks of exact immutable lineage', () => {
  for (const [name, relation] of [
    ['objective_work_consents_receipt_guard', CONSENT],
    ['objective_work_receipts_consent_guard', RECEIPT],
  ]) {
    assert.match(trigger(name), new RegExp(`create constraint trigger [a-z_]+ after insert on ${relation} deferrable initially deferred for each row execute function objective_work_consent_receipt_guard\\(\\)`));
  }
  const guard = functionBody('objective_work_consent_receipt_guard');
  assert.match(guard, /if tg_table_name\s*=\s*'client_objective_work_consents' then c\s*:=\s*new/);
  assert.match(guard, /where id\s*=\s*c\.command_receipt_id and tenant_id\s*=\s*c\.tenant_id and client_id\s*=\s*c\.client_id and objective_id\s*=\s*c\.objective_id and work_action\s*=\s*c\.work_action and control_id\s*=\s*c\.control_id/);
  assert.match(guard, /if not found or r\.created_consent_id is distinct from c\.id then/);
  tupleComparison(guard,
    ['control_id', ...R, ...P, 'canonical_binding_version', 'consenting_actor_user_id', 'consenting_membership_id', 'command_request_id', 'command_receipt_id', 'payload_digest'].map((field) => `c.${field}`),
    'is distinct from',
    ['control_id', ...R, ...P, 'canonical_binding_version', 'actor_user_id', 'actor_membership_id', 'request_id', 'id', 'payload_digest'].map((field) => `r.${field}`));
  assert.match(guard, /c\.previous_consent_id is distinct from r\.target_consent_id/);
  assert.match(guard, /c\.confirmed_at\s*>\s*r\.committed_at/);
  assert.match(guard, /or r\.committed_at\s*>=\s*c\.expires_at/,
    'retry receipt issuance must precede consent expiry; do not deny historical reads using the current clock');
  assert.match(guard, /r\.command_revision_id\s*<>\s*r\.source_revision_id or r\.command_objective_version\s*<>\s*r\.source_objective_version/);
  assert.match(guard, /p\.binding_version\s*<>\s*r\.canonical_binding_version/,
    'new receipt must check the observed mutable version without a historical FK');
  assert.match(guard, /v\.operation\s*=\s*'confirm_ready'/);
  assert.match(guard, /v\.snapshot->>'status'\s*=\s*'ready'/);
  assert.match(guard, /if r\.command_kind\s*=\s*'retry' or r\.target_consent_id is null then/);
  tupleComparison(guard,
    ['requested_intent_id', 'requested_objective_revision_id', 'requested_objective_version', 'requested_snapshot_hash'].map((field) => `p.${field}`),
    'is distinct from',
    ['root_intent_id', 'source_revision_id', 'source_objective_version', 'source_snapshot_hash'].map((field) => `r.${field}`));
  assert.match(guard, /if r\.outcome\s*=\s*'unchanged' and \(ctl\.version\s*<>\s*r\.control_version_after or ctl\.current_consent_id is distinct from r\.target_consent_id or ctl\.cancelled_at is null\)/);
  assert.match(guard, /raise exception '[^']+' using errcode\s*=\s*'23514'/);
});

test('all new tables retain Core tenant RLS and narrow application DML without role or grant expansion', () => {
  for (const name of TABLES) {
    assert.match(sql, new RegExp(`alter table ${name} enable row level security`));
    assert.match(sql, new RegExp(`alter table ${name} force row level security`));
    assert.match(sql, new RegExp(`create policy [a-z_]+ on ${name} using \\(rls_bypass\\(\\) or tenant_id\\s*=\\s*current_tenant_id\\(\\)\\) with check \\(rls_bypass\\(\\) or tenant_id\\s*=\\s*current_tenant_id\\(\\)\\)`));
  }
  const revokes = [...sql.matchAll(/\brevoke ([a-z, ]+) on ([a-z_, ]+) from capiro_app\b/g)]
    .map((match) => ({ privileges: columns(match[1]), relations: columns(match[2]) }));
  for (const name of TABLES) {
    for (const privilege of ['delete', 'truncate', ...([CONSENT, RECEIPT].includes(name) ? ['update'] : [])]) {
      assert.ok(revokes.some((revoke) => revoke.relations.includes(name) && revoke.privileges.includes(privilege)),
        `missing direct ${privilege.toUpperCase()} revoke on ${name}`);
    }
  }
  assert.doesNotMatch(sql, /\bgrant\b|\bcreate\s+(?:role|user)\b|\balter default privileges\b/);
  assert.doesNotMatch(sql, /\bsecurity definer\b|\bdisable row level security\b|\bdisable trigger\b/);
  assert.doesNotMatch(sql, /\b(?:drop table|drop column|truncate table|delete from|insert into)\b/,
    'additive record definitions must not backfill, delete or dispatch existing work');
});
