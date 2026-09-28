export interface MeriActionLogicalFailure {
  status: 'failed_terminal' | 'outcome_unknown';
  errorCode: string;
  errorMessage: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function message(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/**
 * Classify resolved logical failures using the concrete result contract owned by
 * each handler. Thrown/transport failures remain the proposal service's concern.
 */
export function classifyMeriActionLogicalFailure(
  tool: string,
  result: unknown,
): MeriActionLogicalFailure | null {
  const value = record(result);
  if (tool === 'send_email') {
    if (typeof value.error === 'string') {
      return {
        status: 'failed_terminal',
        errorCode: 'send_email_failed',
        errorMessage: message(value.error, 'The email was not sent.'),
      };
    }
    const receipt = record(value.sendReceipt);
    const providerIdentityConfirmed =
      (receipt.provider === 'gmail' && typeof receipt.providerMessageId === 'string'
        && receipt.providerMessageId.trim().length > 0) ||
      (receipt.provider === 'microsoft_graph' && typeof receipt.providerDraftId === 'string'
        && receipt.providerDraftId.trim().length > 0);
    if (value.ok === true && typeof value.sentFrom === 'string' && typeof value.to === 'string'
      && typeof value.subject === 'string' && receipt.ok === true
      && typeof receipt.correlationId === 'string' && receipt.correlationId.trim().length > 0
      && providerIdentityConfirmed) return null;
    return {
      status: 'outcome_unknown',
      errorCode: 'send_email_receipt_missing',
      errorMessage: 'The send handler did not return an authoritative provider acceptance receipt. Check Sent Items before retrying.',
    };
  }

  if (tool === 'reply_email') {
    if (typeof value.error === 'string') {
      return {
        status: 'failed_terminal',
        errorCode: 'reply_email_failed',
        errorMessage: message(value.error, 'The email reply was not sent.'),
      };
    }
    if (
      value.ok === true &&
      typeof value.sentFrom === 'string' &&
      typeof value.to === 'string' &&
      typeof value.subject === 'string'
    ) {
      return null;
    }
    return {
      status: 'outcome_unknown',
      errorCode: 'reply_email_receipt_missing',
      errorMessage:
        'The reply handler did not return a confirmed send receipt. Check the mail thread before retrying.',
    };
  }

  if (tool === 'schedule_task') {
    if (value.scheduled === false) {
      return {
        status: 'failed_terminal',
        errorCode: 'schedule_task_rejected',
        errorMessage: message(value.error, 'The scheduled task was not created.'),
      };
    }
    const task = record(value.task);
    if (value.scheduled === true && typeof task.id === 'string' && task.id.trim()) return null;
    return {
      status: 'outcome_unknown',
      errorCode: 'schedule_task_receipt_missing',
      errorMessage:
        'The scheduler did not return a confirmed task identity. Check scheduled tasks before retrying.',
    };
  }

  if (tool === 'cancel_scheduled_task') {
    if (value.canceled === false) {
      return {
        status: 'failed_terminal',
        errorCode: 'cancel_scheduled_task_rejected',
        errorMessage: message(value.error, 'The scheduled task was not canceled.'),
      };
    }
    if (value.canceled === true && typeof value.taskId === 'string' && value.taskId.trim()) return null;
    return {
      status: 'outcome_unknown',
      errorCode: 'cancel_scheduled_task_receipt_missing',
      errorMessage:
        'The scheduler did not return a confirmed cancellation receipt. Check the task before retrying.',
    };
  }

  return null;
}
