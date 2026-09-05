// Step 7 — Send. Extracted from NewOutreachWizard.tsx (previously the inline
// StepSend function) as part of the real Tailwind + React Aria migration
// (handover §0, §6.10) — every handler and piece of state below is
// unchanged, only the JSX/CSS. Three render branches, unchanged from before:
//   1. Durable send-intent result view (versionedOutreach + an active intent).
//   2. Legacy post-send confirmation (pre-Phase-0 path, `sentResult`).
//   3. The main "Ready to send" pre-send screen.
import type { OutreachRecipient } from '../../OutreachView.js';
import type { OutreachSenderInbox } from './NewOutreachWizard.js';
import {
  DELIVERY_STATUS_COPY,
  showRetryControl,
  summarizeIntent,
  type SendIntentView,
} from './send-intent.js';
import type { SendPreflightResult } from './send-preflight.js';
import './ui/tailwind.css';
import { Icon } from './ui/icons.js';
import { Button } from './ui/Button.js';
import { Select } from './ui/Select.js';
import { Switch } from './ui/Switch.js';

interface Props {
  recipients: OutreachRecipient[];
  sendableCount: number;
  failedCount: number;
  sendFrom: string | null;
  sendableInboxes: OutreachSenderInbox[];
  selectedInboxId: string | undefined;
  onSelectInbox: (id: string) => void;
  emailConnected: boolean;
  hasSignature: boolean;
  appendSignature: boolean;
  onToggleSignature: (next: boolean) => void;
  onSend: () => void;
  onTest: () => void;
  /** §f2 — the currently-sendable slots a test preview may choose from. */
  testPreviewOptions: Array<{ genKey: string; label: string }>;
  testPreviewGenerationKey: string | null;
  onSelectTestPreview: (genKey: string) => void;
  sending: boolean;
  testing: boolean;
  sentResult: { sent: number; failed: number } | null;
  onDone: () => void;
  /** Phase 0: render the durable-intent result view instead of a count. */
  versionedOutreach: boolean;
  sendIntent: SendIntentView | undefined;
  intentPolling: boolean;
  sendLocked: boolean;
  onRetryFailed: () => void;
  onCancelIntent: () => void;
  /** Phase 2 §3.h1 — full blockers/warnings + sendable count, computed fresh every render. */
  preflight: SendPreflightResult;
}

export function StepSend({
  recipients,
  sendableCount,
  sendFrom,
  sendableInboxes,
  selectedInboxId,
  onSelectInbox,
  emailConnected,
  hasSignature,
  appendSignature,
  onToggleSignature,
  onSend,
  onTest,
  testPreviewOptions,
  testPreviewGenerationKey,
  onSelectTestPreview,
  sending,
  testing,
  sentResult,
  onDone,
  versionedOutreach,
  sendIntent,
  intentPolling,
  sendLocked,
  onRetryFailed,
  onCancelIntent,
  preflight,
}: Props) {
  // Nothing sendable (every draft failed, or none generated) → block Send and
  // say why, so the primary CTA is never a dead click into a backend 400.
  const nothingToSend = sendableCount === 0;

  /**
   * Phase 0 (§3.g6) — one row per DELIVERY, with the real provider outcome.
   *
   * Deliberate omissions:
   *   • an `unknown` row gets NO Retry button. The provider may already have
   *     delivered it, so the only safe instruction is "verify Sent Items".
   *   • nothing is reported as a blanket success while any outcome is undetermined.
   */
  if (versionedOutreach && sendIntent) {
    const summary = summarizeIntent(sendIntent);
    const retryable = sendIntent.deliveries.filter((d) => showRetryControl(d.status));
    return (
      <div className="ov2-tw-root mx-auto max-w-[840px] text-left">
        <h2 className="text-center text-[22px] leading-7 font-bold tracking-[-0.02em] text-ink-primary">
          {intentPolling
            ? 'Sending…'
            : summary.hasUnknown
              ? `Sent ${summary.sent} · ${summary.unknown} unconfirmed`
              : summary.failed > 0
                ? `Sent ${summary.sent}, ${summary.failed} failed`
                : `${summary.sent} ${summary.sent === 1 ? 'email' : 'emails'} sent`}
        </h2>
        <div className="mt-1.5 text-center text-[13.5px] text-ink-secondary">
          {sendIntent.testMode ? 'Test send — only you received a copy. ' : ''}
          {summary.inFlight > 0 ? `${summary.inFlight} still in progress. ` : ''}
          {summary.hasUnknown
            ? 'Some outcomes could not be confirmed — check Sent Items before resending those.'
            : ''}
        </div>

        {summary.hasUnknown && (
          <div className="my-4 flex gap-2.5 rounded-md border border-warning-border bg-warning-bg p-3">
            <Icon.AlertTriangle size={16} className="mt-0.5 flex-none text-warning-heading" />
            <div>
              <div className="text-[13px] font-semibold text-warning-heading">
                {summary.unknown} delivery outcome(s) unknown
              </div>
              <div className="mt-0.5 text-[12.5px] text-ink-secondary">
                {DELIVERY_STATUS_COPY.unknown}
              </div>
            </div>
          </div>
        )}

        <div className="mt-4 rounded-md border border-line-hairline">
          {sendIntent.deliveries.map((d, i) => (
            <div
              key={d.id}
              className={`flex items-start justify-between gap-3 p-3 ${i > 0 ? 'border-t border-line-hairline' : ''}`}
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-semibold text-ink-primary">
                  {d.to.map((t) => t.email).join(', ') || d.recipientKey}
                </div>
                <div className="text-[12.5px] text-ink-secondary">{d.subject}</div>
                {d.cc.length > 0 && (
                  <div className="text-xs text-ink-secondary">Cc: {d.cc.join(', ')}</div>
                )}
                {/* Provider ids make a send reconcilable against the mailbox. */}
                {(d.providerMessageId || d.providerDraftId) && (
                  <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                    {d.provider === 'gmail' ? 'Gmail id' : 'Outlook draft'}:{' '}
                    {d.providerMessageId ?? d.providerDraftId}
                  </div>
                )}
                {d.errorMessage && (
                  <div className="mt-0.5 text-xs text-danger">
                    {d.errorCode ? `${d.errorCode}: ` : ''}
                    {d.errorMessage}
                  </div>
                )}
              </div>
              <div className="flex-none text-[12.5px] text-ink-secondary">
                {DELIVERY_STATUS_COPY[d.status]}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-5 flex justify-center gap-2">
          {intentPolling && (
            <Button variant="secondary" onPress={onCancelIntent}>
              Cancel queued
            </Button>
          )}
          {/* Retry exists ONLY for explicit failures, and creates a NEW intent. */}
          {!intentPolling && retryable.length > 0 && (
            <Button variant="secondary" onPress={onRetryFailed}>
              Create new send for {retryable.length} failed
            </Button>
          )}
          {!intentPolling && (
            <Button variant="primary" onPress={onDone}>
              <Icon.Check size={16} /> Done
            </Button>
          )}
        </div>
      </div>
    );
  }

  // Post-send confirmation screen (pre-Phase-0 path).
  if (sentResult) {
    return (
      <div className="ov2-tw-root mx-auto max-w-[840px] py-12 text-center">
        <Icon.CheckCircle01 size={52} className="mx-auto text-success" />
        <h2 className="mt-4.5 text-[22px] leading-7 font-bold tracking-[-0.02em] text-ink-primary">
          {sentResult.failed > 0
            ? `Sent ${sentResult.sent}, ${sentResult.failed} failed`
            : `${sentResult.sent} ${sentResult.sent === 1 ? 'email' : 'emails'} sent`}
        </h2>
        <div className="mt-1.5 text-[13.5px] text-ink-secondary">
          {sentResult.failed > 0
            ? 'Some emails could not be sent. Check the failed addresses and your email connection, then retry from Outreach.'
            : `Your personalized emails went out from ${sendFrom || 'your connected inbox'}.`}
        </div>
        <div className="mt-5 flex justify-center">
          <Button variant="primary" onPress={onDone}>
            <Icon.Check size={16} /> Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="ov2-tw-root mx-auto max-w-[840px] py-10 text-center">
      <h2 className="mt-3.5 text-[22px] leading-7 font-bold tracking-[-0.02em] text-ink-primary">
        Ready to send
      </h2>
      <div className="mt-1.5 text-[13.5px] text-ink-secondary">
        <b className="font-semibold text-ink-primary">{preflight.sendableCount}</b> personalized{' '}
        {preflight.sendableCount === 1 ? 'email is' : 'emails are'} ready. Capiro will send from{' '}
        <b className="font-semibold text-ink-primary">{sendFrom || 'your connected inbox'}</b>.
      </div>

      {sendableInboxes.length > 1 && (
        <div className="mt-4 flex flex-col items-center">
          <div className="mb-1.5 text-xs text-ink-secondary">Send from</div>
          <Select
            selectedKey={selectedInboxId ?? ''}
            onSelectionChange={onSelectInbox}
            className="min-w-[280px] max-w-[440px] text-left"
            options={sendableInboxes.map((inbox) => ({
              value: inbox.id,
              label: `${inbox.accountEmail || inbox.displayName || 'Connected inbox'} · ${
                inbox.provider === 'google_workspace' ? 'Gmail' : 'Outlook'
              }`,
            }))}
          />
        </div>
      )}

      {/* Phase 2 §3.h1 — itemized recipient/group rows with To/Cc/Bcc counts,
          instead of only a flat total. */}
      {recipients.length > 0 && (
        <div className="mt-4.5 max-h-[220px] overflow-y-auto rounded-lg border border-line-hairline text-left">
          {recipients.map((r, i) => {
            const isGroup = (r.groupMembers?.length ?? 0) > 0;
            const toCount = isGroup ? r.groupMembers!.length : 1;
            return (
              <div
                key={r.id ?? r.email ?? i}
                className={`flex justify-between gap-2.5 p-3 text-[12.5px] ${i > 0 ? 'border-t border-line-hairline' : ''}`}
              >
                <span className="font-semibold text-ink-primary">
                  {r.name || r.email || 'Recipient'}
                  {isGroup && (
                    <span className="font-medium text-ink-tertiary">
                      {' '}
                      ({toCount} {toCount === 1 ? 'member' : 'members'})
                    </span>
                  )}
                </span>
                <span className="flex-none text-ink-tertiary">
                  To {toCount}
                  {(r.cc?.length ?? 0) > 0 ? ` · Cc ${r.cc!.length}` : ''}
                  {(r.bcc?.length ?? 0) > 0 ? ` · Bcc ${r.bcc!.length}` : ''}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Preflight blockers/warnings — grouped, not a wall of per-slot text. */}
      {preflight.issues.length > 0 && (
        <div className="mt-4 flex flex-col gap-1.5 text-left">
          {preflight.blockers.map((b, i) => (
            <div key={`b-${i}`} className="flex items-start gap-1.5 text-[13px] text-danger">
              <Icon.AlertCircle size={14} className="mt-0.5 flex-none" />
              {b.message}
            </div>
          ))}
          {preflight.warnings.map((w, i) => (
            <div key={`w-${i}`} className="flex items-start gap-1.5 text-[13px] text-warning-heading">
              <Icon.AlertTriangle size={14} className="mt-0.5 flex-none" />
              {w.message}
            </div>
          ))}
        </div>
      )}

      {hasSignature && (
        <div className="mt-4 inline-flex items-center gap-2.5 rounded-lg border border-line-hairline bg-surface-subtle px-3.5 py-2.5">
          <Switch isSelected={appendSignature} onChange={onToggleSignature}>
            Append my email signature
          </Switch>
        </div>
      )}

      {/* §f2 — a test send previews exactly ONE explicitly selected recipient's
          draft (the server rejects a test intent carrying more than one). Only
          meaningful under versioned outreach — the legacy path predates
          per-version test sends and is unaffected. */}
      {versionedOutreach && testPreviewOptions.length > 0 && (
        <div className="mt-4 flex flex-col items-center">
          <div className="mb-1.5 text-xs text-ink-secondary">Preview recipient</div>
          <Select
            selectedKey={testPreviewGenerationKey ?? ''}
            onSelectionChange={onSelectTestPreview}
            className="min-w-[280px] max-w-[440px] text-left"
            options={testPreviewOptions.map((o) => ({ value: o.genKey, label: o.label }))}
          />
        </div>
      )}

      <div className="mt-4 flex justify-center gap-2">
        <Button
          variant="secondary"
          onPress={onTest}
          isDisabled={
            !emailConnected ||
            nothingToSend ||
            sendLocked ||
            (versionedOutreach && !testPreviewGenerationKey)
          }
        >
          <Icon.Eye size={15} />
          {testing && !sending ? 'Sending…' : 'Send test email to myself'}
        </Button>
        <Button variant="primary" onPress={onSend} isDisabled={!preflight.canSend || sendLocked}>
          <Icon.Send01 size={15} />
          {sending ? 'Sending…' : 'Confirm Send'}
        </Button>
      </div>
      <div className="mt-3.5 text-xs text-ink-tertiary">
        “Send test email” delivers one copy to your own inbox, previewing the recipient selected
        above, so you can check formatting before the real send.
      </div>
    </div>
  );
}
