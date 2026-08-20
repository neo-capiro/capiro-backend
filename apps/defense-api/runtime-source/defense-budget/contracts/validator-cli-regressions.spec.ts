import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ManifestValidatorArgError,
  parseManifestValidatorArgs,
  validateManifestFile,
} from '../../../scripts/validate-defense-budget-cycle-manifest.js';
import {
  ArtifactValidatorArgError,
  parseArtifactValidatorArgs,
  validateArtifactFile,
} from '../../../scripts/validate-defense-budget-extraction-artifact.js';
import { buildMinimalArtifact } from './testing-helpers.js';

function tempDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'capiro-phase1-validator-'));
}

describe('Phase 1 validator command regressions', () => {
  it('returns a deterministic invalid manifest result for an unreadable file', () => {
    const missing = path.join(tempDirectory(), 'missing.json');
    const result = validateManifestFile(missing);
    expect(result.valid).toBe(false);
    expect(result.schemaErrors?.[0]).toMatch(/ENOENT|no such file/i);
  });

  it('returns a deterministic invalid manifest result for malformed JSON', () => {
    const directory = tempDirectory();
    const file = path.join(directory, 'manifest.json');
    fs.writeFileSync(file, '{not-json', 'utf8');
    const result = validateManifestFile(file);
    expect(result.valid).toBe(false);
    expect(result.schemaErrors?.[0]).toMatch(/JSON|position|property name/i);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('returns a deterministic invalid artifact result for an unreadable file', () => {
    const missing = path.join(tempDirectory(), 'missing.json');
    const result = validateArtifactFile(missing);
    expect(result.valid).toBe(false);
    expect(result.schemaErrors?.[0]).toMatch(/ENOENT|no such file/i);
  });

  it('returns a deterministic invalid artifact result for malformed JSON', () => {
    const directory = tempDirectory();
    const file = path.join(directory, 'artifact.json');
    fs.writeFileSync(file, '[not-json', 'utf8');
    const result = validateArtifactFile(file);
    expect(result.valid).toBe(false);
    expect(result.schemaErrors?.[0]).toMatch(/JSON|position|unexpected/i);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('validates a complete artifact through the importable file entry point', () => {
    const directory = tempDirectory();
    const file = path.join(directory, 'artifact.json');
    fs.writeFileSync(file, JSON.stringify(buildMinimalArtifact()), 'utf8');
    const result = validateArtifactFile(file, { requireComplete: true });
    expect(result.valid).toBe(true);
    expect(result.completenessStatus).toBe('complete');
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('rejects unknown, duplicate, and missing manifest flags', () => {
    expect(() => parseManifestValidatorArgs(['--unknown'])).toThrow(
      ManifestValidatorArgError,
    );
    expect(() =>
      parseManifestValidatorArgs(['--manifest', 'a.json', '--manifest', 'b.json']),
    ).toThrow(/duplicate --manifest/);
    expect(() => parseManifestValidatorArgs(['--manifest'])).toThrow(
      /requires a nonblank file path/,
    );
  });

  it('rejects unknown, duplicate, and missing artifact flags', () => {
    expect(() => parseArtifactValidatorArgs(['--unknown'])).toThrow(
      ArtifactValidatorArgError,
    );
    expect(() =>
      parseArtifactValidatorArgs(['--artifact', 'a.json', '--require-complete', '--require-complete']),
    ).toThrow(/duplicate --require-complete/);
    expect(() => parseArtifactValidatorArgs(['--artifact', '--require-complete'])).toThrow(
      /requires a nonblank file path/,
    );
  });
});
