import { useEffect, useMemo, useState } from 'react';
import {
  DatabaseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FileImageOutlined,
  FileOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  SearchOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { Button, Input, Select, Skeleton, Tag, Upload } from 'antd';
import { SharedMeetingsSection } from '../engagement/meetings/SharedMeetingsSection.js';
import type { Client, ClientAttachment } from './clientTypes.js';
import {
  documentSourceLabel,
  formatBytes,
  formatDate,
  kbTotal,
  type KbStatusResponse,
} from './client-profile-crm-model.js';

export function ClientProfileFiles({
  client,
  documents,
  loading,
  canManage,
  kbStatus,
  onUpload,
  onDelete,
}: {
  client: Client;
  documents: ClientAttachment[];
  loading: boolean;
  canManage: boolean;
  kbStatus?: KbStatusResponse;
  onUpload: (files: File[]) => Promise<void>;
  onDelete: (document: ClientAttachment) => void;
}) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const sourceOptions = useMemo(
    () => Array.from(new Set(documents.map((document) => documentSourceLabel(document.source)))),
    [documents],
  );
  const attachmentId = useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).get('attachmentId');
    } catch {
      return null;
    }
  }, []);
  const filtered = useMemo(
    () =>
      documents.filter((document) => {
        const sourceLabel = documentSourceLabel(document.source);
        return (
          (!query.trim() || document.fileName.toLowerCase().includes(query.trim().toLowerCase())) &&
          (source === 'all' || sourceLabel === source)
        );
      }),
    [documents, query, source],
  );

  useEffect(() => {
    if (!attachmentId) return;
    const target = document.getElementById(`client-file-${attachmentId}`);
    target?.scrollIntoView({ block: 'center' });
  }, [attachmentId, filtered.length]);

  return (
    <section className="crm-section-shell">
      <div className="crm-section-head">
        <div>
          <h2>Files</h2>
          <p>Meeting records, generated work and uploaded evidence, with provenance.</p>
        </div>
        <KbStatusTag status={kbStatus} />
      </div>

      <SharedMeetingsSection clientId={client.id} clientName={client.name} />

      <div className="crm-card">
        <div className="crm-card__header">
          <h3>Client files</h3>
          <span className="crm-card__grow" />
          <Input
            prefix={<SearchOutlined />}
            allowClear
            placeholder="Search files"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            style={{ width: 220 }}
          />
          <Select
            value={source}
            onChange={setSource}
            style={{ width: 170 }}
            options={[
              { label: 'All sources', value: 'all' },
              ...sourceOptions.map((value) => ({ label: value, value })),
            ]}
          />
        </div>

        {canManage ? (
          <div className="crm-upload-wrap">
            <Upload.Dragger
              multiple
              showUploadList={false}
              accept=".pdf,.doc,.docx,.txt,.ppt,.pptx,.xls,.xlsx,.csv,image/*"
              beforeUpload={(file, fileList) => {
                if (file.uid === fileList[0]?.uid) void onUpload(fileList.map((item) => item as File));
                return false;
              }}
            >
              <p className="ant-upload-drag-icon"><UploadOutlined /></p>
              <p className="ant-upload-text">Drop files here or click to upload</p>
              <p className="ant-upload-hint">PDF, Office files, text, CSV and images · max 25 MB each</p>
            </Upload.Dragger>
          </div>
        ) : null}

        {loading ? (
          <div className="crm-card__body"><Skeleton active paragraph={{ rows: 4 }} /></div>
        ) : filtered.length ? (
          <div className="crm-file-list">
            {filtered.map((document) => (
              <div
                id={`client-file-${document.id}`}
                className={`crm-file-row${attachmentId === document.id ? ' is-highlighted' : ''}`}
                key={document.id}
              >
                <span className="crm-file-icon">{documentIcon(document.contentType, document.fileName)}</span>
                <span className="crm-file-info">
                  <b>{document.fileName}</b>
                  <small>
                    {documentSourceLabel(document.source)} · {formatDate(document.createdAt)}
                    {document.byteSize != null ? ` · ${formatBytes(document.byteSize)}` : ''}
                    {document.uploadedByName ? ` · ${document.uploadedByName}` : ''}
                  </small>
                </span>
                <span>{document.indexedAt ? <Tag color="green">Indexed</Tag> : <Tag>Not indexed</Tag>}</span>
                <span className="crm-file-actions">
                  {document.downloadUrl ? (
                    <Button
                      type="text"
                      icon={<DownloadOutlined />}
                      href={document.downloadUrl}
                      target="_blank"
                      aria-label={`Download ${document.fileName}`}
                    />
                  ) : null}
                  {canManage ? (
                    <Button
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => onDelete(document)}
                      aria-label={`Remove ${document.fileName}`}
                    />
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="crm-empty-copy">No files match the current filters.</div>
        )}
      </div>
    </section>
  );
}

function KbStatusTag({ status }: { status?: KbStatusResponse }) {
  const total = kbTotal(status);
  return total ? (
    <Tag color="blue" icon={<DatabaseOutlined />}>{total} Meri knowledge items</Tag>
  ) : (
    <Tag icon={<DatabaseOutlined />}>Not indexed yet</Tag>
  );
}

function documentIcon(contentType: string, fileName: string) {
  if (contentType.startsWith('image/')) return <FileImageOutlined />;
  if (contentType === 'application/pdf' || /\.pdf$/i.test(fileName)) return <FilePdfOutlined />;
  if (contentType === 'text/plain' || /\.txt$/i.test(fileName)) return <FileTextOutlined />;
  return <FileOutlined />;
}
