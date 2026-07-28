"""Static cross-check for the Engagement trust-boundary remediation plan's two
migrations: every new Prisma field has a matching migration column, and both
migrations remain purely additive. Mirrors verify-engagement-p0-migration.py's
approach (schema<->SQL cross-check, no live database needed).

Covers:
  - 20260807010000_engagement_audit_ledger_subject
    (MeriAuditLedger.subjectType / subjectId + the subject+mode unique index)
  - 20260807020000_engagement_send_intent_fingerprint
    (OutreachSendIntent.requestFingerprint)
"""
import io
import re
import sys

SCHEMA = 'apps/api/prisma/schema.prisma'
AUDIT_LEDGER_MIGRATION = (
    'apps/api/prisma/migrations/20260807010000_engagement_audit_ledger_subject/migration.sql'
)
FINGERPRINT_MIGRATION = (
    'apps/api/prisma/migrations/20260807020000_engagement_send_intent_fingerprint/migration.sql'
)

schema = io.open(SCHEMA, encoding='utf-8').read()
audit_sql = io.open(AUDIT_LEDGER_MIGRATION, encoding='utf-8').read()
fingerprint_sql = io.open(FINGERPRINT_MIGRATION, encoding='utf-8').read()

failures = []


def model_block(name, text):
    m = re.search(r'^model %s \{(.*?)^\}' % name, text, re.S | re.M)
    assert m, 'model %s not found in schema.prisma' % name
    return m.group(1)


def forbid_destructive(sql, label):
    for forbidden in ('DROP TABLE', 'DROP COLUMN', 'TRUNCATE'):
        if forbidden in sql.upper():
            failures.append('%s: contains forbidden destructive statement: %s' % (label, forbidden))


# ---- MeriAuditLedger.subjectType / subjectId (plan §3.b2) ----------------
ledger_body = model_block('MeriAuditLedger', schema)
if 'subjectType' not in ledger_body:
    failures.append('MeriAuditLedger.subjectType missing from schema.prisma')
if 'subjectId' not in ledger_body:
    failures.append('MeriAuditLedger.subjectId missing from schema.prisma')
if '"subject_type"' not in audit_sql:
    failures.append('subject_type column missing from the audit-ledger migration SQL')
if '"subject_id"' not in audit_sql:
    failures.append('subject_id column missing from the audit-ledger migration SQL')
if 'meri_audit_ledger_subject_mode_key' not in ledger_body:
    failures.append(
        'MeriAuditLedger schema is missing the meri_audit_ledger_subject_mode_key index/unique map name'
    )
if 'CREATE UNIQUE INDEX' not in audit_sql or 'meri_audit_ledger_subject_mode_key' not in audit_sql:
    failures.append('meri_audit_ledger_subject_mode_key unique index missing from the migration SQL')

# Additive only: both new columns must be NULLABLE (no backfill exists for
# subject_type/subject_id — every pre-existing row keeps them NULL by design).
for column in ('subject_type', 'subject_id'):
    m = re.search(r'ADD COLUMN[^;]*"%s"[^;]*;' % column, audit_sql)
    if not m:
        failures.append('could not locate the ADD COLUMN statement for %s' % column)
    elif 'NOT NULL' in m.group(0):
        failures.append(
            '%s must stay nullable — it has no backfill, so NOT NULL would break every '
            'pre-existing meri_audit_ledger row' % column
        )
forbid_destructive(audit_sql, 'audit-ledger migration')

# ---- OutreachSendIntent.requestFingerprint (plan §3.c5/c6) ----------------
intent_body = model_block('OutreachSendIntent', schema)
if 'requestFingerprint' not in intent_body:
    failures.append('OutreachSendIntent.requestFingerprint missing from schema.prisma')
if '"request_fingerprint"' not in fingerprint_sql:
    failures.append('request_fingerprint column missing from the migration SQL')

# This column legitimately ends NOT NULL, but ONLY after an unconditional
# backfill — verify the three statements exist and run in the safe order.
# Search strings are the exact statements, not generic fragments like
# 'SET NOT NULL' alone — the migration's own header comment explains the
# ADD-then-backfill-then-tighten sequence in prose and happens to contain that
# exact phrase ("re-applying SET NOT NULL..."), which would match FIRST and
# report a false ordering failure if the search were not column-specific.
add_pos = fingerprint_sql.find('ADD COLUMN IF NOT EXISTS "request_fingerprint"')
backfill_pos = fingerprint_sql.find('UPDATE "outreach_send_intents"')
notnull_pos = fingerprint_sql.find('ALTER COLUMN "request_fingerprint" SET NOT NULL')
if -1 in (add_pos, backfill_pos, notnull_pos):
    failures.append(
        'request_fingerprint migration must contain ADD COLUMN, an UPDATE backfill, and SET NOT '
        'NULL — one or more is missing'
    )
elif not (add_pos < backfill_pos < notnull_pos):
    failures.append(
        'request_fingerprint statements are out of order — must be ADD (nullable) -> UPDATE '
        '(backfill) -> SET NOT NULL, or existing rows would violate the constraint mid-migration'
    )
if 'legacy:' not in fingerprint_sql:
    failures.append(
        "request_fingerprint backfill is missing the 'legacy:' placeholder prefix — a real "
        "fingerprint is always 'sha256:' + 64 hex chars, so a pre-migration intent's requestKey "
        'must backfill to a value that can never collide with one'
    )
forbid_destructive(fingerprint_sql, 'send-intent-fingerprint migration')

if failures:
    print('FAILURES (%d):' % len(failures))
    for f in failures:
        print('  - ' + f)
    sys.exit(1)

print('OK: both remediation migrations agree with schema.prisma, backfill safely, and are additive.')
