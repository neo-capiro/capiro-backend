import { useMemo, useState } from 'react';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { useCapiroToast } from '../components/feedback/toast.js';
import { MeriIcon } from './meri-icons.js';

/**
 * MeriAnalysisCard — chart/data/image card embedded in an assistant answer.
 * Pixel-parity port of the prototype's `hasAnalysis` block (screen C).
 *
 * BACKEND GAP: no analysis-artifact endpoint exists on vNext; the card renders
 * a client-side spec. CSV/PNG export are prototype toasts until artifact
 * download routes land. Tracked in GAPS.md (Meri vNext — analysis artifacts).
 */

const MONO = "var(--meri-font-mono, Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif)";

export interface MeriAnalysisSeries {
  label: string;
  color: string;
  format?: (value: number) => string;
}

export interface MeriAnalysisGroup {
  label: string;
  values: number[];
}

export interface MeriAnalysisColumn {
  v: string;
  align?: 'left' | 'right';
}

export interface MeriAnalysisCell {
  v: string;
  mono?: boolean;
  align?: 'left' | 'right';
}

export interface MeriAnalysisSpec {
  eyebrow: string;
  title: string;
  desc: string;
  insight?: string;
  series: MeriAnalysisSeries[];
  groups: MeriAnalysisGroup[];
  dataCols: MeriAnalysisColumn[];
  dataRows: MeriAnalysisCell[][];
  prov: string[];
  imageCaption?: string;
}

/** Prototype fixture — screen C ("Shield AI federal obligations by appropriation"). */
export const MERI_ANALYSIS_FIXTURE: MeriAnalysisSpec = {
  eyebrow: 'ANALYSIS · STACKED BAR',
  title: 'Shield AI federal obligations by appropriation',
  desc: 'Derived from award and budget data across three fiscal years.',
  insight:
    'RDT&E has grown from 61% to 78% of obligations while procurement stayed flat — a research-funded posture, not a production one.',
  series: [
    { label: 'RDT&E', color: '#101828', format: (v) => `$${v}M` },
    { label: 'PROCUREMENT', color: '#98A2B3', format: (v) => `$${v}M` },
  ],
  groups: [
    { label: 'FY24', values: [64, 41] },
    { label: 'FY25', values: [118, 44] },
    { label: 'FY26', values: [187, 52] },
  ],
  dataCols: [
    { v: 'FISCAL YEAR' },
    { v: 'RDT&E', align: 'right' },
    { v: 'PROCUREMENT', align: 'right' },
    { v: 'TOTAL', align: 'right' },
  ],
  dataRows: [
    [{ v: 'FY24' }, { v: '$64M', mono: true, align: 'right' }, { v: '$41M', mono: true, align: 'right' }, { v: '$105M', mono: true, align: 'right' }],
    [{ v: 'FY25' }, { v: '$118M', mono: true, align: 'right' }, { v: '$44M', mono: true, align: 'right' }, { v: '$162M', mono: true, align: 'right' }],
    [{ v: 'FY26' }, { v: '$187M', mono: true, align: 'right' }, { v: '$52M', mono: true, align: 'right' }, { v: '$239M', mono: true, align: 'right' }],
  ],
  prov: [
    'SOURCE DATA · FEDERAL AWARDS, PRESIDENT’S BUDGET',
    '9 ROWS',
    'GENERATED AUG 16, 10:23 AM',
    'SOURCES · SEE MERI CITATIONS',
  ],
  imageCaption: 'SAVED ANALYSIS IMAGE · PNG · GENERATED AUG 16, 9:14 AM',
};

type AnalysisView = 'chart' | 'data' | 'image';

interface MeriAnalysisCardProps {
  /** Reserved for wiring to live analysis artifacts; fixture renders when absent. */
  controller?: MeriChatController;
  spec?: MeriAnalysisSpec;
  /** Expand control — opens the artifact canvas in the host shell. */
  onExpand?: () => void;
}

export function MeriAnalysisCard({ spec = MERI_ANALYSIS_FIXTURE, onExpand }: MeriAnalysisCardProps) {
  const toast = useCapiroToast();
  const [view, setView] = useState<AnalysisView>('chart');
  const [hiddenSeries, setHiddenSeries] = useState<ReadonlySet<number>>(new Set());

  const maxValue = useMemo(
    () => spec.groups.reduce((max, group) => Math.max(max, ...group.values), 0),
    [spec.groups],
  );

  const toggleSeries = (index: number) => {
    setHiddenSeries((current) => {
      const next = new Set(current);
      if (next.has(index)) {
        next.delete(index);
        return next;
      }
      // At least one series must stay visible.
      if (next.size >= spec.series.length - 1) return current;
      next.add(index);
      return next;
    });
  };

  const views: Array<{ key: AnalysisView; label: string }> = [
    { key: 'chart', label: 'CHART' },
    { key: 'data', label: 'DATA' },
    { key: 'image', label: 'IMAGE' },
  ];

  return (
    <div
      style={{
        margin: '0 18px 16px',
        borderRadius: 10,
        background: '#ffffff',
        border: '1px solid #EAECF0',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap', padding: '14px 16px 12px' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontFamily: MONO, fontSize: 10, fontWeight: 500, letterSpacing: '.1em', color: '#667085' }}>
            {spec.eyebrow}
          </div>
          <div style={{ marginTop: 6, fontSize: 15, lineHeight: '22px', fontWeight: 600, color: '#101828' }}>
            {spec.title}
          </div>
          <div style={{ marginTop: 4, fontSize: 13, lineHeight: '19px', color: '#667085' }}>
            {spec.desc}
          </div>
        </div>
        <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          {views.map((v) => {
            const on = view === v.key;
            return (
              <button
                type="button"
                key={v.key}
                onClick={() => setView(v.key)}
                style={{
                  height: 26,
                  padding: '0 10px',
                  borderRadius: 7,
                  background: on ? '#F2F4F7' : '#ffffff',
                  border: on ? '1px solid #D0D5DD' : '1px solid #EAECF0',
                  fontFamily: MONO,
                  fontSize: 10,
                  fontWeight: 500,
                  letterSpacing: '.08em',
                  color: on ? '#101828' : '#344054',
                }}
              >
                {v.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => toast.success('CSV exported — exactly the rows shown.')}
            style={{
              height: 26,
              padding: '0 10px',
              borderRadius: 7,
              border: '1px solid #EAECF0',
              fontFamily: MONO,
              fontSize: 10,
              fontWeight: 500,
              letterSpacing: '.08em',
              color: '#344054',
            }}
          >
            CSV
          </button>
          <button
            type="button"
            onClick={() => toast.success('PNG saved to your downloads.')}
            style={{
              height: 26,
              padding: '0 10px',
              borderRadius: 7,
              border: '1px solid #EAECF0',
              fontFamily: MONO,
              fontSize: 10,
              fontWeight: 500,
              letterSpacing: '.08em',
              color: '#344054',
            }}
          >
            PNG
          </button>
          <button
            type="button"
            title="Expand"
            aria-label="Expand analysis in the artifact canvas"
            onClick={() => onExpand?.()}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              borderRadius: 7,
              border: '1px solid #EAECF0',
              color: '#344054',
            }}
          >
            <MeriIcon name="Expand01" size={13} />
          </button>
        </div>
      </div>

      {spec.insight ? (
        <div style={{ margin: '0 16px', padding: '11px 13px', borderRadius: 8, background: '#F2F4F7' }}>
          <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 500, letterSpacing: '.09em', color: '#101828' }}>
            INSIGHT ·{' '}
          </span>
          <span style={{ fontSize: 13, lineHeight: '20px', color: '#344054' }}>{spec.insight}</span>
        </div>
      ) : null}

      {view === 'chart' ? (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '12px 16px 0' }}>
            {spec.series.map((series, index) => {
              const hidden = hiddenSeries.has(index);
              return (
                <button
                  type="button"
                  key={series.label}
                  onClick={() => toggleSeries(index)}
                  aria-pressed={!hidden}
                  title={hidden ? `Show ${series.label}` : `Hide ${series.label}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 7,
                    height: 26,
                    padding: '0 10px',
                    borderRadius: 7,
                    background: hidden ? '#F9FAFB' : '#ffffff',
                    border: '1px solid #EAECF0',
                  }}
                >
                  <span
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: 2,
                      background: hidden ? '#D0D5DD' : series.color,
                    }}
                  />
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 10,
                      fontWeight: 500,
                      letterSpacing: '.07em',
                      color: hidden ? '#98A2B3' : '#344054',
                    }}
                  >
                    {series.label}
                  </span>
                </button>
              );
            })}
          </div>
          <div style={{ padding: '16px 16px 0' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: 20,
                height: 206,
                paddingBottom: 10,
                borderBottom: '1px solid #D0D5DD',
              }}
            >
              {spec.groups.map((group) => (
                <div
                  key={group.label}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 7,
                    height: '100%',
                    justifyContent: 'flex-end',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-end',
                      gap: 7,
                      width: '100%',
                      height: '100%',
                      justifyContent: 'center',
                    }}
                  >
                    {group.values.map((value, seriesIndex) => {
                      if (hiddenSeries.has(seriesIndex)) return null;
                      const series = spec.series[seriesIndex];
                      if (!series) return null;
                      const heightPct = maxValue > 0 ? (value / maxValue) * 100 : 0;
                      return (
                        <div
                          key={series.label}
                          style={{
                            flex: 1,
                            maxWidth: 44,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'flex-end',
                            height: '100%',
                            gap: 5,
                          }}
                        >
                          <span
                            style={{
                              fontFamily: MONO,
                              fontSize: 9,
                              fontWeight: 500,
                              color: '#667085',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {series.format ? series.format(value) : String(value)}
                          </span>
                          <span
                            style={{
                              width: '100%',
                              height: `${heightPct}%`,
                              borderRadius: '3px 3px 0 0',
                              background: series.color,
                            }}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 20, paddingTop: 9 }}>
              {spec.groups.map((group) => (
                <div
                  key={group.label}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    textAlign: 'center',
                    fontFamily: MONO,
                    fontSize: 10,
                    letterSpacing: '.03em',
                    color: '#667085',
                  }}
                >
                  {group.label}
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}

      {view === 'data' ? (
        <div style={{ padding: '12px 16px 0' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {spec.dataCols.map((col, i) => (
                  <th
                    key={`${col.v}-${i}`}
                    style={{
                      padding: '8px 10px',
                      borderBottom: '1px solid #EAECF0',
                      textAlign: col.align ?? 'left',
                      fontFamily: MONO,
                      fontSize: 10,
                      fontWeight: 500,
                      letterSpacing: '.08em',
                      color: '#667085',
                    }}
                  >
                    {col.v}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {spec.dataRows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      style={{
                        padding: '9px 10px',
                        borderBottom: '1px solid #F2F4F7',
                        textAlign: cell.align ?? 'left',
                        fontFamily: cell.mono ? MONO : 'inherit',
                        fontSize: 13,
                        color: '#344054',
                      }}
                    >
                      {cell.v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {view === 'image' ? (
        <div style={{ margin: '12px 16px 0', padding: 20, borderRadius: 9, background: '#F9FAFB', border: '1px solid #EAECF0' }}>
          <div
            style={{
              height: 170,
              borderRadius: 7,
              background: 'repeating-linear-gradient(135deg,#EAECF0 0 8px,#F2F4F7 8px 16px)',
            }}
          />
          <div
            style={{
              marginTop: 11,
              fontFamily: MONO,
              fontSize: 9.5,
              fontWeight: 500,
              letterSpacing: '.08em',
              color: '#667085',
            }}
          >
            {spec.imageCaption ?? 'SAVED ANALYSIS IMAGE · PNG'}
          </div>
        </div>
      ) : null}

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '8px 14px',
          marginTop: 14,
          padding: '11px 16px',
          borderTop: '1px solid #EAECF0',
          background: '#F9FAFB',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <MeriIcon name="Diamond01" size={10} color="#101828" />
          <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 500, letterSpacing: '.08em', color: '#101828' }}>
            DERIVED
          </span>
        </span>
        {spec.prov.map((fact) => (
          <span
            key={fact}
            style={{ fontFamily: MONO, fontSize: 9, fontWeight: 500, letterSpacing: '.08em', color: '#667085' }}
          >
            {fact}
          </span>
        ))}
      </div>
    </div>
  );
}
