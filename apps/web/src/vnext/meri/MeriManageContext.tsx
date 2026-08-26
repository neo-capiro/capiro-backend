import { useState } from 'react';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { useCapiroToast } from '../components/feedback/toast.js';
import { MeriIcon, type MeriIconName } from './meri-icons.js';

/**
 * MeriManageContext — the ACTIVE CONTEXT "Manage conversation context" panel:
 * included rows with remove, suggested rows with add, behaviour toggles, and
 * the apply footer. Pixel-parity port of the prototype's `panelIsManage` block.
 *
 * BACKEND GAP: thread-level context membership has no vNext endpoint. Add /
 * remove / apply are toasts until the context API lands. Tracked in GAPS.md
 * (Meri vNext — manage context).
 */

const MONO = "var(--meri-font-mono, Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif)";

export interface MeriManageContextItem {
  icon?: MeriIconName;
  title: string;
  kind: string;
}

export const MERI_MANAGE_INCLUDED: MeriManageContextItem[] = [
  { icon: 'Building01', title: 'Lockheed Martin — client profile', kind: 'CLIENT RECORD · AS OF AUG 14' },
  { icon: 'Route', title: 'FY27 rotorcraft strategy', kind: 'STRATEGY · 12 LIVE NODES' },
  { icon: 'File05', title: 'HASC FY27 committee report', kind: 'SOURCE · REPORT P. 187' },
];

export const MERI_MANAGE_SUGGESTED: MeriManageContextItem[] = [
  { title: 'Meeting — Calvert personal office, Aug 13', kind: 'MEETING' },
  { title: 'HAC-D subcommittee mark', kind: 'SOURCE' },
  { title: 'CA-41 district nexus', kind: 'DISTRICT' },
];

function ContextToggle({
  label,
  initialOn,
}: {
  label: string;
  initialOn: boolean;
}) {
  const [on, setOn] = useState(initialOn);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: '18px', color: '#344054' }}>
        {label}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => setOn((v) => !v)}
        style={{
          position: 'relative',
          flex: '0 0 auto',
          width: 38,
          height: 22,
          borderRadius: 9999,
          background: on
            ? 'linear-gradient(180deg,#39424F 0%,#1B2430 46%,#0E141C 100%)'
            : '#F2F4F7',
          border: on ? '1px solid transparent' : '1px solid #D0D5DD',
          boxShadow: on ? 'inset 0 1px 0 rgba(255,255,255,.14)' : undefined,
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 1,
            left: on ? 17 : 1,
            width: 18,
            height: 18,
            borderRadius: 9999,
            background: '#ffffff',
            boxShadow: '0 1px 2px rgba(16,24,40,.2)',
            transition: 'left 140ms ease',
          }}
        />
      </button>
    </div>
  );
}

interface MeriManageContextProps {
  /** Reserved for wiring to live context membership; fixtures render when absent. */
  controller?: MeriChatController;
  included?: MeriManageContextItem[];
  suggested?: MeriManageContextItem[];
  onCancel?: () => void;
  onApply?: () => void;
}

export function MeriManageContext({
  included = MERI_MANAGE_INCLUDED,
  suggested = MERI_MANAGE_SUGGESTED,
  onCancel,
  onApply,
}: MeriManageContextProps) {
  const toast = useCapiroToast();
  const [removedTitles, setRemovedTitles] = useState<ReadonlySet<string>>(new Set());
  const [addedTitles, setAddedTitles] = useState<ReadonlySet<string>>(new Set());

  const visibleIncluded = included.filter((item) => !removedTitles.has(item.title));

  const remove = (item: MeriManageContextItem) => {
    setRemovedTitles((current) => new Set(current).add(item.title));
    toast.success('Removed from this thread. Earlier answers keep their citations.');
  };

  const add = (item: MeriManageContextItem) => {
    setAddedTitles((current) => new Set(current).add(item.title));
    toast.success('Added to this thread. It is now in Active context.');
  };

  return (
    <div style={{ animation: 'vnext-meri-rise .2s cubic-bezier(.2,0,0,1)' }}>
      <div style={{ padding: '16px 20px 14px', borderBottom: '1px solid #EAECF0' }}>
        <div style={{ fontSize: 15, lineHeight: '22px', fontWeight: 600, color: '#101828' }}>
          Manage conversation context
        </div>
        <div style={{ marginTop: 5, fontSize: 13, lineHeight: '19px', color: '#667085' }}>
          Choose exactly what Meri should use in this thread. Client scope remains visible and
          auditable.
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            height: 34,
            marginTop: 12,
            padding: '0 11px',
            borderRadius: 8,
            background: '#F9FAFB',
            border: '1px solid #EAECF0',
          }}
        >
          <MeriIcon name="SearchLg" size={14} color="#98A2B3" />
          <input
            placeholder="Search clients, strategies, bills, meetings, files…"
            aria-label="Search clients, strategies, bills, meetings, files"
            style={{
              flex: 1,
              minWidth: 0,
              background: 'none',
              border: 0,
              outline: 'none',
              fontSize: 13,
              color: '#101828',
            }}
          />
        </div>
      </div>

      <div style={{ padding: '16px 20px', borderBottom: '1px solid #EAECF0' }}>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 9.5,
            fontWeight: 500,
            letterSpacing: '.09em',
            color: '#667085',
          }}
        >
          INCLUDED IN THIS THREAD · {visibleIncluded.length}
        </div>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {visibleIncluded.map((item) => (
            <div
              key={item.title}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '11px 12px',
                borderRadius: 9,
                background: '#ffffff',
                border: '1px solid #EAECF0',
              }}
            >
              <span
                style={{
                  flex: '0 0 auto',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  background: '#F2F4F7',
                }}
              >
                <MeriIcon name={item.icon ?? 'File05'} size={13} color="#101828" />
              </span>
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span
                  style={{
                    fontSize: 12.5,
                    lineHeight: '18px',
                    fontWeight: 500,
                    color: '#101828',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {item.title}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: '.07em', color: '#667085' }}>
                  {item.kind}
                </span>
              </span>
              <button
                type="button"
                title="Remove"
                aria-label={`Remove ${item.title}`}
                onClick={() => remove(item)}
                style={{
                  flex: '0 0 auto',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  color: '#98A2B3',
                }}
              >
                <MeriIcon name="XClose" size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div style={{ padding: '16px 20px', borderBottom: '1px solid #EAECF0' }}>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 9.5,
            fontWeight: 500,
            letterSpacing: '.09em',
            color: '#667085',
          }}
        >
          SUGGESTED CONTEXT
        </div>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {suggested.map((item) => {
            const added = addedTitles.has(item.title);
            return (
              <div
                key={item.title}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '11px 12px',
                  borderRadius: 9,
                  background: '#F9FAFB',
                  border: '1px solid #EAECF0',
                }}
              >
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 12.5, lineHeight: '18px', fontWeight: 500, color: '#101828' }}>
                    {item.title}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: '.07em', color: '#667085' }}>
                    {item.kind}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={added}
                  onClick={() => add(item)}
                  style={{
                    flex: '0 0 auto',
                    height: 26,
                    padding: '0 10px',
                    borderRadius: 7,
                    border: '1px solid #D0D5DD',
                    fontSize: 12,
                    fontWeight: 600,
                    color: '#344054',
                    opacity: added ? 0.5 : 1,
                  }}
                >
                  {added ? 'Added' : 'Add'}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ padding: '16px 20px 20px' }}>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 9.5,
            fontWeight: 500,
            letterSpacing: '.09em',
            color: '#667085',
          }}
        >
          CONTEXT BEHAVIOUR
        </div>
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <ContextToggle label="Automatically include new Strategy nodes" initialOn={false} />
          <ContextToggle label="Show context used beneath each answer" initialOn={true} />
        </div>
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #EAECF0' }}>
          <div
            style={{
              fontFamily: MONO,
              fontSize: 9,
              fontWeight: 500,
              lineHeight: '15px',
              letterSpacing: '.08em',
              color: '#98A2B3',
            }}
          >
            CHANGES APPLY TO THIS THREAD ONLY AND ARE RECORDED · EARLIER ANSWERS KEEP THEIR
            CITATIONS
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 12 }}>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => onCancel?.()}
              style={{
                height: 34,
                padding: '0 13px',
                borderRadius: 8,
                border: '1px solid #D0D5DD',
                fontSize: 13,
                fontWeight: 600,
                color: '#344054',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                onApply?.();
                toast.success('Context applied to this thread and recorded.');
              }}
              style={{
                height: 34,
                padding: '0 14px',
                borderRadius: 8,
                background: 'linear-gradient(180deg,#39424F 0%,#1B2430 46%,#0E141C 100%)',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,.14)',
                fontSize: 13,
                fontWeight: 600,
                color: '#ffffff',
              }}
            >
              Apply context
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
