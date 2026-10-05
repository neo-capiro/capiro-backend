// Read-only QA audit. Supply PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE.
const { createRequire } = require('node:module');
const path = require('node:path');
const { Client } = createRequire(path.resolve(__dirname, '../apps/api/package.json'))('pg');
async function main() {
  const db = new Client({ connectionTimeoutMillis: 10000, ssl: { rejectUnauthorized: true } });
  await db.connect();
  try {
    await db.query("BEGIN READ ONLY; SET LOCAL statement_timeout = '30s'");
    const out = {};
    out.clientScope = (await db.query(`SELECT a.tenant_id,
      CASE WHEN c.id IS NULL THEN 'missing_client' WHEN a.tenant_id<>c.tenant_id::text THEN 'foreign_tenant'
        WHEN c.status='archived' THEN 'archived_client' ELSE 'portfolio_client' END AS attribution,
      count(*) AS alerts FROM intel_alert a LEFT JOIN clients c ON c.id::text=lower(a.client_id)
      GROUP BY a.tenant_id,attribution ORDER BY a.tenant_id,attribution`)).rows;
    out.clients = (await db.query(`SELECT c.id,c.tenant_id,c.name,c.status,
      (SELECT count(*) FROM intel_alert a WHERE a.tenant_id=c.tenant_id::text AND lower(a.client_id)=c.id::text) AS alerts
      FROM clients c WHERE name ILIKE 'L3%Harris%' OR name IN
      ('OVERLAND AI','Jaia Robotics','Aperture Defense Systems','BBG Aerosystems (Fulcrum Autonomy)','GigaWeld','Perseus Defense','Balkan Energy DMCC') ORDER BY tenant_id,name`)).rows;
    out.floridaBills = (await db.query(`SELECT id,status,status_at,latest_action_text,current_committee_id FROM state_bill
      WHERE id IN ('fl-2026-h1211','fl-2026-s0474')`)).rows;
    out.commerce = (await db.query(`SELECT c.id,c.name,c.chamber,c.legislative_session,c.official_source_key,c.source_evidence,
      (SELECT count(*) FROM committee_hearing h WHERE h.state_committee_id=c.id) AS hearings,
      (SELECT count(*) FROM state_bill b WHERE b.current_committee_id=c.id) AS bills
      FROM state_committee c WHERE state='FL' AND name ILIKE '%commerce%'`)).rows;
    out.floridaCalendar = (await db.query(`SELECT id,title,committee_name,state_committee_id,legislative_session,calendar_snapshot
      FROM committee_hearing WHERE geographic_jurisdiction='FL' AND date BETWEEN '2026-02-09' AND '2026-02-15'
      AND committee_name ILIKE '%commerce%'`)).rows;
    out.federalHearings = (await db.query(`SELECT id,title,committee_name,committee_code,committee_system_code,subcommittee_system_code,
      starts_at,date,url,canonical_hearing_id FROM committee_hearing
      WHERE id='sen-119-338758' OR (date BETWEEN '2026-09-28' AND '2026-10-04' AND
      (title ILIKE '%Ukraine%' OR title ILIKE '%patent%' OR title ILIKE '%USPTO%'))`)).rows;
    console.log(JSON.stringify(out, null, 2));
  } finally { await db.query('ROLLBACK').catch(() => {}); await db.end(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
