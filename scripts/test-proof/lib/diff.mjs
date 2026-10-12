/**
 * diff-test-names engine.
 *
 * A dump is a MULTISET of occurrences. The diff pairs occurrences by identity
 * (package, runner, suite, fullName) — min-count pairing, so two identical
 * fullName tests never collapse. Everything the diff cannot account for is an
 * explicit failure: there is no fuzzy rename heuristic anywhere here, because a
 * heuristic would defeat the entire point of the proof.
 *
 * FAIL-CLOSED CONTRACT (review-hardened):
 *   0. Both inputs must be VALIDATED canonical dumps. Raw runner JSON, `{}`, a
 *      truncated file or an unversioned blob is rejected; it is never read as an
 *      empty passing comparison. A genuinely zero-scope run is still valid
 *      because it carries the schema, version and an explicit `scope`.
 *   1. Non-passing / incomplete EXECUTION evidence on EITHER side cannot yield
 *      an acceptance PASS: a target whose status is runner-failed / zero-tests /
 *      unsupported / error, or scope unsupported / errors / runner-failures /
 *      zero-test-targets, is reported and blocks. Useful name-diff output is
 *      still produced. pytest COLLECTED reports stay explicitly collection-only.
 *   2. A preserved name is NOT proof the case still ran: a status regression
 *      (executed -> skipped/todo/cancelled, or a newly never-run occurrence)
 *      blocks. Pre-existing identical conditional skips may remain.
 *   3. Scope identity includes the dynamically discovered target TIER. A lost or
 *      changed target/tier (even one that contributes no occurrences) blocks
 *      unless acknowledged with a concrete non-empty reason.
 *
 * Permitted (exit 0):
 *   - additions (a spec may grow; `it.each` expands)
 *   - no change
 *   - a rename explicitly listed in the rename map (before -> after), each side
 *     of the map consuming a real occurrence and nothing reused
 *   - a removal explicitly excused by a twin entry whose surviving occurrence
 *     really exists in the after dump
 *   - a gained package/runner/target (scope-added)
 *   - a lost / runner-changed / tier-changed scope entry explicitly acknowledged
 *     with a concrete reason
 *
 * Blocking (exit 2):
 *   - malformed / noncanonical input dump
 *   - non-passing or incomplete execution/collection evidence
 *   - a preserved-name status regression
 *   - any removed occurrence not excused above
 *   - any invalid map (references a before/after occurrence that is not there,
 *     reuses an occurrence, or crosses package/runner without declaring it)
 *   - a lost / changed package, runner, target or tier that is not acknowledged
 */

import {
  identityKey,
  describeIdentity,
  describeTarget,
  targetKey,
  NON_PASSING_TARGET_STATUSES,
  EXECUTED_STATUSES,
  NEVER_RUN_STATUSES,
  COLLECTION_STATUSES,
} from './schema.mjs';
import { validateDump } from './validate.mjs';

function normDump(dump) {
  const targets = Array.isArray(dump.targets) ? dump.targets : [];
  const occ = [];
  for (const t of targets) {
    for (const test of t.tests || []) {
      occ.push({
        package: t.package,
        runner: t.runner,
        tier: t.tier ?? null,
        suite: test.suite ?? '',
        fullName: test.fullName ?? '',
        status: test.status,
        targetStatus: t.status,
        used: false,
      });
    }
  }
  return occ;
}

function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

function unitOf(o) {
  return `${o.package}\u0000${o.runner}`;
}

function nameOf(o) {
  return [o.package, o.runner, o.fullName].join('\u0000');
}

function labelUnit(unit) {
  const [pkg, runner] = unit.split('\u0000');
  return `${pkg}[${runner}]`;
}

function takeUnused(list, predicate) {
  for (const item of list) {
    if (!item.used && predicate(item)) {
      item.used = true;
      return item;
    }
  }
  return null;
}

function statusCounts(list) {
  const out = {};
  for (const o of list) out[o.status] = (out[o.status] || 0) + 1;
  return out;
}

export function loadMapFile(obj, key) {
  if (Array.isArray(obj)) return obj;
  if (obj && Array.isArray(obj[key])) return obj[key];
  return [];
}

/* ------------------------------------------------------------------ shape */

function baseResult() {
  return {
    ok: false,
    error: null,
    problems: [],
    added: [],
    removed: [],
    changed: [],
    removedConsolidated: [],
    removedAcknowledgedScope: [],
    statusChanges: [],
    statusRegressions: [],
    evidence: {
      before: { incomplete: [], collectionOnly: [] },
      after: { incomplete: [], collectionOnly: [] },
    },
    validation: { before: { ok: true, problems: [] }, after: { ok: true, problems: [] } },
    scopeChanged: {
      added: [],
      removed: [],
      runnerChanged: [],
      acknowledged: [],
      targetsRemoved: [],
      targetsAdded: [],
      tierChanged: [],
      targetsAcknowledged: [],
    },
    perPackage: [],
    totals: {
      before: 0,
      after: 0,
      added: 0,
      removed: 0,
      changed: 0,
      removedConsolidated: 0,
      removedAcknowledgedScope: 0,
      statusRegressions: 0,
    },
  };
}

/* ------------------------------------------------------- evidence (finding 2) */

/**
 * Gather non-passing / incomplete execution evidence for one dump. `incomplete`
 * entries block acceptance; `collectionOnly` is a stated limitation (pytest
 * collected names prove existence, not execution) and does not block by itself.
 */
function collectEvidence(dump, label) {
  const incomplete = [];
  const collectionOnly = [];
  const seen = new Set();
  const push = (msg) => {
    if (seen.has(msg)) return;
    seen.add(msg);
    incomplete.push(msg);
  };
  for (const t of dump.targets || []) {
    if (NON_PASSING_TARGET_STATUSES.has(t.status)) {
      push(`${label} target ${describeTarget(t)} status=${t.status} exitCode=${t.exitCode ?? 'n/a'}${t.statusDetail ? ` (${t.statusDetail})` : ''}`);
    }
    const tests = Array.isArray(t.tests) ? t.tests : [];
    if (tests.length > 0 && tests.every((x) => COLLECTION_STATUSES.has(x.status))) {
      collectionOnly.push(`${label} target ${describeTarget(t)}: ${tests.length} COLLECTED name(s) — collection only, execution not proven`);
    }
  }
  const scope = dump.scope || {};
  for (const u of scope.unsupported || []) {
    push(`${label} unsupported scope ${u.package ?? u.packageDir}${u.tier ? ` tier=${u.tier}` : ''}: ${u.reason ?? 'unclassified'}`);
  }
  for (const e of scope.errors || []) {
    push(`${label} error scope ${e.package ?? e.packageDir}[${e.runner ?? '?'}]${e.tier ? ` tier=${e.tier}` : ''}: ${e.detail ?? 'error'}`);
  }
  return { incomplete, collectionOnly };
}

/* ------------------------------------------- target/tier scope (finding 4) */

function matchTargetAck({ package: pkg, runner, tier, kind, packageGone }, targetAcks, scopeAcks) {
  for (const a of targetAcks) {
    if (!a || a.package !== pkg || a.runner !== runner) continue;
    if (typeof a.reason !== 'string' || a.reason.trim() === '') continue;
    if (kind === 'tier-changed') {
      if (a.change === 'tier-changed' && (a.tier ?? a.fromTier) === tier) return a;
    } else if (a.change === 'target-removed' && (a.tier === undefined || a.tier === tier)) {
      return a;
    }
  }
  if (packageGone) {
    for (const a of scopeAcks) {
      if (a && a.package === pkg && a.runner === runner && a.change === 'lost' && typeof a.reason === 'string' && a.reason.trim() !== '') return a;
    }
  }
  return null;
}

function assessTargets(before, after, targetAcks, scopeAcks, result) {
  const beforeTargets = (before.targets || []).map((t) => ({ record: t, key: targetKey(t), package: t.package, runner: t.runner, tier: t.tier ?? null }));
  const afterTargets = (after.targets || []).map((t) => ({ record: t, key: targetKey(t), package: t.package, runner: t.runner, tier: t.tier ?? null }));

  const beforeKeys = new Map(beforeTargets.map((t) => [t.key, t]));
  const afterKeys = new Map(afterTargets.map((t) => [t.key, t]));
  const afterPackages = new Set(afterTargets.map((t) => t.package));
  const afterUnits = new Set(afterTargets.map((t) => `${t.package}\u0000${t.runner}`));

  for (const t of afterTargets) {
    if (!beforeKeys.has(t.key)) result.scopeChanged.targetsAdded.push(describeTarget(t.record));
  }

  for (const t of beforeTargets) {
    if (afterKeys.has(t.key)) continue;
    const packageGone = !afterPackages.has(t.package);
    const runnerGone = !afterUnits.has(`${t.package}\u0000${t.runner}`);
    const kind = packageGone || runnerGone ? 'target-removed' : 'tier-changed';
    const label = describeTarget(t.record);
    const ack = matchTargetAck({ package: t.package, runner: t.runner, tier: t.tier, kind, packageGone }, targetAcks, scopeAcks);
    if (kind === 'tier-changed') {
      result.scopeChanged.tierChanged.push(`${label} (tier/config changed; target present on both sides)`);
    } else {
      result.scopeChanged.targetsRemoved.push(label);
    }
    if (ack) {
      result.scopeChanged.targetsAcknowledged.push(`${label} acknowledged (${kind})`);
    } else if (kind === 'tier-changed') {
      result.problems.push(`scope-target: tier changed for ${label} and not acknowledged with a concrete reason (--acknowledge-targets change:"tier-changed")`);
    } else {
      result.problems.push(`scope-target: target removed ${label} and not acknowledged with a concrete reason (--acknowledge-targets change:"target-removed")`);
    }
  }
}

/* ------------------------------------------------------------------- diff */

export function diffDumps({ before, after, renames = [], twins = [], scopeAcks = [], targetAcks = [] }) {
  const result = baseResult();

  const validation = {
    before: validateDump(before, 'before'),
    after: validateDump(after, 'after'),
  };
  result.validation = validation;
  if (!validation.before.ok || !validation.after.ok) {
    result.error = 'invalid-canonical-dump';
    result.problems.push(...validation.before.problems, ...validation.after.problems);
    return result;
  }

  const beforeOcc = normDump(before);
  const afterOcc = normDump(after);

  // ---- evidence completeness (finding 2)
  result.evidence = {
    before: collectEvidence(before, 'before'),
    after: collectEvidence(after, 'after'),
  };
  for (const msg of result.evidence.before.incomplete) result.problems.push(`evidence: ${msg}`);
  for (const msg of result.evidence.after.incomplete) result.problems.push(`evidence: ${msg}`);

  // ---- target / tier scope identity (finding 4)
  assessTargets(before, after, targetAcks, scopeAcks, result);

  // ---- package/runner unit scope (existing behaviour)
  const beforeUnits = new Set(beforeOcc.map(unitOf));
  const afterUnits = new Set(afterOcc.map(unitOf));
  const beforePackages = new Set(beforeOcc.map((o) => o.package));
  const afterPackages = new Set(afterOcc.map((o) => o.package));

  const scopeChanged = result.scopeChanged;
  const lostUnits = [...beforeUnits].filter((u) => !afterUnits.has(u));
  const gainedUnits = [...afterUnits].filter((u) => !beforeUnits.has(u));
  for (const u of gainedUnits) scopeChanged.added.push(labelUnit(u));
  for (const p of beforePackages) {
    if (!afterPackages.has(p)) continue;
    const b = [...beforeUnits].filter((u) => u.startsWith(p + '\u0000')).map((u) => u.split('\u0000')[1]);
    const a = [...afterUnits].filter((u) => u.startsWith(p + '\u0000')).map((u) => u.split('\u0000')[1]);
    if (b.sort().join(',') !== a.sort().join(',')) scopeChanged.runnerChanged.push(`${p} (${b.join(',')} -> ${a.join(',')})`);
  }
  const ackKeys = new Set(scopeAcks.map((a) => `${a.package}\u0000${a.runner}\u0000${a.change}`));

  // ---- renames
  const changed = [];
  const beforeByKey = groupBy(beforeOcc, (o) => identityKey(o));
  const afterByKey = groupBy(afterOcc, (o) => identityKey(o));
  for (const r of renames) {
    const from = r.from || {};
    const to = r.to || {};
    const fromRec = { package: from.package ?? r.package, runner: from.runner ?? r.runner, suite: from.suite ?? '', fullName: from.fullName ?? '' };
    const toRec = { package: to.package ?? r.package, runner: to.runner ?? r.runner, suite: to.suite ?? '', fullName: to.fullName ?? '' };
    const cross = fromRec.package !== toRec.package || fromRec.runner !== toRec.runner;
    if (cross && r.crossScope !== true) {
      result.problems.push(`rename: cross-package/runner mapping not declared (set crossScope:true): ${describeIdentity(fromRec)} -> ${describeIdentity(toRec)}`);
    }
    const bOcc = takeUnused(beforeByKey.get(identityKey(fromRec)) || [], () => true);
    const aOcc = takeUnused(afterByKey.get(identityKey(toRec)) || [], () => true);
    if (!bOcc) result.problems.push(`rename: before occurrence not found: ${describeIdentity(fromRec)}`);
    if (!aOcc) result.problems.push(`rename: after occurrence not found: ${describeIdentity(toRec)}`);
    if (bOcc && aOcc) changed.push({ from: describeIdentity(fromRec), to: describeIdentity(toRec), crossScope: cross, note: r.note ?? null });
  }

  // ---- twins
  const removedConsolidated = [];
  const twinByName = groupBy(twins, (t) => [t.package, t.runner, t.fullName].join('\u0000'));
  for (const [nameKey, entries] of twinByName) {
    if (entries.length > 1) {
      result.problems.push(`twin: multiple twin entries for the same name ${nameKey.split('\u0000').join(' ')}, double-use guard`);
    }
    for (const t of entries) {
      const beforeList = beforeOcc.filter((o) => nameOf(o) === nameKey);
      const afterList = afterOcc.filter((o) => nameOf(o) === nameKey);
      const survivors = Array.isArray(t.survivors) ? t.survivors : [];
      const removed = Array.isArray(t.removed) ? t.removed : [];

      const unusedAfter = afterList.filter((o) => !o.used);
      if (unusedAfter.length !== survivors.length) {
        result.problems.push(`twin: ${nameKey.split('\u0000').join(' ')}: after occurrences (${unusedAfter.length}) != declared survivors (${survivors.length})`);
      }
      if (beforeList.length - afterList.length !== removed.length) {
        result.problems.push(`twin: ${nameKey.split('\u0000').join(' ')}: before(${beforeList.length}) - after(${afterList.length}) != declared removed (${removed.length})`);
      }
      if (removed.length > survivors.length && t.manyToOne !== true) {
        result.problems.push(`twin: ${nameKey.split('\u0000').join(' ')}: ${removed.length} removals reuse ${survivors.length} surviving occurrence(s); set manyToOne:true with a note to declare the identical-copy consolidation`);
      }
      if (t.manyToOne === true && !t.note) {
        result.problems.push(`twin: ${nameKey.split('\u0000').join(' ')}: manyToOne consolidation declares no note (evidence required)`);
      }
      for (const s of survivors) {
        const found = afterList.find((o) => o.suite === (s.suite ?? ''));
        if (!found) result.problems.push(`twin: survivor suite not present in after dump: ${s.suite}`);
      }
      removed.forEach((r, ri) => {
        const bOcc = takeUnused(beforeList, (o) => o.suite === (r.suite ?? ''));
        if (!bOcc) {
          result.problems.push(`twin: removed suite not present (or already used) in before dump: ${r.suite}`);
        } else {
          const survivor = survivors[Math.min(ri, survivors.length - 1)];
          removedConsolidated.push({
            package: t.package,
            runner: t.runner,
            fullName: t.fullName,
            removedSuite: r.suite ?? '',
            survivorSuite: survivor ? survivor.suite ?? '' : '',
            manyToOne: t.manyToOne === true,
            note: t.note ?? null,
          });
        }
      });
    }
  }

  // ---- scope resolution (needs the `used` flags set by renames/twins above)
  const removedAcknowledgedScope = [];
  for (const u of lostUnits) {
    const [pkg, runner] = u.split('\u0000');
    scopeChanged.removed.push(labelUnit(u));
    const unconsumed = beforeOcc.filter((o) => unitOf(o) === u && !o.used);
    if (ackKeys.has(`${pkg}\u0000${runner}\u0000lost`)) {
      for (const o of unconsumed) o.used = true;
      removedAcknowledgedScope.push(...unconsumed.map(describeIdentity));
      scopeChanged.acknowledged.push(labelUnit(u));
    } else if (unconsumed.length === 0) {
      scopeChanged.acknowledged.push(`${labelUnit(u)} (all occurrences consumed by explicit mappings)`);
    } else {
      result.problems.push(`scope: package/runner lost and not acknowledged: ${labelUnit(u)}`);
    }
  }
  for (const entry of scopeChanged.runnerChanged) {
    const pkg = entry.split(' ')[0];
    const acked = [...ackKeys].some((k) => k.startsWith(pkg + '\u0000') && k.endsWith('\u0000runner-changed'));
    if (acked) scopeChanged.acknowledged.push(entry);
    else result.problems.push(`scope: package runner changed and not acknowledged: ${entry}`);
  }

  // ---- base pairing by identity, min counts
  const removed = [];
  const added = [];
  const beforeGroups = groupBy(beforeOcc.filter((o) => !o.used), identityKey);
  const afterGroups = groupBy(afterOcc.filter((o) => !o.used), identityKey);
  const allKeys = new Set([...beforeGroups.keys(), ...afterGroups.keys()]);
  for (const key of allKeys) {
    const b = (beforeGroups.get(key) || []).slice();
    const a = (afterGroups.get(key) || []).slice();
    const paired = Math.min(b.length, a.length);
    for (let i = paired; i < b.length; i += 1) removed.push(b[i]);
    for (let i = paired; i < a.length; i += 1) added.push(a[i]);
  }

  for (const r of removed) result.problems.push(`removed without twin or rename: ${describeIdentity(r)}`);

  // ---- status regressions on preserved names (finding 3)
  const beforeUnusedByName = groupBy(beforeOcc.filter((o) => !o.used), identityKey);
  const afterUnusedByName = groupBy(afterOcc.filter((o) => !o.used), identityKey);
  for (const [key, bList] of beforeUnusedByName) {
    const aList = afterUnusedByName.get(key);
    if (!aList || aList.length === 0) continue; // name gone -> removal path blocks it
    const bCounts = statusCounts(bList);
    const aCounts = statusCounts(aList);
    const execB = bList.filter((o) => EXECUTED_STATUSES.has(o.status)).length;
    const execA = aList.filter((o) => EXECUTED_STATUSES.has(o.status)).length;
    const neverB = bList.filter((o) => NEVER_RUN_STATUSES.has(o.status)).length;
    const neverA = aList.filter((o) => NEVER_RUN_STATUSES.has(o.status)).length;
    const colB = bList.filter((o) => COLLECTION_STATUSES.has(o.status)).length;
    const colA = aList.filter((o) => COLLECTION_STATUSES.has(o.status)).length;
    const detail = [];
    if (execA < execB) detail.push(`executed occurrences dropped ${execB} -> ${execA}`);
    if (neverA > neverB) detail.push(`never-run occurrences added ${neverB} -> ${neverA}`);
    if (detail.length === 0) continue;
    const record = { identity: describeIdentity(bList[0]), before: bCounts, after: aCounts, executed: { before: execB, after: execA }, neverRun: { before: neverB, after: neverA }, collectionOnly: { before: colB, after: colA }, detail };
    result.statusChanges.push(record);
    result.statusRegressions.push(record);
    result.problems.push(`status-regression: ${record.identity} (${detail.join('; ')})`);
  }

  const perPackage = buildPerPackage(beforeOcc, afterOcc, added, removed, changed, removedConsolidated);

  result.added = added.map(describeIdentity).sort();
  result.removed = removed.map(describeIdentity).sort();
  result.changed = changed;
  result.removedConsolidated = removedConsolidated;
  result.removedAcknowledgedScope = removedAcknowledgedScope;
  result.perPackage = perPackage;
  result.totals = {
    before: beforeOcc.length,
    after: afterOcc.length,
    added: added.length,
    removed: removed.length,
    changed: changed.length,
    removedConsolidated: removedConsolidated.length,
    removedAcknowledgedScope: removedAcknowledgedScope.length,
    statusRegressions: result.statusRegressions.length,
  };
  result.ok = result.problems.length === 0;
  return result;
}

function buildPerPackage(beforeOcc, afterOcc, added, removed, changed, consolidated) {
  const packages = new Map();
  const ensure = (o) => {
    const k = unitOf(o);
    if (!packages.has(k)) packages.set(k, { package: o.package, runner: o.runner, before: 0, after: 0, added: 0, removed: 0, changed: 0, removedConsolidated: 0 });
    return packages.get(k);
  };
  for (const o of beforeOcc) ensure(o).before += 1;
  for (const o of afterOcc) ensure(o).after += 1;
  for (const o of added) ensure(o).added += 1;
  for (const o of removed) ensure(o).removed += 1;
  for (const o of consolidated) ensure(o).removedConsolidated += 1;
  for (const c of changed) {
    const pkg = c.from.split(' ')[0];
    const runner = (c.from.match(/\[(.*?)\]/) || [])[1] || '';
    const k = `${pkg}\u0000${runner}`;
    if (packages.has(k)) packages.get(k).changed += 1;
  }
  return [...packages.values()].sort((a, b) => (a.package === b.package ? a.runner.localeCompare(b.runner) : a.package < b.package ? -1 : 1));
}
