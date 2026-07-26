"""Static cross-check: every new Prisma field/index has a matching migration column.

This is the mechanical part of plan 5.2 that does NOT need a live database. It
catches schema<->migration drift, which is the failure mode that would make
`prisma migrate deploy` succeed while the client queries a column that does not
exist (or vice versa).
"""
import io
import re
import sys

SCHEMA = 'apps/api/prisma/schema.prisma'
MIGRATION = 'apps/api/prisma/migrations/20260727010000_engagement_trust_boundary/migration.sql'

MODELS = [
    ('OutreachDraftArtifact', 'outreach_draft_artifacts'),
    ('OutreachDraftVersion', 'outreach_draft_versions'),
    ('OutreachSendIntent', 'outreach_send_intents'),
    ('OutreachDelivery', 'outreach_deliveries'),
]

schema = io.open(SCHEMA, encoding='utf-8').read()
sql = io.open(MIGRATION, encoding='utf-8').read()

failures = []
checked_columns = 0


def model_block(name):
    m = re.search(r'^model %s \{(.*?)^\}' % name, schema, re.S | re.M)
    assert m, 'model %s not found' % name
    return m.group(1)


def table_block(table):
    m = re.search(r'CREATE TABLE "%s" \((.*?)\n\);' % table, sql, re.S)
    assert m, 'CREATE TABLE %s not found' % table
    return m.group(1)


RELATION_TYPES = set(n for n, _ in MODELS) | {
    'Tenant', 'User', 'OutreachRecord', 'IntegrationConnection', 'ReviewRequest', 'ContextPacket',
}

for model, table in MODELS:
    body = model_block(model)
    cols = table_block(table)
    sql_columns = set(re.findall(r'"([a-z_0-9]+)"\s+(?:UUID|TEXT|JSONB|INTEGER|BOOLEAN|VARCHAR|TIMESTAMPTZ)', cols))

    for line in body.splitlines():
        line = line.strip()
        if not line or line.startswith('//') or line.startswith('///') or line.startswith('@@'):
            continue
        m = re.match(r'^(\w+)\s+(\w+)(\[\])?(\?)?', line)
        if not m:
            continue
        field, ftype, is_list = m.group(1), m.group(2), m.group(3)
        # Skip relation fields (they are not columns).
        if is_list or (ftype in RELATION_TYPES and '@relation' in line and 'fields:' not in line):
            continue
        if ftype in RELATION_TYPES and 'fields:' in line:
            continue  # the FK scalar is declared separately
        mapped = re.search(r'@map\("([^"]+)"\)', line)
        column = mapped.group(1) if mapped else field
        checked_columns += 1
        if column not in sql_columns:
            failures.append('%s.%s -> column "%s" MISSING from %s' % (model, field, column, table))

    # Declared indexes/uniques must exist in the migration by their map name.
    for idx_name in re.findall(r'@@(?:unique|index)\([^)]*map:\s*"([^"]+)"\)', body):
        if idx_name not in sql:
            failures.append('%s: index "%s" not created in migration' % (model, idx_name))

# Structural requirements the plan states explicitly.
for _, table in MODELS:
    for required, label in [
        ('ALTER TABLE "%s" ENABLE ROW LEVEL SECURITY' % table, 'RLS enabled'),
        ('ALTER TABLE "%s" FORCE ROW LEVEL SECURITY' % table, 'RLS FORCED'),
        ('CREATE POLICY "%s_isolation" ON "%s"' % (table, table), 'isolation policy'),
        ('GRANT SELECT, INSERT, UPDATE, DELETE ON "%s" TO capiro_app' % table, 'capiro_app grant'),
        ('REFERENCES "tenants"("id")', 'tenant FK'),
    ]:
        if required not in sql:
            failures.append('%s: %s missing' % (table, label))
    # The canonical policy predicate, both USING and WITH CHECK.
    pol = re.search(r'CREATE POLICY "%s_isolation" ON "%s"(.*?);' % (table, table), sql, re.S)
    if pol:
        text = pol.group(1)
        if text.count('rls_bypass() OR tenant_id = current_tenant_id()') != 2:
            failures.append('%s: policy is not the canonical USING+WITH CHECK shape' % table)

# updated_at triggers only where the column exists.
for _, table in MODELS:
    has_updated_at = '"updated_at"' in table_block(table)
    has_trigger = 'CREATE TRIGGER "%s_set_updated_at"' % table in sql
    if has_updated_at != has_trigger:
        failures.append(
            '%s: updated_at column=%s but trigger=%s' % (table, has_updated_at, has_trigger))

# Additive: nothing the plan protects may be dropped.
for forbidden in ['DROP TABLE', 'DROP COLUMN', 'TRUNCATE',
                  'DELETE FROM "review_request"', 'DELETE FROM "outreach_records"']:
    if forbidden in sql.upper() if forbidden.isupper() else forbidden in sql:
        failures.append('migration contains forbidden destructive statement: %s' % forbidden)

# The only permitted drop is the outreach_jobs request-key index, inside the branch.
drops = re.findall(r'DROP INDEX[^;]*;', sql)
for d in drops:
    if 'outreach_jobs_tenant_request_key' not in d:
        failures.append('unexpected DROP INDEX: %s' % d.strip())

print('columns cross-checked: %d' % checked_columns)
print('DROP INDEX statements: %d (all scoped to outreach_jobs_tenant_request_key)' % len(drops))
if failures:
    print('\nFAILURES (%d):' % len(failures))
    for f in failures:
        print('  - ' + f)
    sys.exit(1)
print('\nOK: schema and migration agree; RLS forced + canonical policy on all 4 tables;')
print('    triggers match updated_at presence; migration is additive.')
