/** Pure scope and source-walk policy. All filesystem effects are supplied ports. */
const FRONTEND_ROOTS = ['apps/web', 'apps/onboard-web'];

export function parseKnowledgeCensusInvocation(args) {
  // The legacy full command consumes only argv[2] and ignores tail operands.
  // Strict grammar belongs to an explicitly requested new scope, including
  // malformed scope spellings, so a typo cannot silently request full mode.
  if (!args.some((arg) => typeof arg === 'string' && /^--(?:backend|frontend|scope)/i.test(arg.trim()))) {
    return { scope: 'full', base: args[0] || 'origin/main' };
  }
  let scope = 'full';
  let base;
  let selected = false;
  for (const arg of args) {
    if (typeof arg !== 'string' || !arg || arg.trim() !== arg || /[\s\0]/.test(arg)) {
      throw new Error('arguments must be nonempty, unpadded strings');
    }
    if (arg === '--backend-only' || arg === '--frontend-only') {
      if (selected) throw new Error('select exactly one scope, once');
      scope = arg === '--backend-only' ? 'backend' : 'frontend';
      selected = true;
    } else {
      if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
      if (base !== undefined) throw new Error('provide at most one Git base');
      if (!/^[A-Za-z0-9._/@^~-]+$/.test(arg)) throw new Error('invalid scoped Git ref');
      base = arg;
    }
  }
  return { scope, base: base ?? 'origin/main' };
}

function validPath(path) {
  if (typeof path !== 'string' || !path || /[\0\r\n\t\\"]/.test(path) ||
      path.startsWith('/') || path.endsWith('/') ||
      path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`noncanonical source path: ${path}`);
  }
  return path;
}

export function knowledgeCensusPathScope(path) {
  validPath(path);
  return FRONTEND_ROOTS.some((root) => path === root || path.startsWith(root + '/'))
    ? 'frontend' : 'backend';
}

function validScope(scope) {
  if (!['full', 'backend', 'frontend'].includes(scope)) throw new Error(`unknown scope: ${scope}`);
}

export function knowledgeCensusIncludesPath(path, scope) {
  validScope(scope);
  return scope === 'full' || knowledgeCensusPathScope(path) === scope;
}

export function assertKnowledgeCensusReadPath(path, scope, ports) {
  validPath(path);
  if (!knowledgeCensusIncludesPath(path, scope)) throw new Error('source read is outside the selected scope');
  const segments = path.split('/');
  for (let i = 1; i <= segments.length; i++) {
    if (ports.lstatSync(segments.slice(0, i).join('/')).isSymbolicLink()) {
      throw new Error('symbolic source paths are not qualified for a scoped census');
    }
  }
}

function headerPath(value, prefix) {
  if (value === '/dev/null') return null;
  if (!value.startsWith(prefix + '/')) throw new Error('unsupported or malformed diff path header');
  return validPath(value.slice(2));
}

/** Validate complete sections before selecting them; no added-line filtering. */
export function partitionKnowledgeCensusDiff(diff) {
  if (typeof diff !== 'string') throw new Error('Git diff must be a string');
  if (diff === '') return [];
  const starts = [...diff.matchAll(/^diff --git /gm)].map((match) => match.index);
  if (starts[0] !== 0) throw new Error('diff has content outside a complete Git section');
  return starts.map((start, index) => {
    const text = diff.slice(start, starts[index + 1] ?? diff.length);
    const lines = text.split('\n');
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0]);
    if (!header) throw new Error('unsupported or malformed Git section header');
    const from = validPath(header[1]);
    const to = validPath(header[2]);
    let old;
    let next;
    let hunk;
    let metadata = 0;
    let metadataChange = false;
    const additions = [];
    const fields = new Map();
    const finishHunk = () => {
      if (hunk && (hunk.old !== hunk.wantOld || hunk.next !== hunk.wantNext)) {
        throw new Error('truncated or malformed diff hunk');
      }
    };
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line && i === lines.length - 1) continue;
      if (line.startsWith('@@ ')) {
        finishHunk();
        if (old === undefined || next === undefined) throw new Error('hunk is missing both file headers');
        const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
        if (!match) throw new Error('malformed diff hunk header');
        hunk = { old: 0, next: 0, wantOld: Number(match[2] ?? 1), wantNext: Number(match[4] ?? 1) };
      } else if (hunk) {
        if (line === '\\ No newline at end of file') continue;
        // A leading +/- belongs to content until both declared counts finish.
        // For example, added `++ count;` is encoded as `+++ count;`.
        if (hunk.old === hunk.wantOld && hunk.next === hunk.wantNext) {
          throw new Error('extra content after complete diff hunk');
        }
        if (line.startsWith('+')) { hunk.next += 1; additions.push(line.slice(1)); }
        else if (line.startsWith('-')) hunk.old += 1;
        else if (line.startsWith(' ')) { hunk.old += 1; hunk.next += 1; }
        else throw new Error('unsupported diff hunk content');
      } else if (line.startsWith('--- ')) {
        if (old !== undefined) throw new Error('duplicate old diff path');
        old = headerPath(line.slice(4), 'a');
        if (old !== null && old !== from) throw new Error('old diff path disagrees with section');
      } else if (line.startsWith('+++ ')) {
        if (next !== undefined) throw new Error('duplicate new diff path');
        next = headerPath(line.slice(4), 'b');
        if (next !== null && next !== to) throw new Error('new diff path disagrees with section');
      } else if (/^(?:index |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to )/.test(line)) {
        const field = /^(index|old mode|new mode|new file mode|deleted file mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to) (.+)$/.exec(line);
        if (!field || fields.has(field[1])) throw new Error('empty or duplicate diff metadata');
        const [, key, value] = field;
        if ((key === 'index' && !/^[0-9a-f]+\.\.[0-9a-f]+(?: \d{6})?$/.test(value)) ||
            (key.endsWith('mode') && !/^\d{6}$/.test(value)) ||
            (key.endsWith('index') && key !== 'index' && !/^(?:100|[0-9]{1,2})%$/.test(value))) {
          throw new Error('malformed diff metadata');
        }
        if (key.endsWith('from') || key.endsWith('to')) {
          validPath(value);
          if (value !== (key.endsWith('from') ? from : to)) throw new Error('rename/copy path disagrees with section');
        }
        fields.set(key, value);
        metadata += 1;
        if (key.endsWith('mode') || key.startsWith('rename ') || key.startsWith('copy ')) metadataChange = true;
      } else {
        throw new Error('unsupported diff metadata (including binary or quoted paths)');
      }
    }
    finishHunk();
    if ((old === undefined) !== (next === undefined)) throw new Error('diff is missing one file header');
    if (!hunk && !metadata) throw new Error('empty or malformed Git section');
    if (!hunk && (old !== undefined || !metadataChange)) throw new Error('file diff is missing its hunks');
    if (old === null && next === null) throw new Error('diff has no source identity');
    for (const [left, right] of [['old mode', 'new mode'], ['rename from', 'rename to'], ['copy from', 'copy to']]) {
      if (fields.has(left) !== fields.has(right)) throw new Error('diff has incomplete paired metadata');
    }
    if (fields.has('new file mode') && fields.has('deleted file mode')) throw new Error('conflicting diff file modes');
    const path = next ?? old ?? to;
    return { path, scope: knowledgeCensusPathScope(path), text, additions };
  });
}

export function projectKnowledgeCensusDiff(diff, scope) {
  validScope(scope);
  // Legacy full behavior, including Git warning/skip semantics, stays exact.
  if (scope === 'full') return diff;
  return partitionKnowledgeCensusDiff(diff).filter((part) => part.scope === scope)
    .map((part) => part.text).join('');
}
