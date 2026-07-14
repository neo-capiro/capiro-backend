import { afterAll, beforeEach, describe, expect, test } from '@jest/globals';
import { gzipSync } from 'node:zlib';
import { ConfigService } from '@nestjs/config';
import { DirectoryService } from './directory.service.js';
import type { AppConfig } from '../config/config.schema.js';

/**
 * Pointer-driven snapshot resolution + rollback fallback (Phase 2, Task 6):
 *   - DIRECTORY_S3_PREFIX pins the snapshot (no LATEST.json read);
 *   - otherwise the prefix is resolved from LATEST.json per cache rebuild;
 *   - a missing LATEST.json falls back to the documented default prefix;
 *   - a broken current snapshot falls back to previous_snapshot_prefix;
 *   - if every candidate fails, a stale cache is served rather than an empty directory.
 */
function makeService(): DirectoryService {
  const config = { get: () => 'us-east-1' } as unknown as ConfigService<AppConfig, true>;
  return new DirectoryService(config, {} as never, {} as never);
}

function gzipBody(value: unknown) {
  const bytes = gzipSync(Buffer.from(JSON.stringify(value), 'utf8'));
  return { transformToByteArray: async () => new Uint8Array(bytes) };
}

function jsonBody(value: unknown) {
  return { transformToString: async () => JSON.stringify(value) };
}

type Handler = (key: string) => { Body: unknown } | 'throw';

function installFakeS3(service: DirectoryService, handler: Handler): void {
  (service as any).s3 = {
    send: async (command: { input?: { Key?: string } }) => {
      const key = command?.input?.Key ?? '';
      const result = handler(key);
      if (result === 'throw') throw new Error(`NoSuchKey: ${key}`);
      return result;
    },
  };
}

const DEFAULT_PREFIX = 'UPDATED DIRECTORY/snapshots/active-current-20260501T024354Z';
const ORIGINAL_PREFIX_ENV = process.env.DIRECTORY_S3_PREFIX;

describe('DirectoryService snapshot pointer resolution', () => {
  beforeEach(() => {
    delete process.env.DIRECTORY_S3_PREFIX;
  });
  afterAll(() => {
    if (ORIGINAL_PREFIX_ENV === undefined) delete process.env.DIRECTORY_S3_PREFIX;
    else process.env.DIRECTORY_S3_PREFIX = ORIGINAL_PREFIX_ENV;
  });

  test('an explicit DIRECTORY_S3_PREFIX pins the snapshot and never reads LATEST.json', async () => {
    process.env.DIRECTORY_S3_PREFIX = 'UPDATED DIRECTORY/snapshots/PINNED';
    const service = makeService();
    let latestRead = false;
    installFakeS3(service, (key) => {
      if (key.endsWith('LATEST.json')) latestRead = true;
      return 'throw';
    });

    const resolved = await (service as any).resolveSnapshotPrefixes();
    expect(resolved).toEqual({
      prefix: 'UPDATED DIRECTORY/snapshots/PINNED',
      previousPrefix: null,
    });
    expect(latestRead).toBe(false);
  });

  test('resolves prefix + previous from LATEST.json when unpinned', async () => {
    const service = makeService();
    installFakeS3(service, (key) => {
      if (key.endsWith('LATEST.json')) {
        return {
          Body: jsonBody({ snapshot_prefix: 'SNAP/current', previous_snapshot_prefix: 'SNAP/prior' }),
        };
      }
      return 'throw';
    });

    const resolved = await (service as any).resolveSnapshotPrefixes();
    expect(resolved).toEqual({ prefix: 'SNAP/current', previousPrefix: 'SNAP/prior' });
  });

  test('falls back to the documented default prefix when LATEST.json is absent', async () => {
    const service = makeService();
    installFakeS3(service, () => 'throw');

    const resolved = await (service as any).resolveSnapshotPrefixes();
    expect(resolved).toEqual({ prefix: DEFAULT_PREFIX, previousPrefix: null });
  });

  test('getDirectoryData falls back to previous_snapshot_prefix when the current snapshot fails', async () => {
    const service = makeService();
    installFakeS3(service, (key) => {
      if (key.endsWith('LATEST.json')) {
        return {
          Body: jsonBody({ snapshot_prefix: 'CUR', previous_snapshot_prefix: 'PREV' }),
        };
      }
      if (key.startsWith('PREV/combined/')) return { Body: gzipBody([]) };
      return 'throw'; // CUR/* broken; overlays 404 -> fetchJsonSafe returns null
    });

    const data = await (service as any).getDirectoryData();
    // sourceId carries the resolved prefix — proving the reader fell back to PREV.
    expect(data.sourceId.endsWith('/PREV')).toBe(true);
    // PREV had no offices, so no committees were built (no synthetic entries here).
    expect(data.committees).toEqual([]);
  });

  test('serves a stale cache instead of an empty directory when every snapshot fails', async () => {
    const service = makeService();
    const stale = {
      sourceId: 'bucket/STALE',
      contacts: [{ id: 'stale-contact' }],
      staffers: [],
      committees: [],
      committeeStaff: new Map(),
      totals: { all: 1, house: 0, senate: 0, governors: 0, staff: 0 },
      availableStates: [],
      availableFilters: {},
    };
    (service as any).cache = { data: stale, expiresAt: 0 }; // expired -> forces a reload attempt
    installFakeS3(service, () => 'throw'); // LATEST + default snapshot both fail

    const data = await (service as any).getDirectoryData();
    expect(data).toBe(stale);
  });
});
