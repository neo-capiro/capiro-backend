// Read-only: real bills tracked for the primary client and real funding
// opportunities, to point cases 28-39 at real records. Writes a local JSON file.
import { readFileSync, writeFileSync } from 'node:fs';
import { withTestAccount } from './auth.mjs';
import { PRIMARY } from './capiro-internal-cases.mjs';

const dir = 'C:/dev/main/outputs/meri-simple-20261005/capiro-internal';
const inv = JSON.parse(readFileSync(`${dir}/inventory.json`, 'utf8'));
const clientId = inv.clients.find((c) => c.name === PRIMARY).id;
await withTestAccount(async ({ request }) => {
  const get = async (p) => { const r = await request(p); return r.ok ? r.json() : { status: r.status, body: (await r.text()).slice(0, 200) }; };
  const tracked = await get(`/api/intelligence/clients/${clientId}/tracked-bills`);
  const bills = await get(`/api/intelligence/clients/${clientId}/bills`);
  const opps = {};
  for (const q of ['sensor', 'space', 'radio', 'missile']) opps[q] = await get(`/api/intelligence/opportunities/v2/search?q=${q}&limit=10`);
  writeFileSync(`${dir}/records-probe.json`, JSON.stringify({ tracked, bills, opps }, null, 2));
  const pick = (x) => (Array.isArray(x) ? x : x?.data ?? x?.items ?? x?.bills ?? x?.results ?? []);
  console.log('tracked', JSON.stringify(pick(tracked).slice(0, 8).map((b) => [b.billNumber ?? b.number ?? b.billKey ?? b.bill_id, b.congress, (b.title ?? '').slice(0, 70), b.status ?? b.latestAction ?? b.stage])));
  console.log('bills', JSON.stringify(pick(bills).slice(0, 8).map((b) => [b.billNumber ?? b.number ?? b.billKey ?? b.bill_id, b.congress, (b.title ?? '').slice(0, 70), b.status ?? b.stage])));
  for (const [q, r] of Object.entries(opps)) console.log('opps', q, JSON.stringify(pick(r).slice(0, 6).map((o) => [o.noticeId ?? o.sourceRecordId ?? o.id, (o.title ?? '').slice(0, 60), o.status ?? o.opportunityStatus, o.responseDeadline ?? o.dueDate ?? o.closeDate])).slice(0, 900));
});
