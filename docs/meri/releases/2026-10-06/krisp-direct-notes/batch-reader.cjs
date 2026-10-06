const assert = require('node:assert/strict');
function createBackfillReader(mcp, { delayMs = 7000, sleep = ms => new Promise(r => setTimeout(r, ms)), progress = () => {} } = {}) {
  const ids = new Set(), cache = new Map();
  let lastCall = 0;
  const parse = value => value.structuredContent ?? JSON.parse(value.content.filter(c => c.type === 'text').map(c => c.text).join(''));
  async function call(name, args) {
    for (let retry = 0; retry < 5; retry++) {
      await sleep(Math.max(0, delayMs - (Date.now() - lastCall)));
      lastCall = Date.now();
      try { return await mcp.callTool(name, args); }
      catch (error) {
        if (error.code !== 429 || retry === 4) throw error;
        progress({ retry, seconds: 30 * (retry + 1) });
        await sleep(30000 * (retry + 1));
      }
    }
  }
  return async function read(name, args) {
    assert.ok(['search_meetings', 'get_multiple_documents'].includes(name));
    if (name === 'search_meetings') {
      const result = await call(name, args);
      const payload = parse(result);
      for (const row of payload.meetings ?? []) if (/^[a-f0-9]{32}$/.test(row.meeting_id)) ids.add(row.meeting_id);
      return result;
    }
    assert.deepEqual(args.include, ['notes']); assert.equal(args.format, 'json'); assert.equal(args.ids.length, 1);
    const id = args.ids[0];
    if (cache.has(id)) return cache.get(id);
    const batch = [id, ...[...ids].filter(other => other !== id && !cache.has(other)).slice(0, 4)];
    const result = await call(name, { ...args, ids: batch });
    const payload = parse(result);
    const rows = payload.results;
    assert.ok(Array.isArray(rows));
    // A near-cap or explicitly shortened response is fetched individually instead.
    const complete = JSON.stringify(payload).length < 100000 && rows.every(row => !row.truncated && !row.document?.truncated && !/truncat|characters\s+(?:dropped|omitted)/i.test(row.document?.notes ?? ''));
    if (complete) for (const row of rows) if (batch.includes(row.id)) cache.set(row.id, { structuredContent: { results: [row] } });
    if (!cache.has(id)) cache.set(id, await call(name, args));
    return cache.get(id);
  };
}
module.exports = { createBackfillReader };
