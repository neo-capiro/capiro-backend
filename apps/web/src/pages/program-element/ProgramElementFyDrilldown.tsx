import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import { useApi } from '../../lib/use-api.js';
import { getProgramElementDetail } from './api.js';
import { FyDetailDrawer } from './FyDetailDrawer.js';

function readFy(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function ProgramElementFyDrilldown() {
  const { peCode = '' } = useParams<{ peCode: string }>();
  const code = peCode.toUpperCase();
  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlFy = readFy(searchParams.get('fy'));
  const [selectedFy, setSelectedFy] = useState<number | null>(urlFy);
  const [open, setOpen] = useState(urlFy != null);
  const detailQuery = useQuery({
    queryKey: ['program-element-detail', code],
    queryFn: () => getProgramElementDetail(api, code),
    enabled: code.length > 0,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (urlFy == null) return;
    setSelectedFy(urlFy);
    setOpen(true);
  }, [urlFy]);

  if (searchParams.get('tab') !== 'funding' || !detailQuery.data?.years?.length) {
    return null;
  }

  const selectFy = (fy: number) => {
    setSelectedFy(fy);
    setOpen(true);
    const params = new URLSearchParams(searchParams);
    params.set('fy', String(fy));
    setSearchParams(params, { replace: true });
  };
  const close = () => {
    setOpen(false);
    const params = new URLSearchParams(searchParams);
    params.delete('fy');
    setSearchParams(params, { replace: true });
  };

  return (
    <div className="pe-final" style={{ maxWidth: 1240, marginTop: 12 }}>
      <section className="pe-final-panel">
        <div className="pe-final-panel-head">
          <h2>Fiscal-year detail</h2>
          <small>Existing source and linked-record drill-down</small>
        </div>
        <div className="pe-final-panel-body">
          <div className="pe-final-facets" style={{ marginTop: 0 }}>
            {detailQuery.data.years
              .slice()
              .sort((left, right) => right.fy - left.fy)
              .map((year) => (
                <button
                  className={`pe-final-facet${selectedFy === year.fy ? ' active' : ''}`}
                  key={year.fy}
                  type="button"
                  onClick={() => selectFy(year.fy)}
                >
                  FY{year.fy}
                </button>
              ))}
          </div>
        </div>
      </section>
      <FyDetailDrawer
        open={open}
        onClose={close}
        peCode={code}
        selectedFy={selectedFy}
        timeline={detailQuery.data.years}
      />
    </div>
  );
}
