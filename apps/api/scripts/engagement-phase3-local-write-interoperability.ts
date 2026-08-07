#!/usr/bin/env tsx
/** Phase 3 safe database-local write interoperability proof. */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service.js';

const EVIDENCE = required('ENGAGEMENT_PHASE3_EVIDENCE_DIR');
const TOKEN_FILE = required('ENGAGEMENT_PHASE3_ADMIN_TOKEN_FILE');
const PROXY_URL = process.env.ENGAGEMENT_PHASE3_PROXY_URL ?? 'http://127.0.0.1:4600';
const MAIN_URL = process.env.ENGAGEMENT_PHASE3_MAIN_URL ?? 'http://127.0.0.1:4000';
const TITLE = '[PHASE3_PARITY_FIXTURE] — shared task interoperability probe';
const UPDATED_TITLE = `${TITLE} — updated through main`;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function jsonRequest(
  base: string,
  relative: string,
  token: string,
  init: RequestInit = {},
  preview = false,
) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (preview) headers.set('X-Capiro-Engagement-Preview', 'v3');
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${base}${relative}`, { ...init, headers, redirect: 'manual' });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  if (preview && response.headers.get('x-capiro-service') !== 'engagement-api') {
    throw new Error(`${init.method ?? 'GET'} ${relative}: preview service identity missing`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${init.method ?? 'GET'} ${relative}: expected 2xx, got ${response.status}`);
  }
  return body as Record<string, unknown> | Array<Record<string, unknown>>;
}

function rows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of ['items', 'tasks', 'data']) {
      if (Array.isArray(object[key])) return object[key] as Array<Record<string, unknown>>;
    }
  }
  return [];
}

async function main(): Promise<void> {
  const token = (await readFile(TOKEN_FILE, 'utf8')).trim();
  if (token.length < 20) throw new Error('Phase 3 bearer token file is empty or invalid');
  const prisma = new PrismaService();
  await prisma.$connect();
  let createdId = '';

  try {
    const created = await jsonRequest(
      PROXY_URL,
      '/api/engagement/tasks',
      token,
      { method: 'POST', body: JSON.stringify({ title: TITLE }) },
      true,
    );
    if (Array.isArray(created) || typeof created.id !== 'string') {
      throw new Error('Preview task create did not return an id');
    }
    createdId = created.id;

    const mainList = await jsonRequest(MAIN_URL, '/api/engagement/tasks', token);
    const mainRow = rows(mainList).find((row) => row.id === createdId);
    if (!mainRow || mainRow.title !== TITLE) {
      throw new Error('Task created through preview was not readable through main');
    }

    const updated = await jsonRequest(
      MAIN_URL,
      `/api/engagement/tasks/${encodeURIComponent(createdId)}`,
      token,
      { method: 'PATCH', body: JSON.stringify({ title: UPDATED_TITLE }) },
    );
    if (Array.isArray(updated) || updated.title !== UPDATED_TITLE) {
      throw new Error('Main task update did not persist the expected title');
    }

    const previewList = await jsonRequest(PROXY_URL, '/api/engagement/tasks', token, {}, true);
    const previewRow = rows(previewList).find((row) => row.id === createdId);
    if (!previewRow || previewRow.title !== UPDATED_TITLE) {
      throw new Error('Task updated through main was not readable through preview');
    }

    const dbCount = await prisma.withSystem((tx) =>
      tx.engagementTask.count({ where: { id: createdId } }),
    );
    if (dbCount !== 1) throw new Error(`Expected one shared task row, found ${dbCount}`);

    await writeFile(
      path.join(EVIDENCE, 'local-write-interoperability.json'),
      `${JSON.stringify(
        {
          marker: 'ENGAGEMENT_PHASE3_LOCAL_WRITE_INTEROPERABILITY_COMPLETE',
          entity: 'engagement_task',
          createOwner: 'preview',
          updateOwner: 'main',
          finalReadOwner: 'preview',
          sharedRowCount: dbCount,
          dualWrite: false,
        },
        null,
        2,
      )}\n`,
    );
    console.log('ENGAGEMENT_PHASE3_LOCAL_WRITE_INTEROPERABILITY_COMPLETE');
  } finally {
    if (createdId) {
      await prisma.withSystem((tx) => tx.engagementTask.deleteMany({ where: { id: createdId } })).catch(() => undefined);
    }
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
