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
    formulaRecognition: false,
    chartRecognition: false,
    documentUnwarping: false,
    orientationClassification: false,
    textLineOrientation: false,
    maxPagesPerJob: 50,
    perPageTimeoutSeconds: 120,
    modelCachePath: null,
    parallelProcessing: false,
    use_gpu: false,
    enable_mkldnn: true,
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
