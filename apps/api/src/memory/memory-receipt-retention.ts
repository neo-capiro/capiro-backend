import type { Prisma } from '@prisma/client';

type ReceiptColumnShape = {
  relationKind: string; persistence: string; rowSecurityEnabled: boolean; rowSecurityForced: boolean;
  hasChildren: boolean; columnName: string; typeName: string; builtInType: boolean;
  typeModifier: number; notNull: boolean; hasDefault: boolean;
};
const CONTENT_FREE_RECEIPT_COLUMNS = [
  ['tenant_id', 'uuid', -1, true, false],
  ['candidate_id', 'uuid', -1, true, false],
  ['candidate_sha256', 'bpchar', 68, true, false],
  ['proposer_user_id', 'uuid', -1, true, false],
  ['review_id', 'uuid', -1, true, false],
  ['created_at', 'timestamptz', 6, true, true],
] as const;

/** Shared disposition prerequisite for every Core memory purger. The original
 * receipt held a second payload; renaming that column cannot make it safe.
 * ACCESS SHARE from the first read holds this verified shape through commit.
 */
export async function memoryReceiptsAreContentFreeInTx(tx: Prisma.TransactionClient, tenantId: string) {
  await tx.$queryRaw`SELECT 1 FROM clio_meri_memory_submissions WHERE tenant_id=${tenantId}::uuid LIMIT 1`;
  const rows = await tx.$queryRaw<ReceiptColumnShape[]>`
    SELECT c.relkind::text AS "relationKind", c.relpersistence::text AS "persistence",
      c.relrowsecurity AS "rowSecurityEnabled", c.relforcerowsecurity AS "rowSecurityForced",
      c.relhassubclass AS "hasChildren", a.attname AS "columnName", t.typname AS "typeName",
      (t.typnamespace = 'pg_catalog'::regnamespace) AS "builtInType",
      a.atttypmod AS "typeModifier", a.attnotnull AS "notNull", a.atthasdef AS "hasDefault"
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
    JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
    WHERE c.oid='clio_meri_memory_submissions'::regclass AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY a.attnum
  `;
  return rows.length === CONTENT_FREE_RECEIPT_COLUMNS.length && rows.every((row, i) => {
    const expected = CONTENT_FREE_RECEIPT_COLUMNS[i];
    return expected !== undefined && row.relationKind === 'r' && row.persistence === 'p' &&
      row.rowSecurityEnabled === true && row.rowSecurityForced === true &&
      row.hasChildren === false && row.builtInType === true &&
      row.columnName === expected[0] && row.typeName === expected[1] &&
      row.typeModifier === expected[2] && row.notNull === expected[3] && row.hasDefault === expected[4];
  });
}
