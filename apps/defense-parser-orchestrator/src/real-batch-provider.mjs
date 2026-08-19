import {
  Session5RefusalError,
  canonicalJson,
  sha256Hex,
} from './session5.mjs';
import {
  REAL_BATCH_INPUT_CONTENT_TYPE,
  REAL_BATCH_OUTPUT_ACCEPT,
  buildLivePageCacheKey,
  buildLivePageIdentity,
} from './real-batch-config.mjs';

const MAX_PROVIDER_RECORD_BYTES = 5_500_000;

export function buildProviderManifest(batch) {
  const records = [];
  const sidecarRecords = [];
  for (let index = 0; index < batch.pages.length; index += 1) {
    const page = batch.pages[index];
    if (!page.providerPayload || typeof page.providerPayload !== 'object') {
      throw new Session5RefusalError(
        'PROVIDER_PAYLOAD_REQUIRED',
        `Page ${page.pageNumber} requires a provider-native JSON payload`,
      );
    }
    const payloadText = canonicalJson(page.providerPayload);
    if (Buffer.byteLength(payloadText, 'utf8') > MAX_PROVIDER_RECORD_BYTES) {
      throw new Session5RefusalError(
        'PROVIDER_PAYLOAD_TOO_LARGE',
        `Page ${page.pageNumber} provider-native JSON record exceeds ${MAX_PROVIDER_RECORD_BYTES} bytes`,
      );
    }
    const payloadSha = sha256Hex(payloadText);
    if (payloadSha !== page.providerPayloadSha256) {
      throw new Session5RefusalError(
        'PROVIDER_PAYLOAD_HASH_MISMATCH',
        `Page ${page.pageNumber} provider payload hash does not match materialized bytes`,
      );
    }
    records.push(payloadText);
    sidecarRecords.push({
      lineIndex: index,
      pageNumber: page.pageNumber,
      pageClass: page.pageClass,
      requestedParserMethod: page.requestedParserMethod,
      actualParserMethod: page.parserMethod,
      cacheKey: page.cacheKey,
      renderedImageSha256: page.renderedImageSha256,
      providerPayloadSha256: page.providerPayloadSha256,
      renderingConfigSha256: page.renderingConfigSha256,
      escalationReason: page.escalationReason,
    });
  }
  const body = `${records.join('\n')}\n`;
  const sidecarWithoutHash = {
    schemaVersion: 'nvidia_batch_input_sidecar_v2',
    batchId: batch.batchId,
    sourceDocumentId: batch.sourceDocumentId,
    sourceSha256: batch.sourceSha256,
    parserMethod: batch.parserMethod,
    modelName: batch.modelName,
    modelVersion: batch.modelVersion,
    parserOptionsHash: batch.parserOptionsHash,
    inputContentType: REAL_BATCH_INPUT_CONTENT_TYPE,
    outputAccept: REAL_BATCH_OUTPUT_ACCEPT,
    records: sidecarRecords,
  };
  return Object.freeze({
    body,
    bodySha256: sha256Hex(body),
    sidecar: Object.freeze({
      ...sidecarWithoutHash,
      contentSha256: sha256Hex(sidecarWithoutHash),
    }),
  });
}

export function parseJsonLines(text) {
  if (typeof text !== 'string') {
    throw new Session5RefusalError('INVALID_PROVIDER_OUTPUT', 'Provider output must be text');
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new Session5RefusalError('EMPTY_PROVIDER_OUTPUT', 'Provider output contains no records');
  }
  return lines.map((line, index) => {
    try {
      return { raw: line, value: JSON.parse(line) };
    } catch (error) {
      throw new Session5RefusalError(
        'INVALID_PROVIDER_JSON_LINE',
        `Provider output line ${index + 1} is not valid JSON`,
        { cause: String(error?.message ?? error) },
      );
    }
  });
}

function normalizeDetections(parsed) {
  let value = parsed;
  if (Array.isArray(value) && value.length === 1 && Array.isArray(value[0])) {
    value = value[0];
  }
  if (!Array.isArray(value)) value = [value];
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Session5RefusalError(
        'INVALID_MARKDOWN_BBOX',
        `markdown_bbox item ${index} is not an object`,
      );
    }
    const bbox = entry.bbox;
    if (!bbox || typeof bbox !== 'object') {
      throw new Session5RefusalError(
        'INVALID_MARKDOWN_BBOX',
        `markdown_bbox item ${index} has no bounding box`,
      );
    }
    const normalizedBox = {};
    for (const key of ['xmin', 'ymin', 'xmax', 'ymax']) {
      const number = Number(bbox[key]);
      if (!Number.isFinite(number) || number < 0 || number > 1) {
        throw new Session5RefusalError(
          'INVALID_MARKDOWN_BBOX',
          `markdown_bbox item ${index}.${key} must be in [0,1]`,
        );
      }
      normalizedBox[key] = number;
    }
    return Object.freeze({
      blockIndex: index,
      blockType: String(entry.type ?? 'unknown'),
      text: typeof entry.text === 'string' ? entry.text : '',
      boundingBox: normalizedBox,
    });
  });
}

export function extractNemotronMarkdownBBox(response) {
  const message = response?.choices?.[0]?.message;
  const toolCalls = message?.tool_calls;
  const call = Array.isArray(toolCalls)
    ? toolCalls.find((item) => item?.function?.name === 'markdown_bbox')
    : null;
  if (!call || typeof call.function?.arguments !== 'string') {
    throw new Session5RefusalError(
      'MARKDOWN_BBOX_REQUIRED',
      'Nemotron Parse response does not contain a markdown_bbox tool call',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(call.function.arguments);
  } catch (error) {
    throw new Session5RefusalError(
      'INVALID_MARKDOWN_BBOX',
      'Nemotron Parse markdown_bbox arguments are not valid JSON',
      { cause: String(error?.message ?? error) },
    );
  }
  return normalizeDetections(parsed);
}

export function normalizeProviderOutputJsonLines(input) {
  const sidecar = input.sidecar;
  if (!sidecar || sidecar.schemaVersion !== 'nvidia_batch_input_sidecar_v2') {
    throw new Session5RefusalError('SIDECAR_REQUIRED', 'A v2 input sidecar is required');
  }
  const sidecarWithoutHash = { ...sidecar };
  delete sidecarWithoutHash.contentSha256;
  if (sha256Hex(sidecarWithoutHash) !== sidecar.contentSha256) {
    throw new Session5RefusalError('SIDECAR_HASH_MISMATCH', 'Input sidecar hash is invalid');
  }
  const lines = parseJsonLines(input.rawOutputText);
  if (lines.length !== sidecar.records.length) {
    throw new Session5RefusalError(
      'OUTPUT_CARDINALITY_MISMATCH',
      `Provider returned ${lines.length} records for ${sidecar.records.length} input records`,
    );
  }
  const pages = lines.map((line, index) => {
    const record = sidecar.records[index];
    if (record.lineIndex !== index) {
      throw new Session5RefusalError('SIDECAR_ORDER_MISMATCH', 'Sidecar line ordering is invalid');
    }
    if (record.actualParserMethod !== sidecar.parserMethod) {
      throw new Session5RefusalError(
        'SIDECAR_PROVIDER_METHOD_MISMATCH',
        `Page ${record.pageNumber} actual parser method disagrees with batch provider`,
      );
    }
    const blocks = extractNemotronMarkdownBBox(line.value);
    const markdown = blocks.map((block) => block.text).filter(Boolean).join('\n\n');
    const withoutHash = {
      schemaVersion: 'nvidia_normalized_page_artifact_v2',
      sourceDocumentId: sidecar.sourceDocumentId,
      sourceSha256: sidecar.sourceSha256,
      pageNumber: record.pageNumber,
      pageClass: record.pageClass,
      requestedParserMethod: record.requestedParserMethod,
      parserMethod: sidecar.parserMethod,
      modelName: sidecar.modelName,
      modelVersion: sidecar.modelVersion,
      parserOptionsHash: sidecar.parserOptionsHash,
      renderedImageSha256: record.renderedImageSha256,
      providerPayloadSha256: record.providerPayloadSha256,
      renderingConfigSha256: record.renderingConfigSha256,
      cacheKey: record.cacheKey,
      providerRunIdentity: input.providerRunIdentity,
      providerRawResponseSha256: sha256Hex(line.raw),
      text: markdown,
      markdown,
      blocks,
      tables: blocks
        .filter((block) => block.blockType.toLowerCase() === 'table')
        .map((block, tableIndex) => ({
          tableIndex,
          text: block.text,
          boundingBox: block.boundingBox,
        })),
      evidencePrecision: 'text_span',
      warnings: [],
    };
    return Object.freeze({
      ...withoutHash,
      contentSha256: sha256Hex(withoutHash),
    });
  });
  const outputWithoutHash = {
    schemaVersion: 'nvidia_normalized_batch_artifact_v2',
    batchId: sidecar.batchId,
    providerRunIdentity: input.providerRunIdentity,
    rawProviderOutputSha256: sha256Hex(input.rawOutputText),
    pages,
  };
  return Object.freeze({
    ...outputWithoutHash,
    contentSha256: sha256Hex(outputWithoutHash),
  });
}

export function verifyNormalizedPageArtifact(artifact, expected) {
  if (!artifact || artifact.schemaVersion !== 'nvidia_normalized_page_artifact_v2') {
    throw new Session5RefusalError('INVALID_CACHE_ARTIFACT', 'Cached page artifact is not v2');
  }
  const withoutHash = { ...artifact };
  delete withoutHash.contentSha256;
  if (sha256Hex(withoutHash) !== artifact.contentSha256) {
    throw new Session5RefusalError('CACHE_HASH_MISMATCH', 'Cached artifact content hash is invalid');
  }
  const actualIdentity = buildLivePageIdentity(artifact);
  const expectedIdentity = buildLivePageIdentity({
    ...expected,
    requestedParserMethod:
      expected.requestedParserMethod ?? artifact.requestedParserMethod,
  });
  if (canonicalJson(actualIdentity) !== canonicalJson(expectedIdentity)) {
    throw new Session5RefusalError('CACHE_IDENTITY_MISMATCH', 'Cached artifact identity is stale');
  }
  if (
    artifact.cacheKey !==
    buildLivePageCacheKey({
      ...expected,
      requestedParserMethod:
        expected.requestedParserMethod ?? artifact.requestedParserMethod,
    })
  ) {
    throw new Session5RefusalError('CACHE_KEY_MISMATCH', 'Cached artifact key is inconsistent');
  }
  return artifact;
}
