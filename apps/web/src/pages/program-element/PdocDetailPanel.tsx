import { Card, Descriptions } from 'antd';

/**
 * P-40 exhibit detail block (product plan F1 enrichment block): quantities,
 * unit cost, MDAP code, related PEs, ID code — from raw.pDocDetail, written by
 * load-pdoc-enrichment (batch-5). Renders nothing until the line has been
 * enriched, so it lights up automatically as loads land.
 */

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
  const hasAnything =
    qtyTotal || netTotal || unitCost || relateds.length > 0 || detail.mdapCode || detail.idCode;
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
                <a onClick={() => onOpenPe?.(pe)}>{pe}</a>
              </span>
            ))}
          </Descriptions.Item>
        ) : null}
      </Descriptions>
      {detail.sourceBook ? (
        <div className="pe-pdoc-source">Source: FY2027 {detail.sourceBook.replace(/_/g, ' ')} P-40 exhibit</div>
      ) : null}
    </Card>
  );
}
