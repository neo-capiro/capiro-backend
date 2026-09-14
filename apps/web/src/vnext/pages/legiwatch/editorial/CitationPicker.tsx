import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroSelect, CapiroTextarea } from '../../../components/fields/index.js';
import { CapiroModal } from '../../../components/overlays/index.js';
import { EVIDENCE_BASE, type Row } from './evidence-api.js';

export function CitationPicker({
  source,
  client,
  folder,
  citation,
  onChoose,
}: {
  source: Row;
  client: string;
  folder: string;
  citation?: Row;
  onChoose: (citation: Row) => void;
}) {
  const api = useApi(),
    scope = useApiScope();
  const [open, setOpen] = useState(false),
    [locator, setLocator] = useState(citation?.locator ?? ''),
    [quote, setQuote] = useState(citation?.quote ?? '');
  const query = useQuery({
    queryKey: ['phase8-citation', scope, client, folder, source.kind, source.id],
    enabled: open,
    queryFn: async () =>
      (
        await api.get<Row>(
          `${EVIDENCE_BASE}/source/${source.kind}/${encodeURIComponent(source.id)}?${new URLSearchParams({ clientId: client, folderId: folder })}`,
        )
      ).data,
  });
  const row = query.data,
    sections: Row[] = row
      ? row.sections?.length
        ? row.sections
        : [{ locator: 'available-text', text: row.text }]
      : [];
  const section = sections.find((s) => s.locator === locator),
    start = section && quote ? String(section.text).indexOf(quote) : -1;
  return (
    <>
      <CapiroButton size="compact" onClick={() => setOpen(true)}>
        {citation ? 'Review selected passage' : 'Choose cited passage'}
      </CapiroButton>
      {open && (
        <CapiroModal open onClose={() => setOpen(false)} title={`Cite ${source.title}`}>
          {query.isPending && <p role="status">Loading the exact source version…</p>}
          {query.isError && <p role="alert">The source could not load. Close and retry.</p>}
          {row && (
            <>
              <p>
                Select a page or section, then retain an exact excerpt. Multiple lines can be copied
                from the source below.
              </p>
              <CapiroSelect
                label="Source section"
                value={locator}
                options={[
                  { value: '', label: 'Choose a section' },
                  ...sections.map((s) => ({ value: String(s.locator), label: String(s.locator) })),
                ]}
                onChange={(event) => {
                  const next = sections.find((s) => s.locator === event.target.value);
                  setLocator(event.target.value);
                  setQuote(String(next?.text ?? '').slice(0, 500));
                }}
              />
              {section && <pre className="lw-evidence-text">{section.text}</pre>}
              <CapiroTextarea
                label="Exact excerpt (up to 5,000 characters)"
                value={quote}
                rows={6}
                onChange={(event) => setQuote(event.target.value)}
              />
              {quote && start < 0 && (
                <p role="alert">The excerpt must occur exactly in the selected section.</p>
              )}
              {row.revision !== source.revision && (
                <p role="alert">This source changed. Select its current version again.</p>
              )}
              <CapiroButton
                disabled={
                  start < 0 || !quote || quote.length > 5000 || row.revision !== source.revision
                }
                onClick={() => {
                  onChoose({
                    kind: source.kind,
                    id: source.id,
                    revision: source.revision,
                    locator,
                    start,
                    end: start + quote.length,
                    quote,
                  });
                  setOpen(false);
                }}
              >
                Use this exact passage
              </CapiroButton>
            </>
          )}
        </CapiroModal>
      )}
    </>
  );
}
