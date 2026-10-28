import { describe, expect, test } from '@jest/globals';
import { FUNDING_CLONE_HOST, fundingDatabaseOptions } from './funding-catalog.db.js';

const clone = (query = 'sslmode=require') => `postgresql://worker:private-password@${FUNDING_CLONE_HOST}:5432/capiro?${query}`;
describe('bounded funding database configuration', () => {
  test('admits only the exact configured clone with certificate validation', () => {
    const result = fundingDatabaseOptions(true, { DATABASE_URL: clone(), FUNDING_ALLOWED_DB_HOST: FUNDING_CLONE_HOST });
    expect(result.ssl).toEqual({ rejectUnauthorized: true });
    expect(result.connectionString).not.toContain('sslmode=');
  });
  test('environment cannot turn another host into an allowed database', () => {
    for (const host of ['capiro-dev.example.com', `${FUNDING_CLONE_HOST}.example.com`, '192.0.2.1']) {
      expect(() => fundingDatabaseOptions(true, { DATABASE_URL: clone().replace(FUNDING_CLONE_HOST, host), FUNDING_ALLOWED_DB_HOST: host })).toThrow('preview clone');
      expect(() => fundingDatabaseOptions(false, { DATABASE_URL: clone().replace(FUNDING_CLONE_HOST, host) })).toThrow('preview clone');
    }
    expect(() => fundingDatabaseOptions(true, { DATABASE_URL: clone() })).toThrow('exact FUNDING_ALLOWED_DB_HOST');
  });
  test('refuses missing, malformed, non-Postgres and insecure clone settings without leaking inputs', () => {
    for (const value of [undefined, 'private-password', clone().replace('postgresql:', 'https:'), clone('sslmode=disable'), clone('sslmode=require&sslaccept=accept_invalid_certs')]) {
      let message = '';
      try { fundingDatabaseOptions(false, { DATABASE_URL: value }); } catch (error) { message = (error as Error).message; }
      expect(message).not.toBe('');
      expect(message).not.toContain('private-password');
    }
  });
  test('query options cannot override either driver endpoint, identity or TLS', () => {
    for (const key of ['host', 'hostaddr', 'port', 'database', 'dbname', 'user', 'password', 'service', 'ssl', 'sslaccept', 'sslrootcert', 'sslcert', 'sslkey', 'options']) {
      expect(() => fundingDatabaseOptions(true, { DATABASE_URL: clone(`sslmode=require&${key}=other-db.example.com`), FUNDING_ALLOWED_DB_HOST: FUNDING_CLONE_HOST })).toThrow('Unsupported funding database URL option');
    }
    for (const query of ['sslmode=require&sslmode=disable', 'sslmode=require&schema=private', 'sslmode=require&host%61ddr=127.0.0.1']) {
      expect(() => fundingDatabaseOptions(true, { DATABASE_URL: clone(query), FUNDING_ALLOWED_DB_HOST: FUNDING_CLONE_HOST })).toThrow();
    }
    expect(fundingDatabaseOptions(true, { DATABASE_URL: clone('sslmode=require&schema=public&connection_limit=10&pool_timeout=10'), FUNDING_ALLOWED_DB_HOST: FUNDING_CLONE_HOST }).ssl).toEqual({ rejectUnauthorized: true });
  });
  test('isolated rehearsal permits only loopback funding_test, with explicit commit host', () => {
    expect(fundingDatabaseOptions(true, { DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:5432/funding_test?sslmode=disable', FUNDING_ALLOWED_DB_HOST: '127.0.0.1' }).ssl).toBeUndefined();
    expect(() => fundingDatabaseOptions(false, { DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:5432/capiro' })).toThrow('preview clone');
  });
});
