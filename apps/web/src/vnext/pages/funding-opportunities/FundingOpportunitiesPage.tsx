import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroInput, CapiroTextarea } from '../../components/fields/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import {
  readEnum,
  useUrlState,
} from '../../../pages/intelligence/opportunities/funding-opportunities-url-state.js';
import {
  FUNDING_OPPORTUNITIES_FEATURE,
  FUNDING_OPPORTUNITIES_INBOX_FEATURE,
  FUNDING_OPPORTUNITIES_PIPELINE_FEATURE,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { FundingOpportunityExplore } from './FundingOpportunityExplore.js';
import { FundingOpportunityInbox } from './FundingOpportunityInbox.js';
import { FundingOpportunityPipeline } from './FundingOpportunityPipeline.js';
import { FovAlert, FovSkeletonRows } from './fov-ui.js';
import './funding-opportunities-vnext.css';
import './funding-opportunities-prototype.css';

interface ClientLite {
  id: string;
  name: string;
  status?: string;
}
export const OPPORTUNITY_VIEWS = ['inbox', 'explore', 'pipeline'] as const;
export type OpportunityView = (typeof OPPORTUNITY_VIEWS)[number];

/** Native vNext module; the surrounding application navigation belongs to the shell. */
export function FundingOpportunitiesPage() {
  const { enabled, ready } = useIntelFeature(FUNDING_OPPORTUNITIES_FEATURE);
  const inboxFlag = useIntelFeature(FUNDING_OPPORTUNITIES_INBOX_FEATURE);
  const pipelineFlag = useIntelFeature(FUNDING_OPPORTUNITIES_PIPELINE_FEATURE);
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const url = useUrlState();
  const [refreshing, setRefreshing] = useState(false);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const [shareComposeOpen, setShareComposeOpen] = useState(false);
  const [shareTo, setShareTo] = useState('');
  const [shareSubject, setShareSubject] = useState('');
  const [shareBody, setShareBody] = useState('');
  const [shareSending, setShareSending] = useState(false);
  const shareAnchorRef = useRef<HTMLSpanElement | null>(null);
  // Close the share dropdown / compose popover on any click outside it or on
  // Escape — the same behaviour the module's other fov-popanchor popovers use.
  useEffect(() => {
    if (!shareMenuOpen && !shareComposeOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!shareAnchorRef.current?.contains(event.target as Node)) {
        setShareMenuOpen(false);
        setShareComposeOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setShareMenuOpen(false);
        setShareComposeOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [shareMenuOpen, shareComposeOpen]);
  const clientId = url.get('clientId') ?? undefined;
  const inboxAvailable = inboxFlag.ready && inboxFlag.enabled;
  const boardAvailable = inboxAvailable && pipelineFlag.ready && pipelineFlag.enabled;
  const view = readEnum<OpportunityView>(
    url.get('view'),
    inboxAvailable ? OPPORTUNITY_VIEWS : ['explore'],
    inboxAvailable ? 'inbox' : 'explore',
  );
  const board = view === 'pipeline' && boardAvailable && url.get('layout') === 'board';
  const clients = useQuery<ClientLite[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<ClientLite[]>('/api/clients')).data,
    staleTime: 60_000,
    enabled: ready && enabled,
  });
  const visibleClients = (clients.data ?? []).filter((client) => client.status !== 'archived');
  const clientName = visibleClients.find((client) => client.id === clientId)?.name;
  /**
   * The clients the user is actually TRACKING, for the Tracking tab's dropdown.
   *
   * Distinct from `clients` (every accessible client, for Recommended/Browse):
   * the Tracking surface narrows to what has been saved, so its dropdown must
   * too. Fetched only while the Tracking tab is mounted — the endpoint does a
   * distinct query the other tabs do not need.
   */
  const trackedClients = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['funding-opportunity-tracked-clients'],
    queryFn: async () =>
      (await api.get<Array<{ id: string; name: string }>>(
        '/api/intelligence/opportunities/inbox/tracked-clients',
      )).data,
    staleTime: 15_000,
    enabled: ready && enabled && view === 'pipeline',
  });
  // The Tracking dropdown's option list: tracked clients only, still intersected
  // with the accessible list so a walled/archived client can never render.
  const trackedClientOptions = visibleClients.filter((client) =>
    (trackedClients.data ?? []).some((tracked) => tracked.id === client.id),
  );

  function setClient(next: string | undefined) {
    url.set({ clientId: next ?? null, cursor: null, page: null, detail: null });
  }
  function setView(next: OpportunityView) {
    // Explicit explore remains explicit now that Recommended is the default.
    url.set({
      view: next,
      clientId: next === 'pipeline' ? null : url.get('clientId'),
      filter: null,
      cursor: null,
      page: null,
      detail: null,
      layout: null,
    });
  }
  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all(
        [
          'funding-opportunities',
          'funding-opportunity-inbox',
          'funding-opportunities-freshness',
          'funding-opportunity-pipeline',
          'funding-opportunity-detail',
          'funding-opportunity-forecast',
          'funding-opportunity-feed',
          'funding-opportunity-feed-detail',
          'funding-opportunity-action-plan',
          'engagement-tasks',
          'client-funding-opportunities',
        ].map((key) => qc.invalidateQueries({ queryKey: [key] }, { throwOnError: true })),
      );
      toast.success('Current opportunity records refreshed.');
    } catch {
      toast.error('Some records could not refresh. Please try again.');
    } finally {
      setRefreshing(false);
    }
  }
  /**
   * Share the current filtered view: a dropdown under the Share button with
   * two items — "Send as email" (compose popover → the engagement single-mail
   * send path from the user's own connected mailbox, mailto: fallback when no
   * mailbox is connected) and "Copy link" (clipboard + toast, unchanged).
   */
  function toggleShareMenu() {
    setShareMenuOpen((open) => !open);
    if (!shareMenuOpen) setShareComposeOpen(false);
  }

  /** Prefill + open the compose popover; the To field starts empty on purpose. */
  function openShareCompose() {
    setShareMenuOpen(false);
    setShareSubject('Funding opportunities view — Capiro');
    setShareBody(`Take a look at this funding opportunities view in Capiro: ${window.location.href}`);
    setShareComposeOpen(true);
  }

  function closeShareCompose() {
    setShareComposeOpen(false);
  }

  /**
   * Send through the user's own connected mailbox via the existing engagement
   * single-mail endpoint (POST /api/engagement/mail/send → sendSingleMail →
   * MailSender with the Gmail / Microsoft Graph adapters). A BadRequest means
   * no connected mailbox (sendSingleMail's own "Connect your email" message)
   * or a rejected recipient — fall back to mailto: with everything prefilled.
   */
  async function sendShareEmail() {
    const recipients = shareTo
      .split(/[,;]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (recipients.length === 0) {
      toast.error('Add at least one recipient email address.');
      return;
    }
    setShareSending(true);
    try {
      await api.post('/api/engagement/mail/send', {
        to: recipients.map((email) => ({ email })),
        subject: shareSubject,
        bodyHtml: `<p>${shareBody
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\n/g, '<br />')}</p>`,
      });
      toast.success('Email sent from your connected mailbox.');
      closeShareCompose();
    } catch {
      toast.success('No connected mailbox — opening your email app with the message prefilled.');
      const subject = encodeURIComponent(shareSubject);
      const body = encodeURIComponent(shareBody);
      window.location.href = `mailto:${recipients.map(encodeURIComponent).join(',')}?subject=${subject}&body=${body}`;
      closeShareCompose();
    } finally {
      setShareSending(false);
    }
  }

  async function copyViewLink() {
    setShareMenuOpen(false);
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success('View link copied.');
    } catch {
      toast.error('The browser could not copy this view link.');
    }
  }

  if (!ready || !inboxFlag.ready)
    return (
      <div className="fov">
        <FovSkeletonRows rows={6} />
      </div>
    );
  if (!enabled)
    return (
      <div className="fov">
        <FovAlert tone="info" message="Funding Opportunities is not enabled for this workspace" />
      </div>
    );

  return (
    <div className={`fov fov-page fo-module fo-module--${view}`}>
      <header className="fo-module-hero">
        <div className="fo-module-hero__copy">
          <h1>Funding Opportunities</h1>
          <p>Find a fit for your clients, decide what to pursue, and keep the next step in view.</p>
        </div>
        <div className="fo-module-hero__actions">
          <div className="fo-module-action-row">
            <span className="fov-popanchor" ref={shareAnchorRef}>
              <CapiroButton
                onClick={toggleShareMenu}
                aria-haspopup="menu"
                aria-expanded={shareMenuOpen}
              >
                Share
              </CapiroButton>
              {shareMenuOpen ? (
                <div
                  className="fov-popanchor__panel fov-popanchor__panel--left"
                  role="menu"
                  aria-label="Share this view"
                >
                  <ul className="fov-menu">
                    <li role="none">
                      <button type="button" role="menuitem" onClick={openShareCompose}>
                        Send as email
                      </button>
                    </li>
                    <li role="none">
                      <button type="button" role="menuitem" onClick={() => void copyViewLink()}>
                        Copy link
                      </button>
                    </li>
                  </ul>
                </div>
              ) : null}
              {shareComposeOpen ? (
                <div
                  className="fov-popanchor__panel fov-popanchor__panel--left"
                  role="dialog"
                  aria-label="Send this view as email"
                >
                  <div className="fov-share-compose">
                    <CapiroInput
                      label="To"
                      type="email"
                      placeholder="name@example.com"
                      value={shareTo}
                      onChange={(event) => setShareTo(event.target.value)}
                    />
                    <CapiroInput
                      label="Subject"
                      value={shareSubject}
                      onChange={(event) => setShareSubject(event.target.value)}
                    />
                    <CapiroTextarea
                      label="Body"
                      rows={5}
                      value={shareBody}
                      onChange={(event) => setShareBody(event.target.value)}
                    />
                    <div className="fov-share-compose__actions">
                      <CapiroButton
                        loading={shareSending}
                        onClick={() => void sendShareEmail()}
                      >
                        Send
                      </CapiroButton>
                      <CapiroButton variant="quiet" onClick={closeShareCompose}>
                        Cancel
                      </CapiroButton>
                    </div>
                  </div>
                </div>
              ) : null}
            </span>
            <CapiroButton loading={refreshing} onClick={() => void refresh()}>
              Refresh
            </CapiroButton>
          </div>
        </div>
      </header>
      {inboxAvailable ? (
        <div className="fo-module-tabs" role="tablist" aria-label="Funding Opportunities view">
          {(
            [
              { value: 'inbox', label: 'Recommended' },
              { value: 'explore', label: 'Browse' },
              { value: 'pipeline', label: 'Tracking' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              id={`fo-view-${tab.value}`}
              aria-controls="fo-view-panel"
              aria-selected={view === tab.value}
              tabIndex={view === tab.value ? 0 : -1}
              onKeyDown={(event) => {
                const index = OPPORTUNITY_VIEWS.indexOf(tab.value);
                const next =
                  event.key === 'ArrowRight'
                    ? (index + 1) % 3
                    : event.key === 'ArrowLeft'
                      ? (index + 2) % 3
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? 2
                          : null;
                if (next == null) return;
                event.preventDefault();
                const target = OPPORTUNITY_VIEWS[next]!;
                setView(target);
                document.getElementById(`fo-view-${target}`)?.focus();
              }}
              className={view === tab.value ? 'is-active' : undefined}
              onClick={() => setView(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}
      <main
        id="fo-view-panel"
        role={inboxAvailable ? 'tabpanel' : undefined}
        aria-labelledby={inboxAvailable ? `fo-view-${view}` : undefined}
        className={`fo-module-body fo-module-body--${view}`}
      >
        {!inboxAvailable ? (
          <p className="fov-muted">
            Recommendations and tracking are not enabled for this workspace. You can browse source
            records below.
          </p>
        ) : null}
        <div className="fo-view-toolbar">
          <label className="fo-scope-control">
            <span className="fo-sr-only">Client</span>
            <select
              value={clientId ?? ''}
              onChange={(event) => setClient(event.target.value || undefined)}
              aria-label="Client"
              aria-busy={clients.isLoading || undefined}
            >
              <option value="">
                {view === 'pipeline'
                  ? trackedClients.isSuccess && trackedClientOptions.length === 0
                    ? 'No clients tracked yet'
                    : 'Show all tracked clients'
                  : view === 'explore'
                    ? 'Research without a client'
                    : 'All accessible clients'}
              </option>
              {view === 'pipeline'
                ? clientId && !trackedClientOptions.some((client) => client.id === clientId)
                  ? [
                      <option key={clientId} value={clientId}>
                        Selected client has nothing tracked
                      </option>,
                    ]
                  : null
                : clientId && !visibleClients.some((client) => client.id === clientId)
                  ? [
                      <option key={clientId} value={clientId}>
                        {clients.isLoading ? 'Loading selected client…' : 'Selected client unavailable'}
                      </option>,
                    ]
                  : null}
              {(view === 'pipeline' ? trackedClientOptions : visibleClients).map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
            <span aria-hidden="true">⌄</span>
          </label>
          {view === 'pipeline' && clientId && boardAvailable ? (
            <div className="fov-row" role="group" aria-label="Tracking view">
              <CapiroButton aria-pressed={!board} onClick={() => url.set({ layout: null })}>
                List
              </CapiroButton>
              <CapiroButton aria-pressed={board} onClick={() => url.set({ layout: 'board' })}>
                Pursuit board
              </CapiroButton>
            </div>
          ) : null}
        </div>
        {clients.isError ? (
          <FovAlert
            tone="error"
            message="Clients could not be loaded"
            action={<CapiroButton onClick={() => void clients.refetch()}>Retry</CapiroButton>}
          />
        ) : null}
        {view === 'pipeline' ? (
          board && clientId ? (
            <FundingOpportunityPipeline clientId={clientId} />
          ) : (
            <FundingOpportunityInbox
              key={`tracking:${clientId ?? 'all'}`}
              clientId={clientId}
              clientName={clientName}
              onSelectClient={setClient}
              mode="tracking"
            />
          )
        ) : view === 'inbox' ? (
          <FundingOpportunityInbox
            key={`recommended:${clientId ?? 'all'}`}
            clientId={clientId}
            clientName={clientName}
            onSelectClient={setClient}
          />
        ) : (
          <FundingOpportunityExplore clientId={clientId} />
        )}
      </main>
    </div>
  );
}
