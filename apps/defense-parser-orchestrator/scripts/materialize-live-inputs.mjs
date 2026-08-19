#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import process from 'node:process';

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assert(args.request, '--request is required');
  assert(args.out, '--out is required');
  const requestPath = resolve(args.request);
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  assert(Array.isArray(request.pages) && request.pages.length > 0, 'request.pages is required');

  const rendered = [];
  for (const page of request.pages) {
    assert(typeof page.renderedImagePath === 'string' && page.renderedImagePath.length > 0,
      `page ${page.pageNumber} requires renderedImagePath`);
    const imagePath = resolve(dirname(requestPath), page.renderedImagePath);
    const bytes = await readFile(imagePath);
    const imageSha256 = sha256(bytes);
    const mimeType = page.mimeType ?? 'image/png';
    assert(mimeType === 'image/png', `page ${page.pageNumber} must use image/png`);
    const providerPayload = {
      model: 'nvidia/nemotron-parse',
      messages: [{
        role: 'user',
        content: [{
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${bytes.toString('base64')}` },
        }],
      }],
      max_tokens: Number(page.maxTokens ?? 2000),
    };
    assert(Number.isInteger(providerPayload.max_tokens) && providerPayload.max_tokens > 0,
      `page ${page.pageNumber} maxTokens must be a positive integer`);
    rendered.push({
      ...page,
      renderedImage: {
        fileName: basename(imagePath),
        sha256: imageSha256,
        mimeType,
      },
      providerPayload,
    });
  }

  const output = { ...request, pages: rendered };
  await mkdir(dirname(resolve(args.out)), { recursive: true });
  await writeFile(args.out, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ pages: rendered.length, output: resolve(args.out) })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exitCode = 1;
});
