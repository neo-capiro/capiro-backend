import { Card, Descriptions, Tag, Tooltip } from 'antd';
import { formatPdocSourceLine } from './trust-model.js';

/**
 * P-40 exhibit detail block (product plan F1 enrichment block): quantities,
 * unit cost, MDAP code, related PEs, ID code, and the validated LLM acquisition
 * layer (strategy, program office, contractors, milestones, risks) — from
 * raw.pDocDetail, written by load-pdoc-enrichment (batch-5). Renders nothing
 * until the line has been enriched, so it lights up automatically as loads land.
 *
 * Phase 5: source FY is derived from exhibit metadata (not hard-coded FY2027);
 * related PE codes are keyboard-accessible buttons.
 */

export interface PdocLlmDetail {
  acquisitionStrategy?: string | null;
  programOffice?: string | null;
  contractors?: string[] | null;
  milestones?: string[] | null;
  risks?: string[] | null;
  summary?: string | null;
}

export interface PdocDetail {
  appropriation?: string | null;
  lineItem?: string | null;
  budgetActivity?: string | null;
  idCode?: string | null;
  relatedPEs?: string | null;
  mdapCode?: string | null;
  procurementQty?: string[] | null;
  netProcurementM?: string[] | null;
  unitCostK?: string[] | null;
  unitCostM?: string[] | null;
  sourceBook?: string | null;
  llm?: PdocLlmDetail | null;
}

function last<T>(xs: T[] | null | undefined): T | undefined {
  return xs && xs.length > 0 ? xs[xs.length - 1] : undefined;
}

export function PdocDetailPanel({
  detail,
  onOpenPe,
}: {
  detail: PdocDetail | null | undefined;
  onOpenPe?: (peCode: string) => void;
}) {
  if (!detail) return null;
  const relateds = (detail.relatedPEs ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^[0-9]{7}[A-Z]/.test(s));
  const qtyTotal = last(detail.procurementQty);
  const netTotal = last(detail.netProcurementM);
  const unitCost = last(detail.unitCostK) ?? last(detail.unitCostM);
  const unitCostUnit = detail.unitCostK?.length ? '$K' : detail.unitCostM?.length ? '$M' : null;
  const llm = detail.llm;
  const contractors = (llm?.contractors ?? []).filter(Boolean);
  const milestones = (llm?.milestones ?? []).filter(Boolean);
  const risks = (llm?.risks ?? []).filter(Boolean);
  const hasLlm =
    !!llm?.acquisitionStrategy || !!llm?.programOffice || contractors.length > 0 || milestones.length > 0 || risks.length > 0;
  const hasAnything =
    qtyTotal || netTotal || unitCost || relateds.length > 0 || detail.mdapCode || detail.idCode || hasLlm;
  if (!hasAnything) return null;

  return (
    <Card title="P-40 exhibit detail" className="pe-pdoc-detail" data-testid="pe-pdoc-detail">
      <Descriptions column={{ xs: 1, sm: 2, xl: 3 }} size="small">
        {qtyTotal ? (
          <Descriptions.Item label="Total quantity">{qtyTotal}</Descriptions.Item>
        ) : null}
        {netTotal ? (
          <Descriptions.Item label="Net procurement (total, $M)">{netTotal}</Descriptions.Item>
        ) : null}
        {unitCost ? (
          <Descriptions.Item label={`Unit cost (${unitCostUnit})`}>{unitCost}</Descriptions.Item>
        ) : null}
        {detail.mdapCode ? (
          <Descriptions.Item label="MDAP/MAIS code">{detail.mdapCode}</Descriptions.Item>
        ) : null}
        {detail.idCode ? (
          <Descriptions.Item label="ID code">
            {detail.idCode === 'A' ? 'A — service ready' : `${detail.idCode} — not service ready`}
          </Descriptions.Item>
        ) : null}
        {relateds.length > 0 ? (
                  <Descriptions.Item label="Related RDT&E PEs">
                    {relateds.map((pe, i) => (
                      <span key={pe}>
                        {i > 0 ? ', ' : ''}
                        <button
                          type="button"
                          className="pe-related-pe-link"
                          data-testid={`pe-pdoc-related-${pe}`}
                          onClick={() => onOpenPe?.(pe)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onOpenPe?.(pe);
                            }
                          }}
                        >
                          {pe}
                        </button>
                      </span>
                    ))}
                  </Descriptions.Item>
                ) : null}
                {detail.lineItem ? (
                  <Descriptions.Item label="P-40 line item">{detail.lineItem}</Descriptions.Item>
                ) : null}
                {detail.appropriation ? (
                  <Descriptions.Item label="P-40 appropriation">{detail.appropriation}</Descriptions.Item>
                ) : null}
      </Descriptions>
      {hasLlm ? (
        <div className="pe-pdoc-llm">
          {llm?.acquisitionStrategy ? (
            <div className="pe-pdoc-llm-row">
              <span className="pe-pdoc-llm-label">Acquisition strategy</span>
              <span>{llm.acquisitionStrategy}</span>
            </div>
          ) : null}
          {llm?.programOffice ? (
            <div className="pe-pdoc-llm-row">
              <span className="pe-pdoc-llm-label">Program office</span>
              <span>{llm.programOffice}</span>
            </div>
          ) : null}
          {contractors.length > 0 ? (
            <div className="pe-pdoc-llm-row">
              <span className="pe-pdoc-llm-label">Named contractors</span>
              <span>
                {contractors.map((c) => (
                  <Tag key={c}>{c}</Tag>
                ))}
              </span>
            </div>
          ) : null}
          {milestones.length > 0 ? (
            <div className="pe-pdoc-llm-row">
              <span className="pe-pdoc-llm-label">Milestones</span>
              <ul className="pe-pdoc-llm-list">
                {milestones.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {risks.length > 0 ? (
            <div className="pe-pdoc-llm-row">
              <span className="pe-pdoc-llm-label">Risks</span>
              <ul className="pe-pdoc-llm-list">
                {risks.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <Tooltip title="Every value in this section was independently re-validated as a verbatim substring of the line's own P-40 narrative before load — nothing here was inferred beyond what the source document states.">
            <div className="pe-pdoc-llm-note">Extracted &amp; verbatim-validated from the source narrative</div>
          </Tooltip>
        </div>
      ) : null}
      {detail.sourceBook ? (
              <div className="pe-pdoc-source" data-testid="pe-pdoc-source">
                {formatPdocSourceLine(detail.sourceBook)}
              </div>
            ) : (
              <div className="pe-pdoc-source" data-testid="pe-pdoc-source">
                Source: P-40 exhibit (source book / FY not recorded on enrichment payload)
              </div>
            )}
    </Card>
  );
}
