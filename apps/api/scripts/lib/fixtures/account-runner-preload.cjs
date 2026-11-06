// Explicit test-only dependency boundary; never contacts a database or network.
if (process.env.ACCOUNT_RUNNER_TEST !== '1') throw new Error('Test preload requires explicit opt-in');
const Module = require('node:module');
const fs = require('node:fs');
const original = Module._load;
const events = [];
const mode = process.env.ACCOUNT_RUNNER_TEST_MODE;
let writes = 0;
class FakePrisma {
  constructor(options) {
    const url = new URL(options?.datasourceUrl ?? process.env.DATABASE_URL);
    events.push(`construct:sslmode=${url.searchParams.get('sslmode')}`);
  }
  async $connect() { events.push('connect'); }
  async $disconnect() { events.push('disconnect'); }
  async $executeRaw() { events.push('execute'); return 0; }
  async $executeRawUnsafe() { events.push('execute'); return 0; }
  async $queryRaw(query) {
    const sql = Array.isArray(query) ? query.join('?') : query.sql ?? String(query);
    if (sql.includes('current_database')) {
      if (mode === 'secret-error') throw new Error('SERVER_SECRET_CANARY_not_a_DSN');
      return [{ db: mode === 'wrong-role' ? 'other' : 'fixture', role: 'fixture_role' }];
    }
    if (sql.includes('defproc_append_account_report_v1')) {
      events.push('append'); writes += 1;
      return [{ result: { snapshotId: `10000000-0000-4000-8000-${String(writes).padStart(12, '0')}`, inserted: true } }];
    }
    if (sql.includes('set_config')) { events.push('configuration'); return [{}]; }
    throw new Error('Unexpected test SQL');
  }
  async $transaction(work, options) {
    events.push(`transaction:${options.timeout}`);
    const result = await work(this);
    if (mode === 'lost-ack') { events.push('commit-ack-lost'); throw new Error('SERVER_SECRET_CANARY_not_a_DSN'); }
    events.push('commit-acknowledged'); return result;
  }
}
Module._load = function (request, parent, isMain) {
  if (request === 'dotenv') return { config() { return { parsed: {} }; } };
  const loaded = original.apply(this, arguments);
  return request === '@prisma/client' ? { ...loaded, PrismaClient: FakePrisma } : loaded;
};
globalThis.fetch = async (url, init) => {
  if (url !== 'https://api.usaspending.gov/api/v2/awards/funding/' || init.method !== 'POST') throw new Error('Unexpected test network call');
  events.push('fetch');
  return Response.json({ results: [], page_metadata: { page: 1, hasNext: false, next: null, hasPrevious: false, previous: null } });
};
process.on('exit', () => fs.writeSync(1, `ACCOUNT_TEST_TRACE=${JSON.stringify(events)}\n`));
