import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KNOWN_PE_MIGRATION_NAMES = Object.freeze([
  '20260729050000_pe_observation_idempotency_and_outbox',
  '20260811010000_program_element_data_issue',
]);

// Restrict names before emitting line-oriented data or using them as path parts.
const MIGRATION_NAME = /^[0-9]{14}_[A-Za-z0-9_-]+$/;

export function validateMigrationNames(names, label = 'migration names') {
  if (!Array.isArray(names)) throw new TypeError(`${label} must be an array`);
  const seen = new Set();
  for (const name of names) {
    // JavaScript's $ anchor can match before a final newline; require the full match.
    if (typeof name !== 'string' || MIGRATION_NAME.exec(name)?.[0] !== name) {
      throw new Error(`${label} contains an invalid migration name: ${JSON.stringify(name)}`);
    }
    if (seen.has(name)) {
      throw new Error(`${label} contains a duplicate migration name: ${name}`);
    }
    seen.add(name);
  }
  return [...seen].sort();
}

export function parseMigrationList(contents, label = 'migration list') {
  if (typeof contents !== 'string') throw new TypeError(`${label} must be text`);
  if (contents === '') return [];
  const lines = contents.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return validateMigrationNames(lines, label);
}

export function discoverMigrationDirectories(migrationRoot) {
  // lstat deliberately rejects a root or child that is itself a symlink.
  if (!lstatSync(migrationRoot).isDirectory()) {
    throw new Error('Migration root must be a real directory');
  }
  const names = [];
  for (const entry of readdirSync(migrationRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Symlink entries are unsupported in migration root: ${JSON.stringify(entry.name)}`,
      );
    }
    if (!entry.isDirectory()) continue;
    const directory = join(migrationRoot, entry.name);
    const directoryStat = lstatSync(directory);
    if (directoryStat.isSymbolicLink()) {
      throw new Error(
        `Symlink migration directories are unsupported: ${JSON.stringify(entry.name)}`,
      );
    }
    if (!directoryStat.isDirectory()) continue;
    let sql;
    try {
      sql = lstatSync(join(directory, 'migration.sql'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (sql.isSymbolicLink()) {
      throw new Error(`Symlink migration.sql is unsupported: ${JSON.stringify(entry.name)}`);
    }
    if (sql.isFile()) names.push(entry.name);
  }
  return validateMigrationNames(names, 'filesystem migration directories');
}

export function expectedPeBranchNames({
  tipNames,
  mainNames,
  knownPeNames = KNOWN_PE_MIGRATION_NAMES,
}) {
  const tip = new Set(validateMigrationNames(tipNames, 'HEAD migration names'));
  const main = new Set(validateMigrationNames(mainNames, 'main migration names'));
  return validateMigrationNames(knownPeNames, 'known PE migration names').filter(
    (name) => tip.has(name) && !main.has(name),
  );
}

function cli(args) {
  if (args.length === 2 && args[0] === 'list') {
    return discoverMigrationDirectories(args[1]);
  }
  if (args.length === 3 && args[0] === 'required-pe') {
    return expectedPeBranchNames({
      tipNames: parseMigrationList(readFileSync(args[1], 'utf8'), 'HEAD migration list'),
      mainNames: parseMigrationList(readFileSync(args[2], 'utf8'), 'main migration list'),
    });
  }
  throw new Error(
    'Usage: pe-phase-9-migration-discovery.mjs list <migrationRoot> | required-pe <HEADfile> <MAINfile>',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const names = cli(process.argv.slice(2));
    process.stdout.write(names.length ? `${names.join('\n')}\n` : '');
  } catch (error) {
    process.stderr.write(`FATAL: ${error.message}\n`);
    process.exitCode = 2;
  }
}
