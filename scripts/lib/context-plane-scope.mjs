import {
  knowledgeCensusIncludesPath, knowledgeCensusPathScope, assertKnowledgeCensusReadPath,
} from './knowledge-census-scope.mjs';

export {
  parseKnowledgeCensusInvocation as parseContextPlaneInvocation,
  projectKnowledgeCensusDiff as projectContextPlaneDiff,
  assertKnowledgeCensusReadPath as assertContextPlaneReadPath,
  knowledgeCensusIncludesPath as contextPlaneIncludesPath,
} from './knowledge-census-scope.mjs';

function canTraverse(path, scope) {
  knowledgeCensusPathScope(path);
  return knowledgeCensusIncludesPath(path, scope) || (scope === 'frontend' && path === 'apps');
}

/** Original suffixes/exclusions are inputs; all filesystem effects are ports. */
export function contextPlaneSourceFilesUnder(root, scope, policy, ports) {
  const files = [];
  const walk = (directory) => {
    if (!canTraverse(directory, scope)) return;
    const stat = ports.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`invalid source directory: ${directory}`);
    for (const name of ports.readdirSync(directory)) {
      if (policy.skipDirectories.has(name)) continue;
      const path = directory + '/' + name;
      // Excluded membership is resolved before any stat/readdir/read of a path.
      if (!canTraverse(path, scope)) continue;
      const entry = ports.lstatSync(path);
      if (entry.isSymbolicLink()) throw new Error(`symbolic source path: ${path}`);
      if (entry.isDirectory()) walk(path);
      else if ((path.endsWith('.ts') || path.endsWith('.tsx')) &&
          !policy.testSuffixes.some((suffix) => path.endsWith(suffix))) files.push(path);
    }
  };
  if (!canTraverse(root, scope)) return files;
  // A bounded implementation root must not be reached through a parent symlink.
  if (!(scope === 'frontend' && root === 'apps')) assertKnowledgeCensusReadPath(root, scope, ports);
  walk(root);
  return files;
}
