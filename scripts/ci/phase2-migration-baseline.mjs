/** Keep the actual historical prefix, not a current chain with one hole. */
export function includePrePhase2PrismaPath(relativePath, phase2MigrationName) {
  if (!/^\d{14}_[a-z0-9_]+$/.test(phase2MigrationName))
    throw new Error('Invalid Phase 2 migration boundary');
  const [directory, migration] = relativePath.split(/[\\/]/);
  if (directory !== 'migrations' || !migration || !/^\d{14}_/.test(migration)) return true;
  return migration < phase2MigrationName;
}
