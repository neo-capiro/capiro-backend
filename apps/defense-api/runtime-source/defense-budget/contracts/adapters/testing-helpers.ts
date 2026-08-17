import type { ExtractionAdapterContextV1 } from './adapter-context.js';

export const ADAPTER_TEST_SOURCE_SHA = 'f'.repeat(64);
export const ADAPTER_TEST_CONFIG_SHA = '1'.repeat(64);
export const ADAPTER_TEST_OUTPUT_SHA = '2'.repeat(64);

export function adapterTestContext(
  overrides: Partial<ExtractionAdapterContextV1> = {},
): ExtractionAdapterContextV1 {
  const { parser: parserOverrides, ...rest } = overrides;
  return {
    manifestDocumentKey: 'adapter-test-doc',
    sourcePdfSha256: ADAPTER_TEST_SOURCE_SHA,
    sourceLocator: 'local/adapter-test.pdf',
    fiscalYear: 2099,
    family: 'rdte',
    exhibit: 'R-1',
    authority: 'dod-comptroller',
    component: 'ARMY',
    budgetCycle: 'pb',
    documentType: 'test',
    ...rest,
    parser: {
      method: 'deterministic_pdfplumber',
      parserVersion: '0.0.0-adapter-test',
      parserConfigSha256: ADAPTER_TEST_CONFIG_SHA,
      outputArtifactSha256: ADAPTER_TEST_OUTPUT_SHA,
      pageRanges: [{ startPage: 1, endPage: 500 }],
      ...parserOverrides,
    },
  };
}
