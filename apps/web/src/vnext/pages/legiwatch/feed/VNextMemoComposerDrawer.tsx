import { useEffect, useRef, useState } from 'react';
import type { FeedItem } from '../../../../pages/clients/tracker/intel-feed-api.js';
import {
  feedItemToMemoAlert,
  useGenerateAlertMemo,
  useRecordMemoLink,
  useSaveAlertMemo,
  type AlertMemoResult,
} from '../../../../pages/clients/tracker/alert-actions-api.js';

export function VNextMemoComposerDrawer({
  open,
  onClose,
  clientId,
  clientName,
  item,
}: {
  open: boolean;
  onClose: () => void;
  clientId: string;
  clientName: string;
  item: FeedItem | null;
}) {
  const generate = useGenerateAlertMemo();
  const save = useSaveAlertMemo();
  const recordLink = useRecordMemoLink();
  const [memo, setMemo] = useState<AlertMemoResult | null>(null);
  const [markdown, setMarkdown] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (!open || !item || started.current) return;
    started.current = true;
    void generate
      .mutateAsync({ clientId, clientName, alert: feedItemToMemoAlert(item) })
      .then((result) => {
        const draft = typeof result?.markdown === 'string' ? result.markdown : '';
        if (!draft) return;
        setMemo(result);
        setMarkdown(draft);
      })
      .catch(() => undefined);
  }, [clientId, clientName, generate, item, open]);

  if (!open || !item) return null;
  const saveMemo = () => {
    if (!(markdown ?? '').trim() || save.isPending) return;
    void save
      .mutateAsync({
        clientId,
        clientName,
        title: memo?.title ?? `Client memo — ${item.title}`,
        markdown,
        alertId: item.id,
        generationId: memo?.generationId,
      })
      .then((result) =>
        recordLink.mutate({
          clientId,
          alertId: item.id,
          documentAttachmentId: result.document?.attachmentId,
          title: result.title,
        }),
      )
      .catch(() => undefined);
  };

  return (
    <div className="lw-drawer lw-drawer--memo" role="dialog" aria-modal="true" aria-label="Existing memo composer">
      <header className="lw-drawer__head">
        <div>
          <span className="lw-eyebrow">Memo composer</span>
          <h2>{clientName}</h2>
          <p>{clientId} · {item.id}</p>
        </div>
        <button type="button" className="lw-iconbtn" aria-label="Close" onClick={onClose}>×</button>
      </header>
      <div className="lw-drawer__body">
        <label htmlFor="vnext-memo-markdown">Draft memo</label>
        <textarea
          id="vnext-memo-markdown"
          value={markdown ?? ''}
          onChange={(event) => setMarkdown(event.target.value)}
          placeholder={generate.isPending ? 'Generating a source-backed memo…' : 'Memo text'}
          rows={18}
        />
        {generate.isError ? <p role="alert">Memo generation failed. Try again.</p> : null}
      </div>
      <footer className="lw-drawer__foot">
        <button type="button" className="lw-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="lw-btn lw-btn--primary" disabled={!(markdown ?? '').trim() || save.isPending} onClick={saveMemo}>
          {save.isPending ? 'Saving…' : 'Save memo'}
        </button>
      </footer>
    </div>
  );
}
