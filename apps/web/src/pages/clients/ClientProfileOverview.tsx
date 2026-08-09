import type { ReactNode } from 'react';
import { ArrowLeftOutlined, DeleteOutlined, EditOutlined, LinkOutlined, MailOutlined, MessageOutlined, MoreOutlined, PhoneOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Dropdown, Upload } from 'antd';
import { SECTOR_LABELS, SUBMISSION_TRACK_LABELS, normalizeSector, type SectorTag, type SubmissionTrack } from '@capiro/shared';
import type { Client } from './clientTypes.js';
import {
  buildAttentionItems,
  errorMessage,
  formatActivityDate,
  formatMonthYear,
  formatOptionalDate,
  kbTotal,
  readText,
  toRecord,
  type ActivityItem,
  type CrmTab,
  type IntelligenceView,
  type KbStatusResponse,
} from './client-profile-crm-model.js';

export function AccountHeader({
  client,
  canManage,
  canRemove,
  onBack,
  onAskMeri,
  onAccountNote,
  onEdit,
  onRemove,
  onUploadLogo,
  onClientUpdated,
  onCreate,
}: {
  client: Client;
  canManage: boolean;
  canRemove: boolean;
  onBack: () => void;
  onAskMeri: () => void;
  onAccountNote: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onUploadLogo: (client: Client, file: File) => Promise<void>;
  onClientUpdated: () => void;
  onCreate: (key: string) => void;
}) {
  const { message } = AntApp.useApp();
  return (
    <header className="crm-account-header">
      <div className="crm-account-header__top">
        <button className="crm-account-back" type="button" onClick={onBack} aria-label="Back to clients"><ArrowLeftOutlined /></button>
        <div className="crm-account-logo">{client.logoUrl ? <img src={client.logoUrl} alt="" /> : initials(client.name)}</div>
        <div className="crm-account-identity">
          <div className="crm-account-title-row">
            <h1 className="crm-account-name">{client.name}</h1>
            <span className={`crm-account-status is-${client.status}`}>{titleCase(client.status)}</span>
          </div>
          <div className="crm-account-subtitle">
            {portfolioTags(client).slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}
            <span>Client since {formatMonthYear(client.createdAt)}</span>
          </div>
          <div className="crm-account-contact-line">
            {client.primaryContactName ? <span>{client.primaryContactName}</span> : null}
            {client.primaryContactEmail ? <a href={`mailto:${client.primaryContactEmail}`}><MailOutlined /> {client.primaryContactEmail}</a> : null}
            {client.primaryContactPhone ? <a href={`tel:${client.primaryContactPhone.replace(/[^\d+]/g, '')}`}><PhoneOutlined /> {client.primaryContactPhone}</a> : null}
            {client.website ? <a href={externalUrl(client.website)} target="_blank" rel="noreferrer"><LinkOutlined /> {client.website}</a> : null}
          </div>
        </div>
        <div className="crm-account-actions">
          <Button type="primary" icon={<MessageOutlined />} onClick={onAskMeri}>Ask Meri</Button>
          {canManage ? <Button icon={<EditOutlined />} onClick={onAccountNote}>Account note</Button> : null}
          {canManage ? (
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  { key: 'capability', label: 'Capability' },
                  { key: 'contact', label: 'Contact' },
                  { key: 'file', label: 'File' },
                ],
                onClick: ({ key }) => onCreate(key),
              }}
            >
              <Button icon={<PlusOutlined />}>Create</Button>
            </Dropdown>
          ) : null}
          <Upload
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            showUploadList={false}
            beforeUpload={(file) => {
              if ((file as File).size > 2 * 1024 * 1024) {
                void message.error('Logo must be 2 MB or smaller.');
                return Upload.LIST_IGNORE;
              }
              void onUploadLogo(client, file as File)
                .then(() => { message.success('Logo updated'); onClientUpdated(); })
                .catch((error) => message.error(errorMessage(error)));
              return false;
            }}
          >
            <Button aria-label="Change logo" icon={<UploadOutlined />} />
          </Upload>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'edit', label: 'Edit client', icon: <EditOutlined />, disabled: !canManage },
                { key: 'remove', label: 'Remove client', icon: <DeleteOutlined />, danger: true, disabled: !canRemove },
              ],
              onClick: ({ key }) => { if (key === 'edit') onEdit(); if (key === 'remove') onRemove(); },
            }}
          >
            <Button aria-label="More client actions" icon={<MoreOutlined />} />
          </Dropdown>
        </div>
      </div>
    </header>
  );
}

export function Overview({
  client,
  nextAction,
  activities,
  capabilities,
  relationships,
  trackedBills,
  peCount,
  files,
  kbStatus,
  onTab,
  onEdit,
  onMemory,
  onIntelligence,
}: {
  client: Client;
  nextAction?: ReturnType<typeof buildAttentionItems>[number];
  activities: ActivityItem[];
  capabilities: number;
  relationships: number;
  trackedBills: number;
  peCount: number;
  files: number;
  kbStatus?: KbStatusResponse;
  onTab: (tab: CrmTab) => void;
  onEdit: () => void;
  onMemory: () => void;
  onIntelligence: (view: IntelligenceView) => void;
}) {
  const intake = toRecord(client.intakeData);
  const contextTotal = kbTotal(kbStatus);
  return (
    <div className="crm-overview">
      <div className="crm-overview-main">
        <section className="crm-card">
          <div className="crm-card__header"><span className="crm-card__eyebrow">Next action</span></div>
          {nextAction ? (
            <button
              type="button"
              className={`crm-next-action${nextAction.urgent ? ' is-urgent' : ''}`}
              onClick={() => {
                if (nextAction.action === 'activity') onTab('activity');
                if (nextAction.action === 'intelligence') onIntelligence('summary');
                if (nextAction.action === 'edit') onEdit();
              }}
            >
              <span className="crm-attention-dot" />
              <span><b>{nextAction.title}</b><small>{nextAction.copy}</small></span>
              <span>Review →</span>
            </button>
          ) : <div className="crm-empty-copy">No urgent account action right now.</div>}
        </section>

        <section className="crm-card">
          <div className="crm-card__header">
            <h2>Recent activity</h2><span className="crm-card__grow" />
            <Button type="link" size="small" onClick={() => onTab('activity')}>View all →</Button>
          </div>
          <ActivityTimeline items={activities} empty="No activity has been recorded yet." />
        </section>

        <div className="crm-related-records" aria-label="Related client records">
          <button type="button" onClick={() => onTab('capabilities')}>{capabilities} Capabilities</button><span>·</span>
          <button type="button" onClick={() => onTab('relationships')}>{relationships} Relationships</button><span>·</span>
          <button type="button" onClick={() => onIntelligence('legiwatch')}>{trackedBills} Bills</button><span>·</span>
          <button type="button" onClick={() => onIntelligence('client')}>{peCount} Relevant PEs</button><span>·</span>
          <button type="button" onClick={() => onTab('files')}>{files} Files</button>
        </div>
      </div>

      <aside className="crm-overview-rail">
        <section className="crm-card">
          <div className="crm-card__header">
            <h3>Account details</h3><span className="crm-card__grow" />
            <Button type="text" size="small" icon={<EditOutlined />} onClick={onEdit} aria-label="Edit account details" />
          </div>
          <div className="crm-card__body crm-detail-list">
            <DetailRow label="UEI" value={client.uei} mono />
            <DetailRow label="CAGE" value={client.cageCode} mono />
            <DetailRow label="SAM" value={readText(intake, ['samStatus'])} />
            <DetailRow label="SAM expires" value={formatOptionalDate(readText(intake, ['samExpirationDate']))} />
            <DetailRow label="NAICS" value={<CodeSummary values={client.naicsCodes ?? []} />} />
            <DetailRow label="PSC" value={<CodeSummary values={client.pscCodes ?? []} />} />
            <DetailRow label="Certifications" value={<InlineTags values={client.setAsideCertifications ?? []} />} />
            <DetailRow label="Grant eligibility" value={<InlineTags values={client.applicantTypes ?? []} max={2} />} />
            <DetailRow
              label="Meri context"
              value={
                <span className="crm-detail-inline-action">
                  <span>{contextTotal > 0 ? `Ready · ${contextTotal} indexed` : 'Needs context'}</span>
                  <Button type="link" size="small" onClick={onMemory}>Manage</Button>
                </span>
              }
            />
          </div>
        </section>
      </aside>
    </div>
  );
}

export function ActivityTimeline({ items, empty }: { items: ActivityItem[]; empty: string }) {
  if (!items.length) return <div className="crm-empty-copy">{empty}</div>;
  return (
    <div className="crm-timeline">
      {items.map((item) => (
        <div key={`${item.kind}:${item.id}`} className="crm-timeline-item">
          <div className="crm-timeline-time">{formatActivityDate(item.at)}</div>
          <div className={`crm-timeline-marker is-${item.kind}`} />
          <div><div className="crm-timeline-title">{item.title}</div><div className="crm-timeline-meta">{item.meta}</div></div>
        </div>
      ))}
    </div>
  );
}

function DetailRow({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  const empty = value === null || value === undefined || value === '';
  return <div className="crm-detail-row"><span className="crm-detail-label">{label}</span><span className={`crm-detail-value${mono ? ' is-mono' : ''}`}>{empty ? '—' : value}</span></div>;
}
function InlineTags({ values, max = 3 }: { values: string[]; max?: number }) {
  const clean = values.filter(Boolean);
  if (!clean.length) return <>—</>;
  return <span className="crm-inline-tags">{clean.slice(0, max).map((value) => <span key={value} className="crm-inline-tag">{value}</span>)}{clean.length > max ? <span className="crm-inline-tag">+{clean.length - max}</span> : null}</span>;
}
function CodeSummary({ values }: { values: string[] }) {
  return values.length ? <span className="is-mono">{values[0]}{values.length > 1 ? ` +${values.length - 1}` : ''}</span> : <>—</>;
}
function portfolioTags(client: Client): string[] {
  const tags: string[] = [];
  const sector = sectorLabelFor(client);
  if (sector) tags.push(sector);
  for (const track of client.submissionTracks ?? []) {
    const label = SUBMISSION_TRACK_LABELS[track as SubmissionTrack] ?? track;
    if (label && !tags.includes(label)) tags.push(label);
  }
  return tags;
}
function sectorLabelFor(client: Client): string | undefined {
  if (client.sectorTag) return SECTOR_LABELS[client.sectorTag as SectorTag] ?? client.sectorTag;
  const raw = readText(toRecord(client.intakeData), ['sector']);
  if (!raw) return undefined;
  const normalized = normalizeSector(raw);
  return normalized ? SECTOR_LABELS[normalized] : raw;
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase() : (parts[0] ?? 'CL').slice(0, 2).toUpperCase();
}
function externalUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}
function titleCase(value: string): string {
  return value.replace(/[_-]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
