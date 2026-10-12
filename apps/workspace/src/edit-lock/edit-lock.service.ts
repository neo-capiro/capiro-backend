import { withProspectDraft, assertProspectDraft, denyProspectTransfer, requireProspectDraftInTx } from '../prospect-resources/prospect-draft-access.js';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { canEdit, canRead } from '../collaborators/role-policy.js';

// A holder is "inactive" (eligible for take-over) once their last heartbeat is
// older than this window (Q-ED-2: take-over allowed only when holder inactive
// > 10 min).
export const LOCK_INACTIVITY_MS = 10 * 60 * 1000;

export interface LockStatus {
  // True when the lock is free / inactive and the caller may hold it.
  held: boolean;
  // The caller currently holds the (active) lock.
  heldByMe: boolean;
  holderId: string | null;
  holderName: string | null;
  acquiredAt: string | null;
  lastHeartbeatAt: string | null;
  // The holder has been inactive past the window (take-over eligible).
  holderInactive: boolean;
  // A pending "request to edit" from a viewer.
  requestedById: string | null;
  requestedByName: string | null;
  requestedAt: string | null;
  // Convenience for the active editor: someone else is requesting edit access.
  hasIncomingRequest: boolean;
}

/**
 * Two-sided concurrent-edit lock (Phase 6b, Q-ED-2). DB + polling — no
 * websockets. One row per draft (draftId is the PK). The holder heartbeats
 * while editing; a viewer may `request` edit (the holder is notified on its next
 * poll) or `take over` once the holder has been inactive past
 * LOCK_INACTIVITY_MS.
 *
 * Tenant-scoped: the draft is verified against tenantId before any lock op, and
 * every lock row carries tenantId.
 */
@Injectable()
export class EditLockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly collaborators: CollaboratorsService,
  ) {}

  private async assertDraft(tenantId: string, draftId: string) {
    const draft = await this.prisma.wsDraft.findFirst({ where: { id: draftId, tenantId } });
    if (!draft) throw new NotFoundException('Draft not found');
    return draft;
  }

  /** Holding the edit-lock (acquire/take-over) is owner + editor only. */
  private async assertCanHoldLock(tenantId: string, draftId: string, actorId: string) {
    await this.collaborators.assertCan(
      tenantId,
      draftId,
      actorId,
      canEdit,
      'Only owners and editors can edit this document',
    );
  }

  private toStatus(lock: LockRow | null, selfId: string, now = Date.now()): LockStatus {
    if (!lock) {
      return {
        held: false,
        heldByMe: false,
        holderId: null,
        holderName: null,
        acquiredAt: null,
        lastHeartbeatAt: null,
        holderInactive: false,
        requestedById: null,
        requestedByName: null,
        requestedAt: null,
        hasIncomingRequest: false,
      };
    }
    const inactive = now - lock.lastHeartbeatAt.getTime() > LOCK_INACTIVITY_MS;
    const heldByMe = lock.holderId === selfId;
    return {
      held: !inactive,
      heldByMe,
      holderId: lock.holderId,
      holderName: lock.holderName,
      acquiredAt: lock.acquiredAt.toISOString(),
      lastHeartbeatAt: lock.lastHeartbeatAt.toISOString(),
      holderInactive: inactive,
      requestedById: lock.requestedById,
      requestedByName: lock.requestedByName,
      requestedAt: lock.requestedAt ? lock.requestedAt.toISOString() : null,
      // The holder sees an incoming request only if it's from someone else.
      hasIncomingRequest: heldByMe && !!lock.requestedById && lock.requestedById !== selfId,
    };
  }

  async status(tenantId: string, draftId: string, selfId: string): Promise<LockStatus> {
    const draft = await this.assertDraft(tenantId, draftId);
    return withProspectDraft(this.prisma, draft, selfId, canRead, 'read', async (db) => {
      const lock = await db.wsEditLock.findFirst({ where: { draftId, tenantId } });
      return this.toStatus(lock, selfId);
    });
  }

  /**
   * Acquire the lock if free (no row) or stale (holder inactive past the
   * window). If the caller already holds it this is a no-op heartbeat. If
   * someone else actively holds it, returns the (unchanged) status without
   * acquiring — the caller becomes a view-only viewer.
   */
  async acquire(
    tenantId: string,
    draftId: string,
    selfId: string,
    selfName: string,
  ): Promise<LockStatus> {
    const draft = await this.assertDraft(tenantId, draftId);
    return withProspectDraft(this.prisma, draft, selfId, canEdit, 'write', async (db) => {
      await this.assertCanHoldLock(tenantId, draftId, selfId);
      const existing = await db.wsEditLock.findFirst({ where: { draftId, tenantId } });
      const now = new Date();

      if (!existing) {
        const created = await db.wsEditLock.create({
          data: { draftId, tenantId, holderId: selfId, holderName: selfName },
        });
        return this.toStatus(created, selfId);
      }

      const inactive = now.getTime() - existing.lastHeartbeatAt.getTime() > LOCK_INACTIVITY_MS;
      if (existing.holderId === selfId) {
        // Already mine — heartbeat.
        const updated = await db.wsEditLock.update({
          where: { draftId },
          data: { lastHeartbeatAt: now },
        });
        return this.toStatus(updated, selfId);
      }
      if (inactive) {
        // Stale holder — claim it (clears any prior request).
        const updated = await db.wsEditLock.update({
          where: { draftId },
          data: {
            holderId: selfId,
            holderName: selfName,
            acquiredAt: now,
            lastHeartbeatAt: now,
            requestedById: null,
            requestedByName: null,
            requestedAt: null,
          },
        });
        return this.toStatus(updated, selfId);
      }
      // Actively held by someone else — caller stays view-only.
      return this.toStatus(existing, selfId);
    });
  }

  /** Heartbeat: only the active holder may extend the lock. */
  async heartbeat(tenantId: string, draftId: string, selfId: string): Promise<LockStatus> {
    const draft = await this.assertDraft(tenantId, draftId);
    return withProspectDraft(this.prisma, draft, selfId, canEdit, 'write', async (db) => {
      const lock = await db.wsEditLock.findFirst({ where: { draftId, tenantId } });
      if (!lock || lock.holderId !== selfId) {
        // Not the holder — return current status (the client will flip to viewer).
        return this.toStatus(lock, selfId);
      }
      const updated = await db.wsEditLock.update({
        where: { draftId },
        data: { lastHeartbeatAt: new Date() },
      });
      return this.toStatus(updated, selfId);
    });
  }

  /**
   * Release the lock. The holder releases on unmount / "Save & release". When a
   * request is pending, the released lock is transferred to the requester so
   * the "Save & release" flow hands editing straight to them; otherwise the row
   * is deleted (lock becomes free).
   */
  async release(tenantId: string, draftId: string, selfId: string): Promise<LockStatus> {
    const draft = await this.assertDraft(tenantId, draftId);
    return withProspectDraft(this.prisma, draft, selfId, canRead, 'read', async (db) => {
      const lock = await db.wsEditLock.findFirst({ where: { draftId, tenantId } });
      if (!lock || lock.holderId !== selfId) {
        return this.toStatus(lock, selfId);
      }
      let transferAllowed = true;
      if (draft.prospectId && lock.requestedById) {
        try {
          await requireProspectDraftInTx(db, draft, lock.requestedById, canEdit, 'write');
        } catch (error) {
          if (!(error instanceof NotFoundException)) throw error;
          transferAllowed = false;
        }
      }
      if (transferAllowed && lock.requestedById && lock.requestedByName) {
        // Transfer to the requester.
        const transferred = await db.wsEditLock.update({
          where: { draftId },
          data: {
            holderId: lock.requestedById,
            holderName: lock.requestedByName,
            acquiredAt: new Date(),
            lastHeartbeatAt: new Date(),
            requestedById: null,
            requestedByName: null,
            requestedAt: null,
          },
        });
        return this.toStatus(transferred, selfId);
      }
      await db.wsEditLock.delete({ where: { draftId } });
      return this.toStatus(null, selfId);
    });
  }

  /**
   * A viewer requests edit access. Records the request on the lock so the holder
   * sees it on its next poll. No-op if the caller is the holder or no one holds
   * it (the caller should just acquire in that case).
   */
  async request(
    tenantId: string,
    draftId: string,
    selfId: string,
    selfName: string,
  ): Promise<LockStatus> {
    const draft = await this.assertDraft(tenantId, draftId);
    return withProspectDraft(this.prisma, draft, selfId, canEdit, 'write', async (db) => {
      const lock = await db.wsEditLock.findFirst({ where: { draftId, tenantId } });
      if (!lock) throw new NotFoundException('No active editor to request from');
      if (lock.holderId === selfId) return this.toStatus(lock, selfId);
      const updated = await db.wsEditLock.update({
        where: { draftId },
        data: { requestedById: selfId, requestedByName: selfName, requestedAt: new Date() },
      });
      return this.toStatus(updated, selfId);
    });
  }

  /**
   * Take over an inactive holder's lock (Q-ED-2: allowed only when the holder's
   * last heartbeat is older than LOCK_INACTIVITY_MS). Rejected while the holder
   * is still active.
   */
  async takeOver(
    tenantId: string,
    draftId: string,
    selfId: string,
    selfName: string,
  ): Promise<LockStatus> {
    const draft = await this.assertDraft(tenantId, draftId);
    return withProspectDraft(this.prisma, draft, selfId, canEdit, 'write', async (db) => {
      await this.assertCanHoldLock(tenantId, draftId, selfId);
      const lock = await db.wsEditLock.findFirst({ where: { draftId, tenantId } });
      if (!lock) {
        // Nothing to take over — acquire fresh.
        if (!draft.prospectId) return this.acquire(tenantId, draftId, selfId, selfName);
        const created = await db.wsEditLock.create({
          data: { draftId, tenantId, holderId: selfId, holderName: selfName },
        });
        return this.toStatus(created, selfId);
      }
      if (lock.holderId === selfId) return this.toStatus(lock, selfId);
      const inactive = Date.now() - lock.lastHeartbeatAt.getTime() > LOCK_INACTIVITY_MS;
      if (!inactive) {
        throw new ForbiddenException('Editor is still active — cannot take over');
      }
      const updated = await db.wsEditLock.update({
        where: { draftId },
        data: {
          holderId: selfId,
          holderName: selfName,
          acquiredAt: new Date(),
          lastHeartbeatAt: new Date(),
          requestedById: null,
          requestedByName: null,
          requestedAt: null,
        },
      });
      return this.toStatus(updated, selfId);
    });
  }
}

interface LockRow {
  draftId: string;
  tenantId: string;
  holderId: string;
  holderName: string;
  acquiredAt: Date;
  lastHeartbeatAt: Date;
  requestedById: string | null;
  requestedByName: string | null;
  requestedAt: Date | null;
}
