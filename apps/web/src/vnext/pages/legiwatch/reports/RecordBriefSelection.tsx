import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { useIntelFeatureEnabled } from '../../../../lib/intel-feature-flags.js';
export type SelectedRecordBrief = {
  eventId: string;
  briefId: string;
  contentHash: string;
  sourceHash: string;
  version: number;
  approvedAt: string;
};
export function RecordBriefSelection({
  reportId,
  value,
  onChange,
}: {
  reportId: string;
  value: SelectedRecordBrief[];
  onChange: (value: SelectedRecordBrief[]) => void;
}) {
  const api = useApi(),
    scope = useApiScope(),
    enabled = useIntelFeatureEnabled('legiwatch_record_delivery_v1'),
    [offset, setOffset] = useState(0);
  const query = useQuery({
    queryKey: ['report-record-brief-options', scope, reportId, offset],
    enabled: enabled && !!reportId,
    retry: false,
    queryFn: async () =>
      (
        await api.get<{
          options: Array<SelectedRecordBrief & { title: string; correction: boolean }>;
          next: number | null;
        }>(
          `/intel-api/legiwatch/reports/record-brief-options?reportId=${encodeURIComponent(reportId)}&offset=${offset}`,
        )
      ).data,
  });
  if (!enabled && !value.length) return null;
  return (
    <fieldset>
      <legend>Include reviewed hearing briefs</legend>
      <p>
        Choose up to five exact versions for this report’s client and folders. A daily schedule
        includes each selected version once; a new version requires a new selection and review.
      </p>
      {query.isError ? (
        <p role="alert">
          Brief choices could not load. Saved selections remain visible and must pass current review
          checks.
        </p>
      ) : null}
      {value.map((v) => (
        <p key={v.briefId}>
          Selected v{v.version} · {v.briefId}
          <button
            type="button"
            onClick={() => onChange(value.filter((x) => x.briefId !== v.briefId))}
          >
            Remove selection
          </button>
        </p>
      ))}
      {query.data?.options.map((v) => (
        <label className="lw-reports-check" key={v.briefId}>
          <input
            type="checkbox"
            checked={value.some((x) => x.briefId === v.briefId)}
            disabled={value.length >= 5 && !value.some((x) => x.briefId === v.briefId)}
            onChange={() =>
              onChange(
                value.some((x) => x.briefId === v.briefId)
                  ? value.filter((x) => x.briefId !== v.briefId)
                  : [...value, v],
              )
            }
          />
          {v.title} · v{v.version}
          {v.correction ? ' · Correction / follow-up' : ''}
        </label>
      ))}
      {!query.data?.options.length ? (
        <p>
          No current approved versions on this page. Briefs need a matching client and at least one
          folder in this report.
        </p>
      ) : null}
      <button type="button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>
        Previous brief choices
      </button>
      <button
        type="button"
        disabled={query.data?.next == null}
        onClick={() => setOffset(query.data!.next!)}
      >
        More brief choices
      </button>
    </fieldset>
  );
}
