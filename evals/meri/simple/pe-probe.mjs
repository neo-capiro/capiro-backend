// Read-only: find real program elements whose current cycle has a request and
// both chamber marks, to point the budget cases (20-24, 26) at real records.
import { writeFileSync } from 'node:fs';
import { withTestAccount } from './auth.mjs';

const out = process.argv[2] ?? 'C:/dev/main/outputs/meri-simple-20261005/capiro-internal/pe-probe.json';
await withTestAccount(async ({ json, request }) => {
  const found = [];
  for (const q of ['space sensor', 'missile', 'tactical radio', 'electronic warfare', 'hypersonic']) {
    const listed = await json(`/api/program-elements?q=${encodeURIComponent(q)}&has_data=true&limit=15`);
    const rows = listed?.data ?? listed?.items ?? listed?.rows ?? (Array.isArray(listed) ? listed : []);
    for (const pe of rows) {
      const code = pe.peCode ?? pe.pe_code ?? pe.code;
      if (!code || found.some((f) => f.code === code)) continue;
      const r = await request(`/api/program-elements/${encodeURIComponent(code)}/narrative`);
      if (!r.ok) continue;
      const narrative = await r.json();
      const text = JSON.stringify(narrative);
      const has = (re) => re.test(text);
      found.push({ code, title: pe.title ?? pe.name, service: pe.service, query: q,
        request: has(/request/i), house: has(/house|hasc|hac/i), senate: has(/senate|sasc|sac/i),
        enacted: has(/enact/i), fy27: has(/2027|FY ?27/i), sample: text.slice(0, 600) });
      if (found.length >= 40) break;
    }
  }
  writeFileSync(out, JSON.stringify(found, null, 2) + '\n');
  for (const f of found.filter((x) => x.request && x.house && x.senate && x.fy27).slice(0, 12))
    console.log(JSON.stringify({ code: f.code, title: f.title, service: f.service, enacted: f.enacted }));
  console.log('candidates', found.length);
});
