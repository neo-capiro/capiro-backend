import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertBothBindings,
  assertCanonicalOwner,
  assertGenerationPipelines,
  assertRetainedDeclarations,
} from './fixtures/memo-sections-ownership-guard/semantic.js';

const sources = {
  canonical: readFileSync(join(__dirname, 'memo-sections.ts'), 'utf8'),
  memo: readFileSync(join(__dirname, 'alert-memo.service.ts'), 'utf8'),
  district: readFileSync(join(__dirname, 'district-brief.service.ts'), 'utf8'),
};

it('owns one dependency-free parser and the original section contract', () => {
  expect(() => assertCanonicalOwner(sources)).not.toThrow();
});

it('adopts the same static parser and type in both services without local copies', () => {
  expect(() => assertBothBindings(sources)).not.toThrow();
});

it('parses once before each existing grounding policy inside the unchanged generation pipeline', () => {
  expect(() => assertGenerationPipelines(sources)).not.toThrow();
});

it('preserves both facades, exports and other policies while rejecting renamed parser copies', () => {
  expect(() => assertRetainedDeclarations(sources)).not.toThrow();
});
