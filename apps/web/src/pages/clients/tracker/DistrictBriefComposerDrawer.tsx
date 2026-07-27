import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { App as AntApp, Button, Empty, Modal, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { useApi } from '../../../lib/use-api.js';
import { errorMessage } from '../../../lib/error-message.js';
import { getClientFacilities, type ClientFacility } from '../facilities-api.js';
import type { FeedItem } from './intel-feed-api.js';
import {
  feedItemToDistrictBriefAlert,
  useGenerateDistrictBrief,
  type DistrictBriefResult,
} from './alert-actions-api.js';

const { Text, Paragraph } = Typography;

/**
 * District-impact one-pager composer (Phase 1 M1.5, PD6). Unlike the memo
 * (client-wide), a brief is grounded in ONE of the client's facilities — its
 * geocoded district and the officials who represent it. When the client has
 * exactly one geocoded facility we generate immediately; with more than one we
 * ask which to ground the brief in; with none, we say so rather than guessing.
 */
export function DistrictBriefComposerDrawer({
  open,
  onClose,
  clientId,
  item,
}: {
  open: boolean;
  onClose: () => void;
  clientId: string;
  item: FeedItem | null;
}) {
  const { message } = AntApp.useApp();
  const api = useApi();
  const navigate = useNavigate();
  const generate = useGenerateDistrictBrief();

  const facilities = useQuery<ClientFacility[]>({
    queryKey: ['client-facilities', clientId],
    queryFn: () => getClientFacilities(api, clientId),
    enabled: open,
  });
  const geocoded = (facilities.data ?? []).filter((f) => f.geocodeStatus === 'matched');

  const [facilityId, setFacilityId] = useState<string | null>(null);
  const [brief, setBrief] = useState<DistrictBriefResult | null>(null);
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const startedFor = useRef<string | null>(null);

  const runGenerate = async (fid: string, replaceAttachmentId?: string) => {
    if (!item) return;
    try {
      const res = await generate.mutateAsync({
        clientId,
        facilityId: fid,
        alert: feedItemToDistrictBriefAlert(item),
        replaceAttachmentId,
      });
      setBrief(res);
      setAttachmentId(res.document?.attachmentId ?? null);
      // c-8 (resolves Gate A b-6's deferral): a HELD brief also has document === null,
      // so the old two-branch check told the analyst "auto-file to Documents failed" for
      // a deliberate governance hold — a policy decision reported as a bug. `held` is
      // checked FIRST, exactly as Gate A c-4 did for the memo. Note there is no filing
      // path on this surface at all (the footer is Regenerate/Copy/Close and the service
      // has no saveEdited), so this was mislabeling, never a save bypass.
      if (res.held) {
        message.warning(
          'Held for review — not filed. A reviewer must approve it before it can be filed.',
        );
      } else if (res.document) {
        message.success('District brief drafted and filed in Documents');
      } else {
        message.warning('District brief drafted (auto-file to Documents failed)');
      }
    } catch (e) {
      // W4.4: surface the SERVER's message (e.g. a 503 "No Anthropic credential"
      // or a 404), not axios's generic "Request failed with status code …".
      message.error(`Could not draft district brief: ${errorMessage(e)}`);
    }
  };

  // Auto-select + auto-generate once facilities load, if there's exactly one
  // geocoded facility. With more than one, wait for the analyst to pick.
  useEffect(() => {
    if (!open) {
      startedFor.current = null;
      return;
    }
    if (!item || startedFor.current === item.id || facilities.isLoading) return;
    if (geocoded.length === 1) {
      startedFor.current = item.id;
      setFacilityId(geocoded[0]!.id);
      setBrief(null);
      setAttachmentId(null);
      void runGenerate(geocoded[0]!.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id, facilities.isLoading, geocoded.length]);

  const onPick = (fid: string) => {
    setFacilityId(fid);
    setBrief(null);
    setAttachmentId(null);
    startedFor.current = item?.id ?? null;
    void runGenerate(fid);
  };

  const busy = generate.isPending;
  const markdown = brief?.markdown ?? '';
  const held = brief?.held === true;

  return (
    <Modal
      title="Generate district brief"
      open={open}
      onCancel={onClose}
      width={760}
      footer={[
        facilityId && (
          <Button
            key="regen"
            onClick={() => void runGenerate(facilityId, attachmentId ?? undefined)}
            loading={busy}
          >
            Regenerate
          </Button>
        ),
        <Button
          key="copy"
          // P2-06: see MemoComposerDrawer — un-awaited + optional-chained meant
          // a failed copy still reported success.
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(markdown);
              message.success('Copied');
            } catch {
              message.warning('Could not copy automatically — select the text and copy manually.');
            }
          }}
          disabled={!markdown}
        >
          Copy
        </Button>,
        held && (
          <Button
            key="review"
            onClick={() =>
              navigate(
                brief?.reviewRequestId
                  ? `/reviews?id=${encodeURIComponent(brief.reviewRequestId)}`
                  : '/reviews',
              )
            }
          >
            View review request
          </Button>
        ),
        <Button key="close" onClick={onClose}>
          Close
        </Button>,
      ].filter(Boolean)}
    >
      {facilities.isLoading ? (
        <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--muted,#8a8a96)' }}>
          Loading facilities…
        </div>
      ) : geocoded.length === 0 ? (
        <Empty
          description={
            facilities.data?.length
              ? "None of this client's facilities have a resolved district yet — add a full address in Facilities and try again."
              : 'This client has no facilities on record — add one in Facilities to generate a district brief.'
          }
        />
      ) : geocoded.length > 1 && !facilityId ? (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Text>Which facility should this brief cover?</Text>
          <Select
            style={{ width: '100%' }}
            placeholder="Select a facility"
            options={geocoded.map((f) => ({
              value: f.id,
              label: [f.name, f.city, f.state].filter(Boolean).join(' — '),
            }))}
            onChange={onPick}
          />
        </Space>
      ) : busy && !brief ? (
        <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--muted,#8a8a96)' }}>
          Generating a district brief…
        </div>
      ) : (
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <Space size={6} wrap>
            {held ? (
              <Tooltip
                title={brief?.heldReason || 'The grounding auditor held this brief for review.'}
              >
                <Tag color="red">Held for review — unapproved draft</Tag>
              </Tooltip>
            ) : attachmentId ? (
              <Tag color="green">Saved to Documents ✓</Tag>
            ) : (
              <Tag>Not yet filed</Tag>
            )}
            {brief?.lowConfidence && (
              <Tooltip title="Generation was thin or fell back to a scaffold — review carefully.">
                <Tag color="orange">Low confidence</Tag>
              </Tooltip>
            )}
            {geocoded.length > 1 && (
              <Select
                size="small"
                style={{ minWidth: 200 }}
                value={facilityId ?? undefined}
                options={geocoded.map((f) => ({ value: f.id, label: f.name }))}
                onChange={onPick}
              />
            )}
            {brief && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                {brief.usedTenantKey ? 'tenant key' : 'shared key'}
              </Text>
            )}
          </Space>

          <Paragraph
            style={{
              whiteSpace: 'pre-wrap',
              fontFamily: 'var(--mono, ui-monospace, monospace)',
              fontSize: 12.5,
            }}
          >
            {markdown}
          </Paragraph>

          {brief?.sources?.length ? (
            <div>
              <Text strong style={{ fontSize: 12 }}>
                Sources
              </Text>
              {brief.sources.map((s) => (
                <Paragraph
                  key={s.claimId}
                  style={{ margin: '2px 0', fontSize: 11.5 }}
                  type="secondary"
                >
                  <Text code style={{ fontSize: 10.5 }}>
                    [{s.claimId}]
                  </Text>{' '}
                  {s.label}
                  {s.url ? (
                    <>
                      {' — '}
                      <a href={s.url} target="_blank" rel="noreferrer">
                        source
                      </a>
                    </>
                  ) : null}
                  {s.retrievedAt ? ` · retrieved ${s.retrievedAt}` : null}
                  {s.verification ? ` · ${s.verification}` : null}
                </Paragraph>
              ))}
            </div>
          ) : null}
        </Space>
      )}
    </Modal>
  );
}

export default DistrictBriefComposerDrawer;
