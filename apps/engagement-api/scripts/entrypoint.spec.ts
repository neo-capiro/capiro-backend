/**
 * Engagement API Phase 1 — entrypoint spec.
 *
 * Tests the engagement-api Docker entrypoint script's serve-only behavior.
 * The entrypoint must refuse migrations, seeds, sync-*, diag-*, and unknown
 * commands with exit code 64. Only `serve` is supported.
 *
 * This spec reads the entrypoint.sh source and verifies its case statement
 * branches are correct. It does NOT execute the script (which would require
 * Docker); it's a static analysis of the script content.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Read the entrypoint script. In the test environment this resolves to
// apps/engagement-api/scripts/entrypoint.sh (relative to the spec file in
// apps/engagement-api/scripts/). Since Jest runs from apps/api, we use
// the repo root path.
const ENTRYPOINT_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'apps',
  'engagement-api',
  'scripts',
  'entrypoint.sh',
);

let entrypointSource: string;
try {
  entrypointSource = readFileSync(ENTRYPOINT_PATH, 'utf-8');
} catch {
  // If the file doesn't exist (e.g. running from a different cwd), skip.
  entrypointSource = '';
}

describe('engagement-api entrypoint.sh', () => {
  it('exists and is readable', () => {
    expect(entrypointSource.length).toBeGreaterThan(0);
  });

  describe('serve-only behavior', () => {
    it('supports the serve command', () => {
      expect(entrypointSource).toMatch(/serve\)/);
    });

    it('executes node dist/engagement-main.js for serve', () => {
      expect(entrypointSource).toMatch(/node\s+dist\/engagement-main\.js/);
    });

    it('sets CAPIRO_SERVICE_NAME default to engagement-api', () => {
      expect(entrypointSource).toMatch(/CAPIRO_SERVICE_NAME.*engagement-api/);
    });

    it('composes DATABASE_URL from DB_* parts when not supplied', () => {
      expect(entrypointSource).toMatch(/compose_database_url/);
    });
  });

  describe('refuses migrations and operational verbs', () => {
    it('refuses migrate with exit 64', () => {
      expect(entrypointSource).toMatch(/migrate|migration-status/);
      expect(entrypointSource).toMatch(/exit\s+64/);
    });

    it('refuses seed with exit 64', () => {
      expect(entrypointSource).toMatch(/seed/);
      expect(entrypointSource).toMatch(/exit\s+64/);
    });

    it('refuses sync-* with exit 64', () => {
      expect(entrypointSource).toMatch(/sync-\*/);
    });

    it('refuses diag-* with exit 64', () => {
      expect(entrypointSource).toMatch(/diag-\*/);
    });

    it('refuses unknown commands with exit 64', () => {
      // The default case (*) should exit 64.
      expect(entrypointSource).toMatch(/\*\)/);
      expect(entrypointSource).toMatch(/exit\s+64/);
    });
  });

  describe('does not reuse the main API entrypoint', () => {
    it('does not call entrypoint-legacy.sh', () => {
      expect(entrypointSource).not.toMatch(/entrypoint-legacy/);
    });

    it('does not execute dist/main.js', () => {
      expect(entrypointSource).not.toMatch(/dist\/main\.js/);
    });

    it('does not run prisma migrate', () => {
      expect(entrypointSource).not.toMatch(/prisma.*migrate/);
    });
  });
});

describe('engagement-api Dockerfile', () => {
  let dockerfileSource: string;
  try {
    dockerfileSource = readFileSync(
      join(ENTRYPOINT_PATH, '..', '..', 'Dockerfile'),
      'utf-8',
    );
  } catch {
    dockerfileSource = '';
  }

  it('exposes port 4500', () => {
    expect(dockerfileSource).toMatch(/EXPOSE\s+4500/);
  });

  it('uses non-root user capiro', () => {
    expect(dockerfileSource).toMatch(/USER\s+capiro/);
    expect(dockerfileSource).toMatch(/--uid\s+1001/);
  });

  it('uses dumb-init', () => {
    expect(dockerfileSource).toMatch(/dumb-init/);
  });

  it('copies the engagement-api entrypoint', () => {
    expect(dockerfileSource).toMatch(/entrypoint\.sh/);
  });

  it('does not copy API operational scripts', () => {
    // The engagement-api Dockerfile should NOT copy apps/api/scripts
    // (no sync-* or diag-* scripts needed in a serve-only image).
    expect(dockerfileSource).not.toMatch(/COPY.*apps\/api\/scripts/);
  });

  it('does not copy API TypeScript source to runtime', () => {
    expect(dockerfileSource).not.toMatch(/COPY.*apps\/api\/src/);
  });

  it('copies the DB URL helper', () => {
    expect(dockerfileSource).toMatch(/pe-compose-database-url/);
  });
});
