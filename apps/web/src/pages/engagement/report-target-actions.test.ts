import { describe, expect, it } from 'vitest';
import {
  buildReportTargetCreateBody,
  buildReportTargetAssignment,
  buildReportTargetRestoreBody,
  reportTargetClientLabel,
  requireReportYear,
} from './report-target-actions.js';

describe('legacy report target writes', () => {
  it('requires the explicit client field instead of inheriting a hidden global scope', () => {
    expect(() =>
      buildReportTargetCreateBody({
        values: { memberPrincipal: 'Office', manualOnly: true },
        editedFields: new Set(),
        reportYear: 2025,
      }),
    ).toThrow('Select a client');
  });

  it('preserves the selected client and previous reporting year', () => {
    expect(
      buildReportTargetCreateBody({
        values: { clientId: 'client-b', memberPrincipal: 'Directory default' },
        directoryContactId: 'member-42',
        editedFields: new Set(),
        reportYear: 2025,
      }),
    ).toEqual({ clientId: 'client-b', directoryContactId: 'member-42', reportYear: 2025 });
  });

  it('does not silently create a manual target when no Directory record is selected', () => {
    expect(() =>
      buildReportTargetCreateBody({
        values: { clientId: 'client-a', memberPrincipal: 'Office' },
        editedFields: new Set(['memberPrincipal']),
        reportYear: 2026,
      }),
    ).toThrow('explicitly choose a manual-only target');
  });

  it('only sends deliberate display overrides for a canonical target, including explicit blanks', () => {
    const body = buildReportTargetCreateBody({
      values: {
        clientId: 'client-a',
        memberPrincipal: 'Preferred display name',
        committee: 'Directory committee',
        building: '',
        staffer: 'Directory staff',
      },
      directoryContactId: 'member-42',
      editedFields: new Set(['memberPrincipal', 'building']),
      reportYear: 2026,
    });
    expect(body).toEqual({
      clientId: 'client-a',
      directoryContactId: 'member-42',
      reportYear: 2026,
      memberPrincipal: 'Preferred display name',
      building: null,
    });
  });

  it('manual-only is an explicit choice and does not keep a stale Directory identity', () => {
    const body = buildReportTargetCreateBody({
      values: { clientId: 'client-a', memberPrincipal: 'Planned office', manualOnly: true },
      directoryContactId: 'member-42',
      editedFields: new Set(),
      reportYear: 2026,
    });
    expect(body).toMatchObject({
      clientId: 'client-a',
      manualOnly: true,
      memberPrincipal: 'Planned office',
    });
    expect(body).not.toHaveProperty('directoryContactId');
  });

  it('makes All Time writes fail rather than silently writing the current year', () => {
    expect(() => requireReportYear(null)).toThrow('All Time is read-only');
    expect(() => requireReportYear(undefined)).toThrow('All Time is read-only');
  });

  it('restores only the selected field for the selected year and row client', () => {
    expect(
      buildReportTargetRestoreBody({
        row: { clientId: 'client-b', officeKey: 'directory:member-42' },
        field: 'outreachStatus',
        reportYear: 2025,
      }),
    ).toEqual({
      clientId: 'client-b',
      officeKey: 'directory:member-42',
      field: 'outreachStatus',
      reportYear: 2025,
    });
  });

  it('requires legacy unassigned targets to be assigned before editing statuses', () => {
    expect(() =>
      buildReportTargetRestoreBody({
        row: { clientId: null, officeKey: 'manual:legacy' },
        field: 'prepStatus',
        reportYear: 2026,
      }),
    ).toThrow('Select a client');
  });

  it('never labels a client-owned target firm-wide because its name is unavailable', () => {
    expect(reportTargetClientLabel({ clientId: 'client-b', clientName: null })).toBe(
      'Client client-b',
    );
    expect(reportTargetClientLabel({ clientId: null, clientName: null })).toBe(
      'Unassigned — select a client',
    );
  });

  it('assigns an unassigned saved target using only the explicitly selected client', () => {
    expect(
      buildReportTargetAssignment({ targetId: 'target-1', clientId: null }, 'client-b'),
    ).toEqual({ targetId: 'target-1', body: { clientId: 'client-b' } });
    expect(() =>
      buildReportTargetAssignment({ targetId: 'target-1', clientId: null }, undefined),
    ).toThrow('Select a client');
  });

  it('does not accidentally reassign an already owned or archived target', () => {
    expect(() =>
      buildReportTargetAssignment({ targetId: 'target-1', clientId: 'client-a' }, 'client-b'),
    ).toThrow('already belongs to a client');
    expect(() =>
      buildReportTargetAssignment(
        { targetId: 'target-1', clientId: null, archivedAt: '2026-09-08T00:00:00Z' },
        'client-b',
      ),
    ).toThrow('Archived targets');
  });
});
