import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * District Nexus Release 3 closeout dry-run (2026-08-22): every CBP dry-run
 * failed with `CBP 00 request failed (400)` / `error: unknown variable
 * 'NAICS2022'`. Verified against https://api.census.gov/data/<year>/cbp/
 * variables.json for 2018-2023: the Census County Business Patterns (CBP)
 * API has never exposed a NAICS2022 variable -- it is NAICS2017 for every
 * published vintage year, unlike some other Census datasets that do add a
 * NAICS2022 variant. The script's `year >= 2022 ? 'NAICS2022' : 'NAICS2017'`
 * branch was simply wrong for this dataset.
 */
const SOURCE_PATH = join(__dirname, 'sync-district-economic-cbp.ts');
const source = readFileSync(SOURCE_PATH, 'utf8');

describe('sync-district-economic-cbp NAICS variable', () => {
  test('always requests NAICS2017 (CBP has no NAICS2022 variable in any published vintage)', () => {
    expect(source).toContain("const naicsVariable = 'NAICS2017';");
  });

  test('does not contain the year-conditional NAICS2022 branch that caused every dry-run to 400', () => {
    expect(source).not.toMatch(/year\s*>=\s*2022\s*\?\s*'NAICS2022'/);
    expect(source).not.toContain("naicsVariable = year");
  });
});
