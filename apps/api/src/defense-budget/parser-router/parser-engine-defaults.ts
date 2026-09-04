import type { ExtractionMethodV1 } from '../contracts/extraction-artifact-v1.js';
import type { JsonValue } from '../contracts/canonical-json.js';

const DEFAULTS: Partial<Record<ExtractionMethodV1, JsonValue>> = {
  deterministic_pdfplumber: {
    tableStrategy: 'lines',
    tableSettings: {
      vertical_strategy: 'lines',
      horizontal_strategy: 'lines',
    },
  },
  camelot: {
    flavor: 'lattice',
    flavorConfig: {
      flavor: 'lattice',
      default_kwargs: {},
    },
  },
  docling: {
    cpuMode: true,
    vlmPipeline: false,
    remoteLlmExtraction: false,
    ocrEnabled: false,
    gpuEnabled: false,
    pipelineOptions: {
      doTableStructure: true,
      doOcr: false,
      doLayout: true,
      doReadingOrder: true,
    },
    maxPagesPerJob: 100,
    perPageTimeoutSeconds: 180,
    modelCachePath: null,
  },
  paddleocr: {
    dpi: 200,
    cpuMode: true,
    maxPagesPerJob: 50,
    perPageTimeoutSeconds: 120,
    parallelProcessing: false,
    use_gpu: false,
    // Phase 10B-23A/B: MKLDNN is unavailable in the tested ARM64
    // paddlepaddle build (AnalysisConfig.set_mkldnn_cache_capacity does not
    // exist there), confirmed empirically. No ARM64 upside even where
    // present, so this stays off everywhere rather than branching by
    // architecture.
    enable_mkldnn: false,
    // Row/column reconstruction thresholds -- see paddleocr_engine.py's
    // reconstruct_page_structure for the geometry these drive.
    rowGapRatio: 0.6,
    columnGapRatio: 1.5,
  },
};

/**
 * Exact cross-language defaults. A cloned JSON value is returned so callers
 * cannot mutate the permanent profile and silently change later identities.
 */
export function getDefaultParserConfig(method: ExtractionMethodV1): JsonValue {
  const value = DEFAULTS[method];
  if (value === undefined) {
    throw new Error(`no local parser configuration registered for ${method}`);
  }
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
