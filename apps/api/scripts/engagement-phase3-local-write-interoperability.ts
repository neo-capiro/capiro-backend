#!/usr/bin/env tsx
/**
 * Phase 3 safe database-local write interoperability proof.
 *
 * Exercises the user-visible safe-write classes the Phase 3 plan permits while
 * preview external actions remain denied: meeting create/edit, task
 * create/edit, prep edit/approve, note/debrief create/edit/approve, Outreach v2
 * draft persistence, and report target/status overrides. Every entity is
 * written through one runtime and read/continued through the other against the
 * same row, then all created rows are deleted and the one edited fixture is
 * restored before containment testing begins.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service.js';

interface FixtureIndex {
  anchor: string;
  ids: Record<string, string>;
}

type JsonObject = Record<string, unknown>;

const EVIDENCE = required('ENGAGEMENT_PHASE3_EVIDENCE_DIR');
const FIXTURE_FILE = required('ENGAGEMENT_PHASE3_FIXTURE_FILE');
const TOKEN_FILE = required('ENGAGEMENT_PHASE3_ADMIN_TOKEN_FILE');
const PROXY_URL = process.env.ENGAGEMENT_PHASE3_PROXY_URL ?? 'http://127.0.0.1:4600';
const MAIN_URL = process.env.ENGAGEMENT_PHASE3_MAIN_URL ?? 'http://127.0.0.1:4000';
const MARKER = '[PHASE3_PARITY_FIXTURE]';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function fixtureId(fixtures: FixtureIndex, key: string): string {
  const value = fixtures.ids[key];
  if (!value) throw new Error(`Phase 3 fixture index missing ${key}`);
  return value;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} did not return an object`);
  }
  return value as JsonObject;
}

function idOf(value: unknown, label: string): string {
  const row = object(value, label);
  if (typeof row.id !== 'string' || !row.id) throw new Error(`${label} did not return an id`);
  return row.id;
}

function rows(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value as JsonObject[];
  if (value && typeof value === 'object') {
    const row = value as JsonObject;
    for (const key of ['items', 'tasks', 'data', 'rows']) {
      if (Array.isArray(row[key])) return row[key] as JsonObject[];
    }
  }
  return [];
}

async function jsonRequest(
  base: string,
  relative: string,
  token: string,
  init: RequestInit = {},
  preview = false,
): Promise<unknown> {
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
    // retain text for the diagnostic below
  }
  if (preview && response.headers.get('x-capiro-service') !== 'engagement-api') {
    throw new Error(`${init.method ?? 'GET'} ${relative}: preview service identity missing`);
  }
  if (response.status < 200 || response.status >= 300) {
    const diagnostic = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(
      `${init.method ?? 'GET'} ${relative}: expected 2xx, got ${response.status}: ${diagnostic}`,
    );
  }
  return body;
}

async function main(): Promise<void> {
  const [tokenRaw, fixturesRaw] = await Promise.all([
    readFile(TOKEN_FILE, 'utf8'),
    readFile(FIXTURE_FILE, 'utf8'),
  ]);
  const token = tokenRaw.trim();
  if (token.length < 20) throw new Error('Phase 3 bearer token file is empty or invalid');
  const fixtures = JSON.parse(fixturesRaw) as FixtureIndex;
  const clientId = fixtureId(fixtures, 'client.alpha');
  const existingMeetingId = fixtureId(fixtures, 'meeting.past');
  const prepId = fixtureId(fixtures, 'prep.generated.2');
  const anchor = new Date(fixtures.anchor);
  if (Number.isNaN(anchor.getTime())) throw new Error('Phase 3 fixture anchor is invalid');

  const prisma = new PrismaService();
  await prisma.$connect();
  const created = {
    meetingId: '',
    taskId: '',
    noteId: '',
    debriefId: '',
    outreachId: '',
    reportTargetId: '',
  };
  let prepBefore:
    | {
        summary: string | null;
        agenda: string[];
        status: 'generated' | 'edited' | 'approved' | 'stale' | 'failed';
      }
    | null = null;
  let cleanupComplete = false;
  const evidence: Array<Record<string, unknown>> = [];

  const cleanup = async () => {
    await prisma.withSystem(async (tx) => {
      if (created.reportTargetId) {
        await tx.engagementReportTargetOffice.deleteMany({ where: { id: created.reportTargetId } });
      }
      if (created.outreachId) {
        await tx.outreachRecord.deleteMany({ where: { id: created.outreachId } });
      }
      if (created.debriefId) {
        await tx.meetingDebrief.deleteMany({ where: { id: created.debriefId } });
      }
      if (created.noteId) await tx.meetingNote.deleteMany({ where: { id: created.noteId } });
      if (created.taskId) await tx.engagementTask.deleteMany({ where: { id: created.taskId } });
      if (created.meetingId) await tx.meeting.deleteMany({ where: { id: created.meetingId } });
      if (prepBefore) {
        await tx.meetingPrep.update({
          where: { id: prepId },
          data: {
            summary: prepBefore.summary,
            agenda: prepBefore.agenda,
            status: prepBefore.status,
          },
        });
      }
    });
    cleanupComplete = true;
  };

  try {
    // ── Meeting: create through preview, edit through main, read through preview.
    const startsAt = new Date(anchor.getTime() + 20 * 24 * 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 45 * 60 * 1000);
    const meetingSubject = `${MARKER} safe meeting interoperability`;
    const meetingUpdatedSubject = `${meetingSubject} — updated through main`;
    created.meetingId = idOf(
      await jsonRequest(
        PROXY_URL,
        '/api/engagement/meetings',
        token,
        {
          method: 'POST',
          body: JSON.stringify({
            clientId,
            subject: meetingSubject,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            location: 'Phase 3 Local Room',
          }),
        },
        true,
      ),
      'preview meeting create',
    );
    const meetingMain = object(
      await jsonRequest(MAIN_URL, `/api/engagement/meetings/${created.meetingId}`, token),
      'main meeting read',
    );
    if (meetingMain.subject !== meetingSubject) {
      throw new Error('Meeting created through preview was not readable through main');
    }
    await jsonRequest(
      MAIN_URL,
      `/api/engagement/meetings/${created.meetingId}`,
      token,
      {
        method: 'PUT',
        body: JSON.stringify({ subject: meetingUpdatedSubject, location: 'Phase 3 Updated Room' }),
      },
    );
    const meetingPreview = object(
      await jsonRequest(
        PROXY_URL,
        `/api/engagement/meetings/${created.meetingId}`,
        token,
        {},
        true,
      ),
      'preview meeting read after main update',
    );
    if (meetingPreview.subject !== meetingUpdatedSubject) {
      throw new Error('Meeting updated through main was not readable through preview');
    }
    evidence.push({ entity: 'meeting', createOwner: 'preview', updateOwner: 'main' });

    // ── Task: create through main, edit through preview, read through main.
    const taskTitle = `${MARKER} safe task interoperability`;
    const taskUpdatedTitle = `${taskTitle} — updated through preview`;
    created.taskId = idOf(
      await jsonRequest(MAIN_URL, '/api/engagement/tasks', token, {
        method: 'POST',
        body: JSON.stringify({
          clientId,
          meetingId: created.meetingId,
          title: taskTitle,
          description: 'Phase 3 safe database-local write',
        }),
      }),
      'main task create',
    );
    await jsonRequest(
      PROXY_URL,
      `/api/engagement/tasks/${created.taskId}`,
      token,
      { method: 'PATCH', body: JSON.stringify({ title: taskUpdatedTitle, status: 'in_progress' }) },
      true,
    );
    const taskMainList = await jsonRequest(
      MAIN_URL,
      `/api/engagement/tasks?clientId=${encodeURIComponent(clientId)}`,
      token,
    );
    const taskMain = rows(taskMainList).find((row) => row.id === created.taskId);
    if (!taskMain || taskMain.title !== taskUpdatedTitle || taskMain.status !== 'in_progress') {
      throw new Error('Task updated through preview was not readable through main');
    }
    evidence.push({ entity: 'engagement_task', createOwner: 'main', updateOwner: 'preview' });

    // ── Prep: edit through preview, approve through main, read through preview.
    prepBefore = await prisma.withSystem((tx) =>
      tx.meetingPrep.findUnique({
        where: { id: prepId },
        select: { summary: true, agenda: true, status: true },
      }),
    );
    if (!prepBefore) throw new Error('Generated prep fixture was not found');
    const prepSummary = `${MARKER} prep edited through preview`;
    await jsonRequest(
      PROXY_URL,
      `/api/engagement/meeting-preps/${prepId}`,
      token,
      {
        method: 'PATCH',
        body: JSON.stringify({ summary: prepSummary, agenda: ['Phase 3 agenda one'] }),
      },
      true,
    );
    await jsonRequest(MAIN_URL, `/api/engagement/meeting-preps/${prepId}/approve`, token, {
      method: 'POST',
    });
    const prepMeetingId = fixtureId(fixtures, 'meeting.upcomingWithClient');
    const prepPreviewMeeting = object(
      await jsonRequest(
        PROXY_URL,
        `/api/engagement/meetings/${prepMeetingId}`,
        token,
        {},
        true,
      ),
      'preview meeting read for prep',
    );
    const prepRows = Array.isArray(prepPreviewMeeting.preps)
      ? (prepPreviewMeeting.preps as JsonObject[])
      : [];
    const prepRow = prepRows.find((row) => row.id === prepId);
    if (!prepRow || prepRow.summary !== prepSummary || prepRow.status !== 'approved') {
      throw new Error('Prep edit/approval was not shared across runtimes');
    }
    evidence.push({ entity: 'meeting_prep', editOwner: 'preview', approveOwner: 'main' });

    // ── Note: create through preview, edit through main, approve through preview.
    const noteBody = `${MARKER} note created through preview`;
    const noteUpdatedBody = `${noteBody} — edited through main`;
    created.noteId = idOf(
      await jsonRequest(
        PROXY_URL,
        `/api/engagement/meetings/${existingMeetingId}/notes`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({
            body: noteBody,
            confidential: false,
            accessLevel: 'tenant_members',
          }),
        },
        true,
      ),
      'preview note create',
    );
    await jsonRequest(
      MAIN_URL,
      `/api/engagement/meetings/${existingMeetingId}/notes/${created.noteId}`,
      token,
      {
        method: 'PATCH',
        body: JSON.stringify({
          body: noteUpdatedBody,
          confidential: false,
          accessLevel: 'tenant_members',
        }),
      },
    );
    await jsonRequest(
      PROXY_URL,
      `/api/engagement/meetings/${existingMeetingId}/notes/${created.noteId}/approve`,
      token,
      { method: 'POST' },
      true,
    );
    const noteMainList = await jsonRequest(
      MAIN_URL,
      `/api/engagement/meetings/${existingMeetingId}/notes`,
      token,
    );
    const noteMain = rows(noteMainList).find((row) => row.id === created.noteId);
    if (!noteMain || noteMain.body !== noteUpdatedBody || noteMain.status !== 'approved') {
      throw new Error('Note create/edit/approval was not shared across runtimes');
    }
    evidence.push({ entity: 'meeting_note', createOwner: 'preview', editOwner: 'main', approveOwner: 'preview' });

    // ── Debrief: create through main, edit through preview, approve through main.
    const debriefBody = `${MARKER} debrief created through main`;
    const debriefUpdatedBody = `${debriefBody} — edited through preview`;
    created.debriefId = idOf(
      await jsonRequest(
        MAIN_URL,
        `/api/engagement/meetings/${existingMeetingId}/debriefs`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({
            body: debriefBody,
            confidential: false,
            accessLevel: 'tenant_members',
          }),
        },
      ),
      'main debrief create',
    );
    await jsonRequest(
      PROXY_URL,
      `/api/engagement/meetings/${existingMeetingId}/debriefs/${created.debriefId}`,
      token,
      {
        method: 'PATCH',
        body: JSON.stringify({
          body: debriefUpdatedBody,
          confidential: false,
          accessLevel: 'tenant_members',
        }),
      },
      true,
    );
    await jsonRequest(
      MAIN_URL,
      `/api/engagement/meetings/${existingMeetingId}/debriefs/${created.debriefId}/approve`,
      token,
      { method: 'POST' },
    );
    const debriefPreviewList = await jsonRequest(
      PROXY_URL,
      `/api/engagement/meetings/${existingMeetingId}/debriefs`,
      token,
      {},
      true,
    );
    const debriefPreview = rows(debriefPreviewList).find((row) => row.id === created.debriefId);
    if (
      !debriefPreview ||
      debriefPreview.body !== debriefUpdatedBody ||
      debriefPreview.status !== 'approved'
    ) {
      throw new Error('Debrief create/edit/approval was not shared across runtimes');
    }
    evidence.push({ entity: 'meeting_debrief', createOwner: 'main', editOwner: 'preview', approveOwner: 'main' });

    // ── Outreach v2 draft: create through preview, continue through main, read through preview.
    const outreachTitle = `${MARKER} safe Outreach v2 draft`;
    const outreachUpdatedTitle = `${outreachTitle} — continued through main`;
    created.outreachId = idOf(
      await jsonRequest(
        PROXY_URL,
        '/api/engagement/outreach',
        token,
        {
          method: 'POST',
          body: JSON.stringify({
            type: 'campaign',
            clientId,
            direction: 'on-behalf',
            title: outreachTitle,
            subject: 'Phase 3 safe draft subject',
            body: 'Phase 3 safe draft body',
            recipients: [
              {
                id: 'phase3-safe-recipient',
                name: 'Phase 3 Safe Recipient',
                email: 'phase3.safe.recipient@example.invalid',
              },
            ],
            contextPool: [],
            metadata: { phase3ParityFixture: true },
            lastStep: 2,
          }),
        },
        true,
      ),
      'preview Outreach create',
    );
    await jsonRequest(
      MAIN_URL,
      `/api/engagement/outreach/${created.outreachId}`,
      token,
      {
        method: 'PATCH',
        body: JSON.stringify({
          title: outreachUpdatedTitle,
          body: 'Phase 3 safe draft body edited through main',
          lastStep: 4,
          metadata: { phase3ParityFixture: true, continuedThrough: 'main' },
        }),
      },
    );
    const outreachPreview = object(
      await jsonRequest(
        PROXY_URL,
        `/api/engagement/outreach/${created.outreachId}`,
        token,
        {},
        true,
      ),
      'preview Outreach read after main continuation',
    );
    if (outreachPreview.title !== outreachUpdatedTitle || outreachPreview.lastStep !== 4) {
      throw new Error('Outreach v2 draft continuation was not shared across runtimes');
    }
    evidence.push({ entity: 'outreach_record', createOwner: 'preview', updateOwner: 'main' });

    // ── Reports: create target through preview, override status through main, read through preview.
    const memberPrincipal = `${MARKER} Safe Target Office`;
    const createdTarget = object(
      await jsonRequest(
        PROXY_URL,
        '/api/engagement/reports/target-offices',
        token,
        {
          method: 'POST',
          body: JSON.stringify({
            clientId,
            memberPrincipal,
            committee: 'PHASE3',
            staffer: 'Safe Staffer',
            building: 'Local',
            leadOwner: 'Phase 3',
          }),
        },
        true,
      ),
      'preview report target create',
    );
    created.reportTargetId =
      typeof createdTarget.id === 'string'
        ? createdTarget.id
        : await prisma.withSystem(async (tx) => {
            const row = await tx.engagementReportTargetOffice.findFirst({
              where: { memberPrincipal, clientId },
              select: { id: true },
            });
            if (!row) throw new Error('Created report target could not be resolved');
            return row.id;
          });
    const targetRow = await prisma.withSystem((tx) =>
      tx.engagementReportTargetOffice.findUnique({
        where: { id: created.reportTargetId },
        select: { officeKey: true },
      }),
    );
    if (!targetRow?.officeKey) throw new Error('Created report target has no officeKey');
    await jsonRequest(
      MAIN_URL,
      '/api/engagement/reports/target-offices/overrides',
      token,
      {
        method: 'POST',
        body: JSON.stringify({
          clientId,
          officeKey: targetRow.officeKey,
          memberPrincipal,
          committee: 'PHASE3',
          staffer: 'Safe Staffer Updated',
          building: 'Local',
          leadOwner: 'Phase 3',
          prepStatus: 'complete',
          outreachStatus: 'in_progress',
          submissionStatus: 'not_started',
          source: 'phase3_parity',
        }),
      },
    );
    const reportPreview = object(
      await jsonRequest(
        PROXY_URL,
        `/api/engagement/reports/overview?period=all&clientId=${encodeURIComponent(clientId)}`,
        token,
        {},
        true,
      ),
      'preview report read',
    );
    const reportRows = Array.isArray(reportPreview.rows) ? (reportPreview.rows as JsonObject[]) : [];
    const reportRow = reportRows.find((row) => row.memberPrincipal === memberPrincipal);
    if (
      !reportRow ||
      reportRow.prepStatus !== 'complete' ||
      reportRow.outreachStatus !== 'in_progress' ||
      reportRow.submissionStatus !== 'not_started'
    ) {
      throw new Error('Report target/status override was not shared across runtimes');
    }
    evidence.push({ entity: 'engagement_report_target_office', createOwner: 'preview', updateOwner: 'main' });

    // Shared-row uniqueness before cleanup: one physical row per created id.
    const sharedCounts = await prisma.withSystem(async (tx) => ({
      meetings: await tx.meeting.count({ where: { id: created.meetingId } }),
      tasks: await tx.engagementTask.count({ where: { id: created.taskId } }),
      notes: await tx.meetingNote.count({ where: { id: created.noteId } }),
      debriefs: await tx.meetingDebrief.count({ where: { id: created.debriefId } }),
      outreach: await tx.outreachRecord.count({ where: { id: created.outreachId } }),
      reportTargets: await tx.engagementReportTargetOffice.count({
        where: { id: created.reportTargetId },
      }),
    }));
    for (const [entity, count] of Object.entries(sharedCounts)) {
      if (count !== 1) throw new Error(`${entity}: expected one shared row, found ${count}`);
    }

    await cleanup();
    const residual = await prisma.withSystem(async (tx) => ({
      meetings: await tx.meeting.count({ where: { id: created.meetingId } }),
      tasks: await tx.engagementTask.count({ where: { id: created.taskId } }),
      notes: await tx.meetingNote.count({ where: { id: created.noteId } }),
      debriefs: await tx.meetingDebrief.count({ where: { id: created.debriefId } }),
      outreach: await tx.outreachRecord.count({ where: { id: created.outreachId } }),
      reportTargets: await tx.engagementReportTargetOffice.count({
        where: { id: created.reportTargetId },
      }),
    }));
    if (Object.values(residual).some((count) => count !== 0)) {
      throw new Error(`Safe-write cleanup left residual rows: ${JSON.stringify(residual)}`);
    }

    await writeFile(
      path.join(EVIDENCE, 'local-write-interoperability.json'),
      `${JSON.stringify(
        {
          marker: 'ENGAGEMENT_PHASE3_LOCAL_WRITE_INTEROPERABILITY_COMPLETE',
          entities: evidence,
          entityClasses: evidence.length,
          sharedCounts,
          cleanupResidual: residual,
          prepFixtureRestored: true,
          dualWrite: false,
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `ENGAGEMENT_PHASE3_LOCAL_WRITE_INTEROPERABILITY_COMPLETE entities=${evidence.length}`,
    );
  } finally {
    if (!cleanupComplete) await cleanup().catch(() => undefined);
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
