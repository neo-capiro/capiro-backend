// Automatic checks for the simplified acceptance contract (section 3). They are
// aids with explicit severities: `fail` blocks a pass; `flag` asks the human
// reviewer to look. Facts about real records are judged by the human verdict.
const norm = (s) =>
  String(s ?? '')
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .toLowerCase();

export function runChecks(c, run, original, clientNames) {
  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });
  const last = run.turns.at(-1);

  // Operation: reads make no proposals; writes make exactly one. A memory
  // save makes exactly one save_memory proposal.
  const expected = c.op === 'read' ? 0 : 1;
  const tools = run.proposals.map((p) => p.tool);
  const ok = run.proposals.length === expected && (c.op !== 'memory_save' || tools[0] === 'save_memory');
  add('operation', ok ? 'pass' : 'fail',
    `${run.proposals.length} proposals${tools.length ? ` (${tools.join(', ')})` : ''}; expected ${expected} (${c.op})`);

  // Terminal state of every turn.
  for (const [i, t] of run.turns.entries()) {
    const state = !(t.httpStatus >= 200 && t.httpStatus < 300) || !t.done ? 'error' : t.done.partial ? 'partial' : 'complete';
    const allowed = original?.terminal?.allowed ?? ['complete'];
    add(`terminal-${i + 1}`, allowed.includes(state) ? 'pass' : 'fail',
      `${state}${t.streamError ? ` (${JSON.stringify(t.streamError).slice(0, 120)})` : ''}; allowed ${allowed.join('/')}`);
  }

  // Evidence: answers that rely on workspace knowledge should cite it.
  if (c.citations) add('citations', last.citations.length ? 'pass' : 'flag', `${last.citations.length} citations`);

  // Scope: other clients of the workspace are not mentioned unless asked about.
  for (const [i, t] of run.turns.entries()) {
    const answer = norm(t.answer), prompt = norm(t.prompt);
    const own = norm(t.client ?? '');
    const others = clientNames.filter((n) => n.length > 3 && norm(n) !== own && !prompt.includes(norm(n)))
      .filter((n) => answer.includes(norm(n)));
    const banned = (t.mustNotMention ?? []).filter((n) => answer.includes(norm(n)));
    if (banned.length) add(`scope-${i + 1}`, 'fail', `mentions ${banned.join(', ')} after the client switch`);
    else add(`scope-${i + 1}`, others.length ? 'flag' : 'pass', others.length ? `mentions other clients: ${others.join(', ')}` : 'no other clients named');
  }

  // A memory proposal must leave exactly one pending candidate, not an approved fact.
  if (run.candidate)
    add('candidate', run.candidate.found && !/approved/i.test(String(run.candidate.status ?? '')) ? 'pass' : 'fail',
      run.candidate.found ? `pending candidate ${run.candidate.id} (${run.candidate.status ?? 'status unknown'})` : run.candidate.error);

  if (run.download)
    add('download', run.download.matches ? 'pass' : 'fail',
      run.download.link ? `${run.download.status} ${run.download.bytes} bytes, ${run.download.matches ? 'matches' : 'differs from'} the source` : 'no download link in the approval result');

  // Completion claims while nothing was executed.
  if (run.proposals.every((p) => !['executed', 'succeeded'].includes(p.status)) &&
    /\b(i('| ha)ve (sent|saved|exported|approved|stored|remembered)|has been (sent|saved|approved|stored))\b/.test(norm(last.answer)))
    add('no-false-completion', 'flag', 'answer claims a completed action, but nothing was executed');

  const verdict = checks.some((x) => x.status === 'fail') ? 'AUTO_FAIL'
    : checks.some((x) => x.status === 'flag') ? 'AUTO_FLAG' : 'AUTO_PASS';
  return { verdict, checks };
}
