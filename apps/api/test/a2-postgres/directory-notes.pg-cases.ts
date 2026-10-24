import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import type { admissionsFixture } from './admissions-fixture.js';
import { actor, ctx, foreign, id, outsider, release, settled, tenant } from './fixture.js';
import {
  commitMemberNote,
  parseMemberNoteCommand,
  readMemberNoteReceipt,
} from '../../src/directory/directory-note-command.js';

type Fixture = Awaited<ReturnType<typeof admissionsFixture>>;
const member = { id: 'member-42', name: 'Synthetic Member' };
const command = (request = 140) =>
  parseMemberNoteCommand(member.id, {
    schemaVersion: 1,
    requestId: id(request),
    kind: 'note',
    directoryContactName: member.name,
    body: 'Synthetic reviewed briefing.',
  });

/** Extend only the guarded admissions schema; apply the real historical migration.
 * Its historical UUID/updated-at functions are supplied within that fixture schema. */
export async function installDirectoryNotes(h: Fixture) {
  await h.sql(`
    ALTER TABLE users
      ADD email text NOT NULL UNIQUE DEFAULT (gen_random_uuid()::text || '@example.test'),
      ADD first_name text, ADD last_name text;
    CREATE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
    CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
  `);
  await h.sql(
    readFileSync(
      resolve(
        __dirname,
        '../../prisma/migrations/20260503170000_directory_contact_notes/migration.sql',
      ),
      'utf8',
    ),
  );
}

export function directoryNoteCases(getFixture: () => Fixture) {
  const commit = (input = command(), context: TenantContext = ctx) => {
    const h = getFixture();
    return h.prisma.withTenant(context.tenantId, (tx) =>
      commitMemberNote(tx, context, member.id, input, async () => member),
    );
  };
  const read = (context: TenantContext = ctx, target = member.id) => {
    const h = getFixture();
    return h.prisma.withTenant(context.tenantId, (tx) =>
      readMemberNoteReceipt(tx, context, target, command().requestId),
    );
  };
  const count = async (table: 'directory_contact_notes' | 'audit_logs') =>
    (await getFixture().sql(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count;

  it('serializes identical Directory note requests into one immutable note and one audit', async () => {
    const h = getFixture();
    const gate = await h.lock('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `directory-member-note:${tenant}:${command().requestId}`,
    ]);
    const pending = Promise.all([settled(commit()), settled(commit())]);
    try {
      await h.waitForLock('pg_advisory_xact_lock', 2);
    } finally {
      await release(gate);
    }
    const results = await pending;
    expect(results.map((result) => result.error)).toEqual([undefined, undefined]);
    const first = results[0].value!;
    expect(results[1].value).toEqual(first);
    expect(await read()).toEqual(first);
    expect(first.note).toMatchObject({ id: command().requestId, body: command().body });
    expect(await count('directory_contact_notes')).toBe(1);
    expect(await count('audit_logs')).toBe(1);
    await expect(commit({ ...command(), body: 'Different body' })).rejects.toMatchObject({
      status: 409,
    });
    expect(await count('directory_contact_notes')).toBe(1);
    expect(await count('audit_logs')).toBe(1);
  });

  it('rolls back the Directory note when its actual audit INSERT fails', async () => {
    const h = getFixture();
    await h.sql(`ALTER TABLE audit_logs ADD CONSTRAINT a2_directory_audit_failure
      CHECK(action<>'directory_contact_note.created')`);
    try {
      await expect(commit()).rejects.toThrow();
    } finally {
      await h.sql('ALTER TABLE audit_logs DROP CONSTRAINT a2_directory_audit_failure');
    }
    expect(await count('directory_contact_notes')).toBe(0);
    expect(await count('audit_logs')).toBe(0);
    await expect(read()).rejects.toMatchObject({ status: 404 });
    await commit();
    expect(await count('directory_contact_notes')).toBe(1);
    expect(await count('audit_logs')).toBe(1);
  });

  it('uses current membership after a real row-lock wait and refuses saved receipt access after revocation', async () => {
    const h = getFixture();
    const revoke = await h.lock(
      `UPDATE tenant_memberships SET status='removed' WHERE tenant_id=$1 AND user_id=$2`,
      [tenant, actor],
    );
    const pending = settled(commit());
    try {
      await h.waitForLock('FROM tenant_memberships');
    } finally {
      await release(revoke);
    }
    expect((await pending).error).toMatchObject({ status: 403 });
    expect(await count('directory_contact_notes')).toBe(0);
    expect(await count('audit_logs')).toBe(0);
    await h.sql(`UPDATE tenant_memberships SET status='active' WHERE tenant_id=$1 AND user_id=$2`, [
      tenant,
      actor,
    ]);
    await commit();
    await h.sql(
      `UPDATE tenant_memberships SET status='removed' WHERE tenant_id=$1 AND user_id=$2`,
      [tenant, actor],
    );
    await expect(read()).rejects.toMatchObject({ status: 403 });
    await expect(commit()).rejects.toMatchObject({ status: 403 });
    expect(await count('directory_contact_notes')).toBe(1);
    expect(await count('audit_logs')).toBe(1);
  });

  it('excludes another active tenant, actor, and target from the original Directory note receipt', async () => {
    const h = getFixture();
    await commit();
    await h.sql(
      `INSERT INTO tenant_memberships(tenant_id,user_id,role,status)
      VALUES($1,$2,'standard_user','active')`,
      [foreign, actor],
    );
    const otherActor = { ...ctx, userId: outsider, clerkUserId: 'a2-synthetic-other' };
    await expect(read({ ...ctx, tenantId: foreign })).rejects.toMatchObject({ status: 404 });
    await expect(read(otherActor)).rejects.toMatchObject({ status: 404 });
    await expect(read(ctx, 'member-43')).rejects.toMatchObject({ status: 404 });
    await expect(commit(command(), otherActor)).rejects.toMatchObject({ status: 409 });
    expect(await count('directory_contact_notes')).toBe(1);
    expect(await count('audit_logs')).toBe(1);
  });

  it('retains command identity and body while returning current author display metadata', async () => {
    const h = getFixture();
    const first = await commit();
    await h.sql('UPDATE users SET first_name=$1 WHERE id=$2', ['Synthetic updated author', actor]);
    const current = await read();
    expect(current.payloadDigest).toBe(first.payloadDigest);
    expect(current.requestId).toBe(first.requestId);
    expect(current.note.body).toBe(first.note.body);
    expect(current.note.directoryContactName).toBe(first.note.directoryContactName);
    expect(current.note.createdBy?.firstName).toBe('Synthetic updated author');
    expect(await commit()).toEqual(current);
    expect(await count('audit_logs')).toBe(1);
  });
}
