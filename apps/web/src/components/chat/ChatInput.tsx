import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  CheckCircleFilled,
  ExclamationCircleFilled,
  ExperimentOutlined,
  FileImageOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  FileUnknownOutlined,
  FileWordOutlined,
  LoadingOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import { ManagedComposerPlus } from './ManagedComposerPlus.js';

/** A file staged in the composer: uploading, ready to send, or failed. */
export interface StagedAttachment {
  /** Client-side key, stable across the upload lifecycle. */
  localId: string;
  /** Server attachment id once uploaded; null while uploading or when unusable. */
  id: string | null;
  filename: string;
  kind: 'pdf' | 'docx' | 'image' | 'text' | 'unsupported';
  status:
    | 'uploading'
    | 'parsed'
    | 'truncated'
    | 'image_ready'
    | 'scanned'
    | 'unsupported'
    | 'error';
  reason: string | null;
}

/** True when a staged file can be referenced by a send (has a server id). */
export function isUsableAttachment(att: StagedAttachment): boolean {
  return (
    att.id !== null &&
    (att.status === 'parsed' || att.status === 'truncated' || att.status === 'image_ready')
  );
}

export function attachmentKindIcon(kind: string): ReactNode {
  switch (kind) {
    case 'pdf':
      return <FilePdfOutlined />;
    case 'docx':
      return <FileWordOutlined />;
    case 'image':
      return <FileImageOutlined />;
    case 'text':
      return <FileTextOutlined />;
    default:
      return <FileUnknownOutlined />;
  }
}

/** Middle-ellipsis truncation so the start AND the extension stay visible. */
export function truncateFilenameMiddle(name: string, max = 28): string {
  if (name.length <= max) return name;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

const ATTACH_ACCEPT = '.pdf,.docx,.txt,.md,.csv,image/png,image/jpeg,image/gif,image/webp';

interface ChatInputProps {
  disabled?: boolean;
  onSend: (content: string) => void;
  writeMode?: boolean;
  onToggleWriteMode?: () => void;
  researchMode?: boolean;
  onToggleResearchMode?: () => void;
  researchAwaitingAnswers?: boolean;
  /** Staged attachment chips (state owned by ChatDrawer). */
  attachments?: StagedAttachment[];
  onAttachFiles?: (files: FileList) => void;
  onRemoveAttachment?: (localId: string) => void;
  /** True while any staged file is still uploading — blocks Send. */
  uploadsInFlight?: boolean;
  /** Friendly limit message (too many files / images). */
  attachmentNotice?: string | null;
}

export function ChatInput({
  disabled,
  onSend,
  writeMode = false,
  onToggleWriteMode,
  researchMode = false,
  onToggleResearchMode,
  researchAwaitingAnswers = false,
  attachments = [],
  onAttachFiles,
  onRemoveAttachment,
  uploadsInFlight = false,
  attachmentNotice,
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled || uploadsInFlight) return;
    onSend(trimmed);
    setValue('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const placeholder = researchMode
    ? researchAwaitingAnswers
      ? 'Answer Meri’s questions (or say “go ahead”) to start the research…'
      : 'Describe what to research — Meri will plan it and ask a few questions…'
    : writeMode
      ? 'Write mode: describe what to update on this page (subject/body/field)…'
      : 'Ask Meri… (Enter to send, Shift+Enter for newline)';

  return (
    <div className="chat-input-row">
      <div className="chat-composer">
        {attachments.length > 0 && (
          <div className="chat-attach-row" aria-label="Attached files">
            {attachments.map((att) => {
              const failed =
                att.status === 'error' || att.status === 'scanned' || att.status === 'unsupported';
              return (
                <span
                  key={att.localId}
                  className={`chat-attach-chip${failed ? ' chat-attach-chip--error' : ''}`}
                >
                  <span className="chat-attach-chip-icon" aria-hidden="true">
                    {attachmentKindIcon(att.kind)}
                  </span>
                  <span className="chat-attach-chip-name" title={att.filename}>
                    {truncateFilenameMiddle(att.filename)}
                  </span>
                  {att.status === 'uploading' ? (
                    <span
                      className="chat-attach-chip-status chat-attach-chip-status--uploading"
                      aria-label="Uploading"
                    >
                      <LoadingOutlined spin />
                    </span>
                  ) : failed ? (
                    <Tooltip title={att.reason || 'This file can’t be used.'}>
                      <span
                        className="chat-attach-chip-status chat-attach-chip-status--error"
                        aria-label="Unusable file"
                      >
                        <ExclamationCircleFilled />
                      </span>
                    </Tooltip>
                  ) : att.status === 'truncated' ? (
                    <Tooltip title={att.reason || 'File was clipped to fit the context.'}>
                      <span className="chat-attach-tag">truncated</span>
                    </Tooltip>
                  ) : (
                    <span
                      className="chat-attach-chip-status chat-attach-chip-status--ok"
                      aria-label="Ready"
                    >
                      <CheckCircleFilled />
                    </span>
                  )}
                  <button
                    type="button"
                    className="chat-attach-chip-remove"
                    aria-label={`Remove ${att.filename}`}
                    title="Remove"
                    onClick={() => onRemoveAttachment?.(att.localId)}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        )}
        {attachmentNotice && <div className="chat-attach-notice">{attachmentNotice}</div>}
        <textarea
          className={`chat-input-textarea${writeMode ? ' chat-input-textarea--write' : ''}${
            researchMode ? ' chat-input-textarea--research' : ''
          }`}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
          }}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="chat-composer-actions">
          {onAttachFiles ? (
            <>
              <ManagedComposerPlus
                disabled={disabled}
                onUpload={() => fileInputRef.current?.click()}
              />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ATTACH_ACCEPT}
                style={{ display: 'none' }}
                aria-hidden="true"
                tabIndex={-1}
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    onAttachFiles(e.target.files);
                  }
                  // Reset so re-selecting the same file fires onChange again.
                  e.target.value = '';
                }}
              />
            </>
          ) : null}
          {onToggleResearchMode ? (
            <button
              type="button"
              className={`chat-mode-toggle chat-research-toggle${researchMode ? ' is-active' : ''}`}
              onClick={onToggleResearchMode}
              disabled={disabled}
              aria-label={researchMode ? 'Disable deep research' : 'Enable deep research'}
              title={researchMode ? 'Deep research on' : 'Deep research'}
            >
              <ExperimentOutlined />
              <span>Research</span>
            </button>
          ) : null}
          {onToggleWriteMode ? (
            <button
              type="button"
              className={`chat-mode-toggle chat-write-toggle${writeMode ? ' is-active' : ''}`}
              onClick={onToggleWriteMode}
              disabled={disabled}
              aria-label={writeMode ? 'Disable write mode' : 'Enable write mode'}
              title={writeMode ? 'Write mode on' : 'Write mode off'}
            >
              Write
            </button>
          ) : null}
          <span className="chat-composer-spacer" />
          <Button
            type="primary"
            shape="circle"
            icon={<SendOutlined />}
            disabled={disabled || uploadsInFlight || !value.trim()}
            onClick={submit}
            className="chat-input-send"
            aria-label="Send message"
          />
        </div>
      </div>
    </div>
  );
}
