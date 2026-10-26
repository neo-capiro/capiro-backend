import { IsUUID } from 'class-validator';

/** Explicit opt-in for an existing invitation; never caller-authored mail. */
export class SendInviteEmailDto {
  @IsUUID() draftId!: string;
  @IsUUID() invitationId!: string;
}

export type CollaboratorEmailStatus = 'not_requested' | 'claimed' | 'sending' | 'accepted' |
  'disabled' | 'failed' | 'cancelled' | 'outcome_unknown';

export interface CollaboratorEmailReceipt {
  draftId: string;
  invitationId: string;
  status: CollaboratorEmailStatus;
  /** SES acceptance only; this owner has no delivery/bounce observation. */
  providerMessageId: string | null;
  errorCode: string | null;
  updatedAt: string | null;
}
