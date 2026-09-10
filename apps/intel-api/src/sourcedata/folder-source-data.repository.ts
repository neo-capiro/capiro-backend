import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/** Florida's canonical provider uses H/S; the legislature also displays HB/SB.
 * This is a lookup alias only: never rename canonical IDs or coerce proposals.
 */
export function normalizeBillNumber(value: string, jurisdiction?: string): string | null {
  const match = /^([A-Z][A-Z.]*)\s*0*(\d+)$/i.exec(value.trim());
  if (!match) return null;
  let prefix = match[1]!.replaceAll('.', '').toUpperCase();
  if (jurisdiction === 'FL' && (prefix === 'H' || prefix === 'S')) prefix += 'B';
  return `${prefix}${BigInt(match[2]!).toString()}`;
}

// Keep the SQL lookup identical to normalizeBillNumber's jurisdiction-specific alias.
export const FOLDER_NUMBER_SQL = `(CASE
  WHEN b.jurisdiction = 'FL' AND regexp_replace(upper(b.number), '[^A-Z]', '', 'g') IN ('H','S')
    THEN regexp_replace(upper(b.number), '[^A-Z]', '', 'g') || 'B'
  ELSE regexp_replace(upper(b.number), '[^A-Z]', '', 'g') END
  || coalesce(nullif(regexp_replace(b.number, '[^0-9]', '', 'g'), ''), '0')::numeric::text)`;

export interface FolderSourceBill {
  id: string;
  number: string;
  title: string;
  sponsor: string | null;
  jurisdiction: string;
  sessionKey: string;
  status: string | null;
  latestAction: string | null;
  latestActionAt: Date | null;
  sourceUrl: string | null;
  chamber?: string | null;
}

/** Global canonical read projection; no legislative copies or source mutations. */
export const FOLDER_SOURCE_SQL = `
  SELECT id, identifier AS number, title, sponsor_name AS sponsor,
    upper(state) AS jurisdiction, session_key AS "sessionKey", status,
    latest_action_text AS "latestAction", latest_action_date AS "latestActionAt",
    coalesce(state_url, url) AS "sourceUrl", chamber
  FROM state_bill
  UNION ALL
  SELECT id, upper(bill_type) || ' ' || bill_number::text AS number, title,
    sponsor_name AS sponsor, 'US' AS jurisdiction, congress::text AS "sessionKey", status,
    latest_action_text AS "latestAction", latest_action_date AS "latestActionAt", url AS "sourceUrl",
    CASE origin_chamber WHEN 'house' THEN 'lower' WHEN 'senate' THEN 'upper' ELSE origin_chamber END AS chamber
  FROM congress_bill`;

@Injectable()
export class FolderSourceDataRepository {
  constructor(private readonly prisma: PrismaService) {}
  async bills(ids: string[]): Promise<FolderSourceBill[]> {
    if (!ids.length) return [];
    return this.prisma.$queryRawUnsafe(
      `SELECT * FROM (${FOLDER_SOURCE_SQL}) b WHERE id = ANY($1::text[])`,
      ids,
    );
  }
  async sessions(jurisdiction: string): Promise<Array<{ key: string; label: string }>> {
    if (jurisdiction === 'US')
      return this.prisma.$queryRawUnsafe(
        `SELECT DISTINCT congress::text AS key, congress::text || 'th Congress' AS label FROM congress_bill ORDER BY key DESC`,
      );
    return this.prisma.$queryRawUnsafe(
      `SELECT session_key AS key, coalesce(max(nullif(session,session_key)),session_key) AS label
       FROM state_bill WHERE upper(state) = $1 GROUP BY session_key ORDER BY key DESC`,
      jurisdiction,
    );
  }
  async resolve(
    jurisdiction: string,
    sessionKey: string,
    numbers: string[],
  ): Promise<FolderSourceBill[]> {
    return this.prisma.$queryRawUnsafe(
      `SELECT * FROM (${FOLDER_SOURCE_SQL}) b
      WHERE jurisdiction = $1 AND "sessionKey" = $2
      AND ${FOLDER_NUMBER_SQL} = ANY($3::text[])`,
      jurisdiction,
      sessionKey,
      numbers,
    );
  }
  async activeMember(tenantId: string, clerkUserId: string): Promise<boolean> {
    return this.prisma.withSystem(
      async (tx) =>
        (
          await tx.$queryRawUnsafe<Array<{ ok: number }>>(
            `SELECT 1 AS ok FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id
       WHERE tm.tenant_id = $1::uuid AND u.clerk_user_id = $2 AND tm.status::text = 'active' LIMIT 1`,
            tenantId,
            clerkUserId,
          )
        ).length === 1,
    );
  }
  async members(tenantId: string) {
    return this.prisma.withSystem(
      (tx) => tx.$queryRaw<Array<{ id: string; name: string }>>`
      SELECT u.clerk_user_id AS id,coalesce(nullif(trim(concat_ws(' ',u.first_name,u.last_name)),''),'Workspace member') AS name
      FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id
      WHERE tm.tenant_id=${tenantId}::uuid AND tm.status::text='active' ORDER BY name,u.clerk_user_id`,
    );
  }
}
