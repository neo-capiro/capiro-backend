// Read-only inventory of the test account's workspace, used to map each case's
// behavior onto real capiro-internal data. Writes only a local JSON file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { withTestAccount } from './auth.mjs';

const out = process.argv[2] ?? 'C:/dev/main/outputs/meri-simple-20261005/capiro-internal';
mkdirSync(out, { recursive: true });
await withTestAccount(async ({ me, json, request }) => {
  const listed = await json('/api/clients');
  const clients = (Array.isArray(listed) ? listed : listed?.data ?? listed?.items ?? listed?.clients ?? []);
  const rows = [];
  for (const c of clients.slice(0, 60)) {
    const memory = await request(`/api/memory/items?clientId=${c.id}`).then(async (r) => (r.ok ? r.json() : { status: r.status }));
    const items = Array.isArray(memory) ? memory : [];
    rows.push({
      id: c.id, name: c.name, memoryWall: c.memoryWall ?? null,
      memoryItems: items.length,
      memoryByState: items.reduce((a, i) => ({ ...a, [i.status ?? i.lifecycle ?? 'unknown']: (a[i.status ?? i.lifecycle ?? 'unknown'] ?? 0) + 1 }), {}),
      memoryTypes: [...new Set(items.map((i) => i.type))].slice(0, 8),
    });
  }
  const conversations = await request('/api/clio/conversations').then(async (r) => (r.ok ? r.json() : { status: r.status }));
  const result = {
    at: new Date().toISOString(),
    me: { userId: me.user?.id, email: me.user?.email, role: me.role, tenant: me.tenant?.slug, features: me.features },
    clientCount: clients.length,
    clients: rows,
    conversationCount: Array.isArray(conversations) ? conversations.length : conversations,
  };
  writeFileSync(`${out}/inventory.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ role: result.me.role, tenant: result.me.tenant, clientCount: result.clientCount,
    clients: rows.map((r) => `${r.name} [mem ${r.memoryItems}${r.memoryWall ? ', walled' : ''}]`) }, null, 1));
});
