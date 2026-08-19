#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import process from 'node:process';

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
      // Nemotron Parse NIM 1.5 uses the OpenAI-compatible VLM request surface.
      // Internal provenance stays in the sidecar and must never be sent to the model.
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
      max_tokens: Number(page.maxTokens ?? 2000),
    };
    assert(
      Number.isInteger(providerPayload.max_tokens) &&
        providerPayload.max_tokens > 0,
      `page ${page.pageNumber} maxTokens must be a positive integer`,
    );

    const providerPayloadSha256 = sha256(canonicalJson(providerPayload));
    const renderingConfigSha256 = sha256(canonicalJson(renderingConfig));

    rendered.push({
      ...page,
      renderingConfig,
      renderingConfigSha256,
      renderedImage: {
        fileName: basename(imagePath),
        sha256: imageSha256,
        mimeType,
      },
      providerPayload,
      providerPayloadSha256,
    });
  }

  const output = {
    ...request,
    materializationSchemaVersion: 'phase8_session5_provider_payload_v2',
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
