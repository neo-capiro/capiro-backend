import { Client, type ClientConfig } from 'pg';

export const FUNDING_CLONE_HOST = 'capiro-newstack-preview-clone.cluster-csryw28ai752.us-east-1.rds.amazonaws.com';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Validate before allocating a Prisma client or connecting. Environment input
 * may select the approved clone, never extend the host allowlist. */
export function fundingDatabaseOptions(commit: boolean, env: NodeJS.ProcessEnv = process.env): ClientConfig {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  let url: URL;
  try { url = new URL(env.DATABASE_URL); } catch { throw new Error('Invalid funding DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.pathname.slice(1) || url.hash) {
    throw new Error('Invalid funding PostgreSQL configuration');
  }
  const isolated = LOOPBACK_HOSTS.has(url.hostname) && url.pathname === '/funding_test';
  if (url.hostname !== FUNDING_CLONE_HOST && !isolated) throw new Error('Funding requires the preview clone or loopback funding_test database');
  if (commit && env.FUNDING_ALLOWED_DB_HOST !== url.hostname) throw new Error('Funding writes require an exact FUNDING_ALLOWED_DB_HOST match');
  const sslMode = url.searchParams.get('sslmode');
  if (!isolated && !['require', 'verify-ca', 'verify-full'].includes(sslMode ?? '')) throw new Error('Funding clone requires verified TLS');
  if (url.searchParams.has('sslaccept') || url.searchParams.has('ssl') || url.searchParams.has('sslrootcert') || url.searchParams.has('sslcert') || url.searchParams.has('sslkey')) {
    throw new Error('Funding TLS overrides are not permitted');
  }
  url.searchParams.delete('sslmode');
  // Official RDS roots are supplied by NODE_EXTRA_CA_CERTS in the worker.
  return { connectionString: url.toString(), ...(sslMode && sslMode !== 'disable' ? { ssl: { rejectUnauthorized: true } } : {}) };
}

export function fundingLockClient(commit: boolean): Client {
  return new Client(fundingDatabaseOptions(commit));
}
