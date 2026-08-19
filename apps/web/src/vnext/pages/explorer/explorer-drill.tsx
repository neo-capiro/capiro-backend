/**
 * Data Explorer vNext — drill-in drawer + per-source detail views.
 *
 * Endpoints, query keys and copy are identical to the canonical
 * DataExplorerPage drill-ins; the chrome is CapiroDrawer + vNext drill atoms.
 * Congress-bill and state-bill details delegate to the shared detail bodies
 * (one fetch hook, one cache entry per bill across surfaces).
 */
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import type {
  ContractorDetail,
  CrsDetail,
  FaraDetail,
  FecDetail,
  FedRegDetail,
  GaoDetail,
  HearingDetail,
  IntelArticleDetail,
  LdaFilingDetail,
  SecDetail,
} from '../../../pages/explorer/explorerTypes.js';
import { CapiroDrawer } from '../../components/overlays/index.js';
import { SOURCES, type SourceKey } from './explorer-meta.js';
import { formatDate, formatMoney } from './explorer-format.js';
import { ChipList, MonoTag, XpEmpty, XpSkeletonRows } from './explorer-table.js';
import { DrillKV, DrillSection } from './explorer-drill-bits.js';
import { BillDetailBodyVNext } from './bill-detail-vnext.js';
import { StateBillDetailBodyVNext } from './state-bill-detail-vnext.js';

export type DrillIn = { source: SourceKey; id: string; rowSummary: string } | null;

export function ExplorerDrillInDrawer({
  drillIn,
  onClose,
}: {
  drillIn: DrillIn;
  onClose: () => void;
}) {
  const sourceLabel = drillIn ? (SOURCES.find((s) => s.key === drillIn.source)?.label ?? '') : '';
  return (
    <CapiroDrawer
      open={drillIn !== null}
      onClose={onClose}
      title={drillIn ? `${sourceLabel} · ${drillIn.rowSummary}` : ''}
    >
      {drillIn ? <DrillInContent drillIn={drillIn} /> : null}
    </CapiroDrawer>
  );
}

export function DrillInContent({ drillIn }: { drillIn: NonNullable<DrillIn> }) {
  if (drillIn.source === 'lda') return <LdaFilingDetailView id={drillIn.id} />;
  if (drillIn.source === 'bills') return <BillDetailBodyVNext id={drillIn.id} />;
  if (drillIn.source === 'contractors') return <ContractorDetailView id={drillIn.id} />;
  if (drillIn.source === 'fedreg' || drillIn.source === 'comment-deadlines')
    return <FedRegDetailView id={drillIn.id} />;
  if (drillIn.source === 'hearings') return <HearingDetailView id={drillIn.id} />;
  if (drillIn.source === 'gao') return <GaoDetailView id={drillIn.id} />;
  if (drillIn.source === 'crs') return <CrsDetailView id={drillIn.id} />;
  if (drillIn.source === 'fec') return <FecDetailView id={drillIn.id} />;
  if (drillIn.source === 'fara') return <FaraDetailView id={drillIn.id} />;
  if (drillIn.source === 'sec') return <SecDetailView id={drillIn.id} />;
  if (drillIn.source === 'articles') return <IntelArticleDetailView id={drillIn.id} />;
  if (drillIn.source === 'state-bills') return <StateBillDetailBodyVNext id={drillIn.id} />;
  return <div className="xp-drill-unwired">Detailed view for this source isn't wired yet.</div>;
}

function LdaFilingDetailView({ id }: { id: string }) {
  const api = useApi();
  const query = useQuery<LdaFilingDetail | null>({
    queryKey: ['explorer-lda-detail', id],
    queryFn: async () => (await api.get<LdaFilingDetail>(`/api/explorer/lda-filings/${id}`)).data,
  });
  if (query.isLoading) return <XpSkeletonRows rows={8} />;
  if (!query.data) return <XpEmpty description="Filing not found." />;
  const { filing, registrantRecent, clientRecent, issueCodes } = query.data;
  return (
    <div className="xp-drill-content">
      <DrillSection title="Filing">
        <DrillKV label="Filing UUID" value={<span className="xp-num">{filing.filingUuid}</span>} />
        <DrillKV label="Type" value={filing.filingType} />
        <DrillKV label="Year / period" value={`${filing.filingYear}${filing.filingPeriod ? ` · ${filing.filingPeriod}` : ''}`} />
        <DrillKV label="Posted" value={filing.dtPosted ? formatDate(filing.dtPosted) : '-'} />
        <DrillKV label="Income" value={<span className="xp-num">{formatMoney(filing.income)}</span>} />
        <DrillKV label="Expenses" value={<span className="xp-num">{formatMoney(filing.expenses ?? null)}</span>} />
        <DrillKV label="Registrant" value={filing.registrantName} />
        <DrillKV label="Client" value={`${filing.clientName}${filing.clientState ? ` (${filing.clientState})` : ''}`} />
      </DrillSection>

      {issueCodes.length ? (
        <DrillSection title="Issue codes">
          <ul className="xp-drill-list">
            {issueCodes.map((c) => (
              <li key={c.code}>
                <MonoTag>{c.code}</MonoTag>
                <span>{c.name}</span>
              </li>
            ))}
          </ul>
        </DrillSection>
      ) : null}

      {registrantRecent.length ? (
        <DrillSection title={`Other recent filings by ${filing.registrantName}`}>
          <ul className="xp-drill-list">
            {registrantRecent.map((r) => (
              <li key={r.id}>
                <span className="xp-num">{r.filingYear}{r.filingPeriod ? ` · ${r.filingPeriod}` : ''}</span>
                <span>{r.clientName}</span>
                <span className="xp-num xp-drill-amount">{formatMoney(r.income)}</span>
              </li>
            ))}
          </ul>
        </DrillSection>
      ) : null}

      {clientRecent.length ? (
        <DrillSection title={`Other lobbying for ${filing.clientName}`}>
          <ul className="xp-drill-list">
            {clientRecent.map((r) => (
              <li key={r.id}>
                <span className="xp-num">{r.filingYear}{r.filingPeriod ? ` · ${r.filingPeriod}` : ''}</span>
                <span>{r.registrantName}</span>
                <span className="xp-num xp-drill-amount">{formatMoney(r.income)}</span>
              </li>
            ))}
          </ul>
        </DrillSection>
      ) : null}
    </div>
  );
}

function ContractorDetailView({ id }: { id: string }) {
  const api = useApi();
  const query = useQuery<ContractorDetail | null>({
    queryKey: ['explorer-contractor-detail', id],
    queryFn: async () => (await api.get<ContractorDetail>(`/api/explorer/federal-contractors/${id}`)).data,
  });
  if (query.isLoading) return <XpSkeletonRows rows={8} />;
  if (!query.data) return <XpEmpty description="Contractor not found." />;
  const { contractor } = query.data;
  return (
    <div className="xp-drill-content">
      <DrillSection title="Contractor">
        <DrillKV label="Name" value={contractor.name} />
        <DrillKV label="UEI" value={contractor.uei ? <span className="xp-num xp-mono">{contractor.uei}</span> : '-'} />
        <DrillKV label="Category" value={contractor.category ?? '-'} />
        <DrillKV label="Rank" value={contractor.rankByContracts ? `#${contractor.rankByContracts}` : '-'} />
        <DrillKV label="Total contracts" value={<span className="xp-num">{formatMoney(contractor.totalContracts)}</span>} />
        <DrillKV
          label="No-bid total"
          value={
            <span className={`xp-num ${contractor.noBidTotal && contractor.noBidTotal > 0 ? 'xp-danger' : 'xp-muted'}`}>
              {formatMoney(contractor.noBidTotal)}
            </span>
          }
        />
      </DrillSection>

      {contractor.topAgencies?.length ? (
        <DrillSection title="Top agencies">
          <ul className="xp-drill-list">
            {contractor.topAgencies.slice(0, 10).map((a, i) => (
              <li key={i}>
                <span>{a.name}</span>
                <span className="xp-num xp-drill-amount">{formatMoney(a.amount)}</span>
              </li>
            ))}
          </ul>
        </DrillSection>
      ) : null}

      {contractor.yearlySpend?.length ? (
        <DrillSection title="Yearly spend">
          <ul className="xp-drill-list">
            {contractor.yearlySpend.slice(0, 8).map((y) => (
              <li key={y.year}>
                <span className="xp-num">{y.year}</span>
                <span className="xp-num xp-drill-amount">{formatMoney(y.amount)}</span>
              </li>
            ))}
          </ul>
        </DrillSection>
      ) : null}
    </div>
  );
}

function FedRegDetailView({ id }: { id: string }) {
  const api = useApi();
  const query = useQuery<FedRegDetail | null>({
    queryKey: ['explorer-fed-reg-detail', id],
    queryFn: async () => (await api.get<FedRegDetail>(`/api/explorer/federal-register/${id}`)).data,
  });
  if (query.isLoading) return <XpSkeletonRows rows={8} />;
  if (!query.data) return <XpEmpty description="Document not found." />;
  const { document } = query.data;
  return (
    <div className="xp-drill-content">
      <DrillSection title="Document">
        <DrillKV label="Title" value={document.title} />
        <DrillKV label="Type" value={document.type.replace(/_/g, ' ')} />
        <DrillKV label="Doc #" value={<span className="xp-num">{document.documentNumber}</span>} />
        <DrillKV label="Agency" value={document.agencyNames.join(' / ')} />
        <DrillKV label="Published" value={formatDate(document.publicationDate)} />
        <DrillKV label="Comment closes" value={document.commentEndDate ? formatDate(document.commentEndDate) : '-'} />
        <DrillKV label="Effective" value={document.effectiveDate ? formatDate(document.effectiveDate) : '-'} />
        <DrillKV label="Significant rule" value={document.significantRule ? 'Yes' : 'No'} />
        {document.htmlUrl ? <DrillKV label="Federal Register" value={<a href={document.htmlUrl} target="_blank" rel="noreferrer">View on FederalRegister.gov →</a>} /> : null}
      </DrillSection>

      {document.abstract ? (
        <DrillSection title="Abstract">
          <p className="xp-drill-para">{document.abstract}</p>
        </DrillSection>
      ) : null}

      {document.topics?.length ? (
        <DrillSection title="Topics">
          <ChipList items={document.topics} max={20} />
        </DrillSection>
      ) : null}
    </div>
  );
}

function HearingDetailView({ id }: { id: string }) {
  const api = useApi();
  const query = useQuery<HearingDetail | null>({
    queryKey: ['explorer-hearing-detail', id],
    queryFn: async () => (await api.get<HearingDetail>(`/api/explorer/hearings/${id}`)).data,
  });
  if (query.isLoading) return <XpSkeletonRows rows={8} />;
  if (!query.data) return <XpEmpty description="Hearing not found." />;
  const { hearing } = query.data;
  return (
    <div className="xp-drill-content">
      <DrillSection title="Hearing">
        <DrillKV label="Title" value={hearing.title} />
        <DrillKV label="Chamber" value={hearing.chamber} />
        <DrillKV label="Committee" value={hearing.committeeName} />
        {hearing.committeeCode ? <DrillKV label="Code" value={<span className="xp-num">{hearing.committeeCode}</span>} /> : null}
        <DrillKV label="Date" value={formatDate(hearing.date)} />
        {hearing.time ? <DrillKV label="Time" value={hearing.time} /> : null}
        {hearing.location ? <DrillKV label="Location" value={hearing.location} /> : null}
        {hearing.type ? <DrillKV label="Type" value={hearing.type} /> : null}
        {hearing.url ? <DrillKV label="Source" value={<a href={hearing.url} target="_blank" rel="noreferrer">Open hearing page →</a>} /> : null}
      </DrillSection>
      {hearing.witnesses?.length ? (
        <DrillSection title={`Witnesses (${hearing.witnesses.length})`}>
          <ul className="xp-drill-list">
            {hearing.witnesses.map((w, i) => (
              <li key={i}><span>{w}</span></li>
            ))}
          </ul>
        </DrillSection>
      ) : null}
    </div>
  );
}

function GaoDetailView({ id }: { id: string }) {
  const api = useApi();
  const query = useQuery<GaoDetail | null>({
    queryKey: ['explorer-gao-detail', id],
    queryFn: async () => (await api.get<GaoDetail>(`/api/explorer/gao/${id}`)).data,
  });
  if (query.isLoading) return <XpSkeletonRows rows={8} />;
  if (!query.data) return <XpEmpty description="GAO report not found." />;
  const { report } = query.data;
  return (
    <div className="xp-drill-content">
      <DrillSection title="Report">
        <DrillKV label="Title" value={report.title} />
        <DrillKV label="ID" value={<span className="xp-num">{report.id}</span>} />
        {report.reportType ? <DrillKV label="Type" value={report.reportType} /> : null}
        {report.publishDate ? <DrillKV label="Published" value={formatDate(report.publishDate)} /> : null}
        {report.recommendations != null ? <DrillKV label="Recommendations" value={<span className="xp-num">{report.recommendations}</span>} /> : null}
        {report.url ? <DrillKV label="Source" value={<a href={report.url} target="_blank" rel="noreferrer">Open on gao.gov →</a>} /> : null}
      </DrillSection>
      {report.summary ? (
        <DrillSection title="Summary">
          <p className="xp-drill-para">{report.summary}</p>
        </DrillSection>
      ) : null}
      {report.topics?.length ? <DrillSection title="Topics"><ChipList items={report.topics} max={20} /></DrillSection> : null}
      {report.agencies?.length ? <DrillSection title="Agencies"><ChipList items={report.agencies} max={20} /></DrillSection> : null}
    </div>
  );
}

function CrsDetailView({ id }: { id: string }) {
  const api = useApi();
  const query = useQuery<CrsDetail | null>({
    queryKey: ['explorer-crs-detail', id],
    queryFn: async () => (await api.get<CrsDetail>(`/api/explorer/crs/${id}`)).data,
  });
  if (query.isLoading) return <XpSkeletonRows rows={8} />;
  if (!query.data) return <XpEmpty description="CRS report not found." />;
  const { report } = query.data;
  return (
    <div className="xp-drill-content">
      <DrillSection title="Report">
        <DrillKV label="Title" value={report.title} />
        <DrillKV label="ID" value={<span className="xp-num">{report.id}</span>} />
        {report.date ? <DrillKV label="Date" value={formatDate(report.date)} /> : null}
        <DrillKV label="Active" value={report.active ? 'Yes' : 'Archived'} />
        {report.htmlUrl ? <DrillKV label="HTML" value={<a href={report.htmlUrl} target="_blank" rel="noreferrer">Open HTML →</a>} /> : null}
        {report.pdfUrl ? <DrillKV label="PDF" value={<a href={report.pdfUrl} target="_blank" rel="noreferrer">Open PDF →</a>} /> : null}
      </DrillSection>
      {report.summary ? <DrillSection title="Summary"><p className="xp-drill-para">{report.summary}</p></DrillSection> : null}
      {report.authors?.length ? <DrillSection title="Authors"><ChipList items={report.authors} max={10} /></DrillSection> : null}
      {report.topics?.length ? <DrillSection title="Topics"><ChipList items={report.topics} max={20} /></DrillSection> : null}
    </div>
  );
}

function FecDetailView({ id }: { id: string }) {
  const api = useApi();
  const query = useQuery<FecDetail | null>({
    queryKey: ['explorer-fec-detail', id],
    queryFn: async () => (await api.get<FecDetail>(`/api/explorer/fec-contributions/${id}`)).data,
  });
  if (query.isLoading) return <XpSkeletonRows rows={8} />;
  if (!query.data) return <XpEmpty description="Contribution not found." />;
  const { contribution: c } = query.data;
  return (
    <div className="xp-drill-content">
      <DrillSection title="Contribution">
        <DrillKV label="Amount" value={<span className="xp-num xp-drill-amount">{formatMoney(c.amount)}</span>} />
        {c.contributionDate ? <DrillKV label="Date" value={formatDate(c.contributionDate)} /> : null}
        {c.cycle ? <DrillKV label="Cycle" value={<span className="xp-num">{c.cycle}</span>} /> : null}
        {c.receiptType ? <DrillKV label="Type" value={c.receiptType} /> : null}
        {c.state ? <DrillKV label="State" value={c.state} /> : null}
        {c.transactionId ? <DrillKV label="Tx ID" value={<span className="xp-num">{c.transactionId}</span>} /> : null}
      </DrillSection>
      <DrillSection title="Contributor">
        {c.contributorName ? <DrillKV label="Name" value={c.contributorName} /> : null}
        {c.contributorEmployer ? <DrillKV label="Employer" value={c.contributorEmployer} /> : null}
        {c.contributorOccupation ? <DrillKV label="Occupation" value={c.contributorOccupation} /> : null}
      </DrillSection>
      <DrillSection title="Recipient">
        {c.committeeName ? <DrillKV label="Committee" value={c.committeeName} /> : null}
        <DrillKV label="Committee ID" value={<span className="xp-num">{c.committeeId}</span>} />
        {c.candidateName ? <DrillKV label="Candidate" value={c.candidateName} /> : null}
        {c.candidateId ? <DrillKV label="Candidate ID" value={<span className="xp-num">{c.candidateId}</span>} /> : null}
      </DrillSection>
      {c.memoText ? <DrillSection title="Memo"><p className="xp-drill-para xp-drill-para--sm">{c.memoText}</p></DrillSection> : null}
    </div>
  );
}

function FaraDetailView({ id }: { id: string }) {
  const api = useApi();
  const query = useQuery<FaraDetail | null>({
    queryKey: ['explorer-fara-detail', id],
    queryFn: async () => (await api.get<FaraDetail>(`/api/explorer/fara/${id}`)).data,
  });
  if (query.isLoading) return <XpSkeletonRows rows={8} />;
  if (!query.data) return <XpEmpty description="FARA registration not found." />;
  const { registration: r } = query.data;
  return (
    <div className="xp-drill-content">
      <DrillSection title="Registration">
        <DrillKV label="Registrant" value={r.registrantName} />
        <DrillKV label="Reg. #" value={<span className="xp-num">{r.registrationNumber}</span>} />
        {r.status ? <DrillKV label="Status" value={r.status} /> : null}
        {r.registrationDate ? <DrillKV label="Registered" value={formatDate(r.registrationDate)} /> : null}
        {r.terminationDate ? <DrillKV label="Terminated" value={formatDate(r.terminationDate)} /> : null}
        {r.state ? <DrillKV label="State" value={r.state} /> : null}
      </DrillSection>
      <DrillSection title="Foreign Principal">
        <DrillKV label="Principal" value={r.foreignPrincipal} />
        {r.country ? <DrillKV label="Country" value={r.country} /> : null}
      </DrillSection>
      {r.description ? <DrillSection title="Description"><p className="xp-drill-para xp-drill-para--sm">{r.description}</p></DrillSection> : null}
      {r.services ? <DrillSection title="Services"><p className="xp-drill-para xp-drill-para--sm">{r.services}</p></DrillSection> : null}
    </div>
  );
}

function SecDetailView({ id }: { id: string }) {
  const api = useApi();
  const query = useQuery<SecDetail | null>({
    queryKey: ['explorer-sec-detail', id],
    queryFn: async () => (await api.get<SecDetail>(`/api/explorer/sec/${id}`)).data,
  });
  if (query.isLoading) return <XpSkeletonRows rows={8} />;
  if (!query.data) return <XpEmpty description="Filing not found." />;
  const { filing: f } = query.data;
  return (
    <div className="xp-drill-content">
      <DrillSection title="Filing">
        <DrillKV label="Company" value={f.companyName} />
        <DrillKV label="CIK" value={<span className="xp-num">{f.cik}</span>} />
        <DrillKV label="Form" value={<MonoTag>{f.formType}</MonoTag>} />
        <DrillKV label="Accession #" value={<span className="xp-num">{f.accessionNumber}</span>} />
        <DrillKV label="Filed" value={formatDate(f.filingDate)} />
        {f.reportDate ? <DrillKV label="Reporting period" value={formatDate(f.reportDate)} /> : null}
        {f.sic ? <DrillKV label="SIC" value={<span className="xp-num">{f.sic}</span>} /> : null}
        {f.stateOfIncorp ? <DrillKV label="State of incorporation" value={f.stateOfIncorp} /> : null}
        {f.fiscalYearEnd ? <DrillKV label="Fiscal year end" value={<span className="xp-num">{f.fiscalYearEnd}</span>} /> : null}
        {f.url ? <DrillKV label="EDGAR" value={<a href={f.url} target="_blank" rel="noreferrer">Open on SEC.gov →</a>} /> : null}
        {f.primaryDoc ? <DrillKV label="Primary doc" value={<span className="xp-num">{f.primaryDoc}</span>} /> : null}
      </DrillSection>
      {f.description ? <DrillSection title="Description"><p className="xp-drill-para xp-drill-para--sm">{f.description}</p></DrillSection> : null}
    </div>
  );
}

function IntelArticleDetailView({ id }: { id: string }) {
  const api = useApi();
  const query = useQuery<IntelArticleDetail | null>({
    queryKey: ['explorer-article-detail', id],
    queryFn: async () => (await api.get<IntelArticleDetail>(`/api/explorer/intel-articles/${id}`)).data,
  });
  if (query.isLoading) return <XpSkeletonRows rows={8} />;
  if (!query.data) return <XpEmpty description="Article not found." />;
  const { article: a } = query.data;
  return (
    <div className="xp-drill-content">
      <DrillSection title="Article">
        <DrillKV label="Title" value={a.title} />
        <DrillKV label="Source" value={<MonoTag>{a.source}</MonoTag>} />
        {a.author ? <DrillKV label="Author" value={a.author} /> : null}
        <DrillKV label="Published" value={formatDate(a.publishedAt)} />
        <DrillKV label="Link" value={<a href={a.url} target="_blank" rel="noreferrer">Open article →</a>} />
        {a.feedUrl ? <DrillKV label="Feed" value={<a href={a.feedUrl} target="_blank" rel="noreferrer">{a.feedUrl}</a>} /> : null}
      </DrillSection>
      {a.summary ? <DrillSection title="Summary"><p className="xp-drill-para">{a.summary}</p></DrillSection> : null}
      {a.content ? <DrillSection title="Excerpt"><p className="xp-drill-para xp-drill-para--sm">{a.content}</p></DrillSection> : null}
      {a.topics?.length ? <DrillSection title="Topics"><ChipList items={a.topics} max={20} /></DrillSection> : null}
      {a.agencies?.length ? <DrillSection title="Agencies"><ChipList items={a.agencies} max={20} /></DrillSection> : null}
    </div>
  );
}
