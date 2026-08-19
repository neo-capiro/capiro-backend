#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import process from 'node:process';

const DEFAULT_MAX_PROVIDER_RECORD_BYTES = 5_500_000;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    args[argv[index].slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateRenderingConfig(page) {
  const config = page.renderingConfig;
  assert(
    config && typeof config === 'object' && !Array.isArray(config),
    `page ${page.pageNumber} requires renderingConfig`,
  );
  assert(
    typeof config.renderer === 'string' && config.renderer.length > 0,
    `page ${page.pageNumber} renderingConfig.renderer is required`,
  );
  assert(
    typeof config.rendererVersion === 'string' &&
      config.rendererVersion.length > 0,
    `page ${page.pageNumber} renderingConfig.rendererVersion is required`,
  );
  assert(
    Number.isFinite(Number(config.dpi)) && Number(config.dpi) > 0,
    `page ${page.pageNumber} renderingConfig.dpi must be positive`,
  );
  return config;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assert(args.request, '--request is required');
  assert(args.out, '--out is required');
  const maxProviderRecordBytes = Number(
    process.env.NVIDIA_MAX_PROVIDER_RECORD_BYTES ??
      DEFAULT_MAX_PROVIDER_RECORD_BYTES,
  );
  assert(
    Number.isInteger(maxProviderRecordBytes) &&
      maxProviderRecordBytes > 0 &&
      maxProviderRecordBytes < 6_000_000,
    'NVIDIA_MAX_PROVIDER_RECORD_BYTES must be a positive integer below 6,000,000 bytes',
  );

  const requestPath = resolve(args.request);
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  assert(
    Array.isArray(request.pages) && request.pages.length > 0,
    'request.pages is required',
  );

  const rendered = [];
  for (const page of request.pages) {
    assert(
      typeof page.renderedImagePath === 'string' &&
        page.renderedImagePath.length > 0,
      `page ${page.pageNumber} requires renderedImagePath`,
    );
    const renderingConfig = validateRenderingConfig(page);
    const imagePath = resolve(dirname(requestPath), page.renderedImagePath);
    const bytes = await readFile(imagePath);
    const imageSha256 = sha256(bytes);
    const mimeType = page.mimeType ?? 'image/png';
    assert(
      mimeType === 'image/png',
      `page ${page.pageNumber} must use image/png`,
    );

    const providerPayload = {
      model: 'nvidia/nemotron-parse',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${bytes.toString('base64')}`,
              },
            },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'markdown_bbox' },
        },
      ],
      temperature: 0.0,
    };
    if (page.maxTokens !== undefined && page.maxTokens !== null) {
      const maxTokens = Number(page.maxTokens);
      assert(
        Number.isInteger(maxTokens) && maxTokens > 0,
        `page ${page.pageNumber} maxTokens must be a positive integer when explicitly set`,
      );
      providerPayload.max_tokens = maxTokens;
    }

    const providerPayloadText = canonicalJson(providerPayload);
    const providerPayloadBytes = Buffer.byteLength(providerPayloadText, 'utf8');
    assert(
      providerPayloadBytes <= maxProviderRecordBytes,
      `page ${page.pageNumber} provider JSON record is ${providerPayloadBytes} bytes; reduce/render/compress below ${maxProviderRecordBytes} bytes before Batch Transform`,
    );
    const providerPayloadSha256 = sha256(providerPayloadText);
    const renderingConfigSha256 = sha256(canonicalJson(renderingConfig));

    rendered.push({
      ...page,
      renderingConfig,
      renderingConfigSha256,
      renderedImage: {
        fileName: basename(imagePath),
        sha256: imageSha256,
        mimeType,
        providerPayloadBytes,
      },
      providerPayload,
      providerPayloadSha256,
    });
  }

  const output = {
    ...request,
    materializationSchemaVersion: 'phase8_session5_provider_payload_v2',
    maxProviderRecordBytes,
    pages: rendered,
  };
  await mkdir(dirname(resolve(args.out)), { recursive: true });
  await writeFile(args.out, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `${JSON.stringify({ pages: rendered.length, output: resolve(args.out) })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exitCode = 1;
});
