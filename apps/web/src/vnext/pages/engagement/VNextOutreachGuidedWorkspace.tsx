import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  FileText,
  Loader2,
  MapPin,
  Sparkles,
  UsersRound,
} from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import type {
  Capability,
  Client,
  ClientAttachment,
  ClientPerson,
} from '../../../pages/clients/clientTypes.js';
import {
  getClientFacilities,
  type ClientFacility,
} from '../../../pages/clients/facilities-api.js';
import {
  getRelevantPesForClient,
  type RelevantPeRow,
} from '../../../pages/clients/relevance-api.js';
import {
  acceptContextCommand,
  addTargetCommand,
  deliveryCommands,
  excludeContextCommand,
  goalCommands,
  sponsorCommand,
  strategyCommands,
  targetCriteriaCommand,
} from '../../../pages/engagement/outreach/v3/commands.js';
import type {
  OutreachV3CampaignSpec,
  OutreachV3Command,
  OutreachV3ContextSelection,
  OutreachV3ResolvedContextRef,
  OutreachV3TargetLocator,
} from '../../../pages/engagement/outreach/v3/contracts.js';
import { safeOutreachV3Error } from '../../../pages/engagement/outreach/v3/outreach-v3-api.js';
import { TargetDirectoryBrowser } from '../../../pages/engagement/outreach/v3/TargetDirectoryBrowser.js';
import { useOutreachV3Session } from '../../../pages/engagement/outreach/v3/useOutreachV3Session.js';
import { startOutreachV3FullGeneration } from './engagement-api.js';
import {
  OUTREACH_FORMAT_OPTIONS,
  contentTemplateById,
  contentTemplateContextSelection,
  contentTemplatesForWorkflow,
  formatContextSelection,
  formatOptionById,
  type OutreachFormatId,
} from './outreach-v3-content-templates.js';
import { SavedTargetListsPanel } from './outreach-v3-saved-target-lists.js';
import type { VNextOutreachOperatorWorkspaceProps } from './VNextOutreachOperatorWorkspace.js';
import {
  CLIENT_PROFILE_CONTEXT_OPTIONS,
  OUTREACH_WORKFLOW_TEMPLATES,
  clientOverviewText,
  clientRecordContextSelection,
  compactLines,
  guidedStepsForWorkflow,
  inferOutreachGuidedStep,
  inferOutreachWorkflowTemplate,
  manualProfileContextSelection,
  programElementContextSelection,
  subjectLineContextSelection,
  targetDisplayName,
  targetNoteContextSelection,
  targetSubtitle,
  workflowCampaignDefaults,
  type ClientProfileContextKey,
  type OutreachGuidedStep,
  type OutreachWorkflowTemplateId,
} from './outreach-v3-guided-workflow.js';
import './outreach-v3-guided-workflow.css';

interface PreparedContextSection {
  key: ClientProfileContextKey;
  label: string;
  count: number;
  preview: string;
  selections: OutreachV3ContextSelection[];
}

const ROUTE_STEP_FOR_GUIDED: Record<OutreachGuidedStep, VNextOutreachOperatorWorkspaceProps['step']> = {
  template: 'goal',
  name: 'goal',
  content_template: 'goal',
  format: 'goal',
  sponsor: 'goal',
  target: 'targets',
  context: 'context',
  review: 'context',
  generating: 'drafts',
};

const SECTION_ICON: Record<ClientProfileContextKey, typeof Building2> = {
  overview: Building2,
  relationships: UsersRound,
  files: FileText,
  program_elements: Sparkles,
  capabilities: CheckCircle2,
  locations: MapPin,
};

const PROFILE_SOURCE_LABELS = new Set(['capiro_client_profile', 'outreach_review_packet']);

function randomRequestKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function allAcceptedContextRefs(
  refs: OutreachV3CampaignSpec['context'] | undefined,
): OutreachV3ResolvedContextRef[] {
  if (!refs) return [];
  return [
    ...refs.requiredPolicyRefs,
    ...refs.writingGuidanceRefs,
    ...refs.campaignFactRefs,
    ...refs.targetSpecificRefs,
    ...refs.groupSafeRefs,
  ];
}

function contextRefsCreatedByReviewPacket(
  controller: ReturnType<typeof useOutreachV3Session>,
): OutreachV3ResolvedContextRef[] {
  const context = controller.session?.spec.context;
  return allAcceptedContextRefs(context).filter((ref) => {
    const label = ref.locator.sourceLabel;
    return typeof label === 'string' && PROFILE_SOURCE_LABELS.has(label);
  });
}

function formatRelationships(rows: ClientPerson[]): string {
  if (!rows.length) return 'No client relationships are currently recorded on the sponsor profile.';
  return rows
    .map((person) =>
      compactLines([
        `Name: ${person.name}`,
        person.title ? `Title: ${person.title}` : null,
        person.role ? `Relationship role: ${person.role}` : null,
        person.email ? `Email: ${person.email}` : null,
        person.phone ? `Phone: ${person.phone}` : null,
        person.lastContact ? `Last contact: ${person.lastContact}` : null,
      ]),
    )
    .join('\n\n');
}

function formatFiles(rows: ClientAttachment[]): string {
  if (!rows.length) return 'No files are currently attached to the sponsor profile.';
  return rows
    .map((file) =>
      compactLines([
        `File: ${file.fileName}`,
        file.folder ? `Folder: ${file.folder}` : null,
        file.contentType ? `Type: ${file.contentType}` : null,
        file.indexedAt ? 'Knowledge status: indexed' : 'Knowledge status: not indexed',
        file.createdAt ? `Added: ${file.createdAt}` : null,
      ]),
    )
    .join('\n\n');
}

function formatProgramElements(rows: RelevantPeRow[]): string {
  if (!rows.length) return 'No relevant program elements are currently linked to the sponsor profile.';
  return rows
    .map((row) =>
      compactLines([
        `${row.peCode}${row.title ? ` — ${row.title}` : ''}`,
        `Relevance score: ${Math.round(row.score * 100)}%`,
        row.paths.length
          ? `Evidence paths: ${row.paths
              .map((path) => `${path.path} (${Math.round(path.score * 100)}%)`)
              .join(', ')}`
          : null,
        row.paths.flatMap((path) => path.evidence).length
          ? `Evidence: ${row.paths.flatMap((path) => path.evidence).slice(0, 8).join(' · ')}`
          : null,
      ]),
    )
    .join('\n\n');
}

function formatCapabilities(rows: Capability[]): string {
  if (!rows.length) return 'No capabilities are currently recorded on the sponsor profile.';
  return rows
    .map((capability) =>
      compactLines([
        `${capability.name} · ${capability.type}`,
        capability.description ? `Description: ${capability.description}` : null,
        capability.sector ? `Sector: ${capability.sector}` : null,
        capability.tags?.length ? `Tags: ${capability.tags.join(', ')}` : null,
        capability.peNumbers?.length
          ? `Program elements: ${capability.peNumbers.join(', ')}`
          : capability.peNumber
            ? `Program element: ${capability.peNumber}`
            : null,
        capability.fundingAskLabel
          ? `Funding ask: ${capability.fundingAskLabel}`
          : capability.fundingAsk != null
            ? `Funding ask: ${capability.fundingAsk}`
            : null,
        capability.justification ? `Justification: ${capability.justification}` : null,
        capability.districtNexus ? `District nexus: ${capability.districtNexus}` : null,
        capability.existingContracts
          ? `Existing contracts: ${capability.existingContracts}`
          : null,
        capability.notes ? `Notes: ${capability.notes}` : null,
      ]),
    )
    .join('\n\n');
}

function formatLocations(rows: ClientFacility[]): string {
  if (!rows.length) return 'No facilities or operating locations are currently recorded.';
  return rows
    .map((facility) =>
      compactLines([
        `Location: ${facility.name}`,
        [facility.addressLine, facility.city, facility.state, facility.zip].filter(Boolean).length
          ? `Address: ${[facility.addressLine, facility.city, facility.state, facility.zip]
              .filter(Boolean)
              .join(', ')}`
          : null,
        facility.congressionalDistrict
          ? `Congressional district: ${facility.state ?? ''}-${facility.congressionalDistrict}`
          : null,
        facility.stateHouseDistrict
          ? `State House district: ${facility.stateHouseDistrict}`
          : null,
        facility.stateSenateDistrict
          ? `State Senate district: ${facility.stateSenateDistrict}`
          : null,
        facility.employeeCount != null ? `Employees: ${facility.employeeCount}` : null,
        facility.notes ? `Notes: ${facility.notes}` : null,
      ]),
    )
    .join('\n\n');
}

async function prepareClientContextSection(input: {
  api: ReturnType<typeof useApi>;
  client: Client;
  key: ClientProfileContextKey;
}): Promise<PreparedContextSection> {
  const { api, client, key } = input;
  const option = CLIENT_PROFILE_CONTEXT_OPTIONS.find((item) => item.key === key)!;

  if (key === 'overview') {
    const text = clientOverviewText(client);
    return {
      key,
      label: option.label,
      count: 1,
      preview: text,
      selections: [
        clientRecordContextSelection(client.id),
        manualProfileContextSelection({ sectionLabel: option.label, text }),
      ],
    };
  }

  if (key === 'relationships') {
    const rows = (
      await api.get<ClientPerson[]>(`/api/clients/${encodeURIComponent(client.id)}/people`)
    ).data;
    const text = formatRelationships(rows);
    return {
      key,
      label: option.label,
      count: rows.length,
      preview: text,
      selections: [manualProfileContextSelection({ sectionLabel: option.label, text })],
    };
  }

  if (key === 'files') {
    const rows = (
      await api.get<ClientAttachment[]>('/api/engagement/attachments', {
        params: { clientId: client.id },
      })
    ).data;
    const text = formatFiles(rows);
    return {
      key,
      label: option.label,
      count: rows.length,
      preview: text,
      // Only metadata is included here. File bodies keep their own document
      // approval/evidence gates and are never silently promoted by this flow.
      selections: [manualProfileContextSelection({ sectionLabel: option.label, text })],
    };
  }

  if (key === 'program_elements') {
    const response = await getRelevantPesForClient(api, client.id, { limit: 25 });
    const rows = response.data;
    const text = formatProgramElements(rows);
    return {
      key,
      label: option.label,
      count: rows.length,
      preview: text,
      selections: [
        manualProfileContextSelection({ sectionLabel: option.label, text }),
        ...rows.map((row) => programElementContextSelection(row.peCode)),
      ],
    };
  }

  if (key === 'capabilities') {
    const rows = (
      await api.get<Capability[]>(`/api/clients/${encodeURIComponent(client.id)}/capabilities`)
    ).data;
    const text = formatCapabilities(rows);
    return {
      key,
      label: option.label,
      count: rows.length,
      preview: text,
      selections: [manualProfileContextSelection({ sectionLabel: option.label, text })],
    };
  }

  const rows = await getClientFacilities(api, client.id);
  const text = formatLocations(rows);
  return {
    key,
    label: option.label,
    count: rows.length,
    preview: text,
    selections: [manualProfileContextSelection({ sectionLabel: option.label, text })],
  };
}

function selectedClient(
  clients: Client[],
  clientId: string | null,
): Client | null {
  return clients.find((client) => client.id === clientId) ?? null;
}

function targetProfileSummary(
  controller: ReturnType<typeof useOutreachV3Session>,
): { title: string; body: string } | null {
  const target = controller.targetProfile?.data?.target;
  if (!target) return null;
  return {
    title: targetDisplayName(target),
    body: targetSubtitle(target) || 'Directory profile',
  };
}

export function VNextOutreachGuidedWorkspace(props: VNextOutreachOperatorWorkspaceProps) {
  const api = useApi();
  const controller = useOutreachV3Session({ sessionId: props.sessionId });
  const session = controller.session;
  const [hydratedSessionId, setHydratedSessionId] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState<OutreachGuidedStep>('template');
  const [templateId, setTemplateId] = useState<OutreachWorkflowTemplateId | null>(null);
  const [campaignName, setCampaignName] = useState('');
  const [customPurpose, setCustomPurpose] = useState('');
  const [contentTemplateId, setContentTemplateId] = useState<string | null>(null);
  const [formatId, setFormatId] = useState<OutreachFormatId>('standard');
  const [sponsorClientId, setSponsorClientId] = useState<string | null>(
    props.selectedClientId,
  );
  const [clientSearch, setClientSearch] = useState('');
  const [selectedContext, setSelectedContext] = useState<Set<ClientProfileContextKey>>(
    () => new Set<ClientProfileContextKey>(['overview']),
  );
  const [preparedContext, setPreparedContext] = useState<PreparedContextSection[]>([]);
  const [personalNotes, setPersonalNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profileLocator, setProfileLocator] = useState<OutreachV3TargetLocator | null>(null);

  useEffect(() => {
    if (!session || hydratedSessionId === session.session.id) return;
    setHydratedSessionId(session.session.id);
    setTemplateId(inferOutreachWorkflowTemplate(session));
    setCampaignName(session.spec.goal.topic ?? session.session.title ?? '');
    setCustomPurpose(
      session.spec.goal.goal && !['Request a meeting', 'Send a client update'].includes(session.spec.goal.goal)
        ? session.spec.goal.goal
        : '',
    );
    setSponsorClientId(
      session.spec.sponsor.kind === 'client'
        ? session.spec.sponsor.clientRefs[0]?.clientId ?? props.selectedClientId
        : props.selectedClientId,
    );
    setActiveStep(inferOutreachGuidedStep(session));
  }, [hydratedSessionId, props.selectedClientId, session]);

  const client = useMemo(
    () => selectedClient(props.clients, sponsorClientId),
    [props.clients, sponsorClientId],
  );
  const filteredClients = useMemo(() => {
    const needle = clientSearch.trim().toLowerCase();
    if (!needle) return props.clients;
    return props.clients.filter((item) =>
      [item.name, item.sectorTag, item.primaryContactName]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [clientSearch, props.clients]);
  const selectedTargets = session?.spec.targeting.selectedTargetRefs ?? [];
  const profileSummary = targetProfileSummary(controller);
  const steps = useMemo(() => guidedStepsForWorkflow(templateId), [templateId]);
  const availableContentTemplates = useMemo(
    () => contentTemplatesForWorkflow(templateId),
    [templateId],
  );
  const progressStep = activeStep === 'generating' ? 'review' : activeStep;
  const currentStepIndex = Math.max(
    0,
    steps.findIndex((item) => item.key === progressStep),
  );
  const previousStepKey = currentStepIndex > 0 ? steps[currentStepIndex - 1]!.key : null;

  const goTo = (step: OutreachGuidedStep) => {
    setError(null);
    setActiveStep(step);
    props.onStepChange(ROUTE_STEP_FOR_GUIDED[step]);
  };

  const saveCampaignName = async () => {
    if (!templateId) {
      setError('Choose a campaign workflow first.');
      return;
    }
    try {
      setBusy(true);
      setError(null);
      const defaults = workflowCampaignDefaults({ templateId, campaignName, customPurpose });
      await controller.applyCommands(goalCommands(defaults.goal));
      goTo(templateId === 'custom' ? 'sponsor' : 'content_template');
    } catch (cause) {
      setError(safeOutreachV3Error(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveSponsor = async () => {
    if (!client) {
      setError('Select one sponsor client.');
      return;
    }
    try {
      setBusy(true);
      setError(null);
      await controller.applyCommands([
        sponsorCommand({ kind: 'client', label: client.name, clientIds: [client.id] }),
        targetCriteriaCommand({
          notes: 'Recipients selected directly from the Capiro Directory for this campaign.',
          relationshipPreference: 'any',
          includeStaff: true,
          includePrincipals: true,
        }),
      ]);
      goTo('target');
    } catch (cause) {
      setError(safeOutreachV3Error(cause));
    } finally {
      setBusy(false);
    }
  };

  const loadReviewPacket = async () => {
    if (!client) {
      setError('Select a sponsor client before loading context.');
      return;
    }
    if (!selectedContext.size) {
      setError('Select at least one client-profile context section.');
      return;
    }
    try {
      setBusy(true);
      setError(null);
      const sections = await Promise.all(
        [...selectedContext].map((key) => prepareClientContextSection({ api, client, key })),
      );
      setPreparedContext(sections);
      goTo('review');
    } catch (cause) {
      setError(`The review packet could not load all selected client context. ${safeOutreachV3Error(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  const generateDrafts = async () => {
    if (!session || !templateId || !client || !campaignName.trim()) {
      setError('The review packet is incomplete. Return to setup and complete every required field.');
      return;
    }
    if (!selectedTargets.length) {
      setError('Select at least one Directory recipient.');
      return;
    }
    if (!preparedContext.length) {
      setError('Reload the selected client context before generating.');
      return;
    }

    try {
      setBusy(true);
      setError(null);
      setActiveStep('generating');
      const defaults = workflowCampaignDefaults({ templateId, campaignName, customPurpose });
      const contextSelections = preparedContext.flatMap((section) => section.selections);
      contextSelections.push(subjectLineContextSelection(campaignName));
      const chosenContentTemplate = contentTemplateById(contentTemplateId);
      if (chosenContentTemplate) {
        contextSelections.push(contentTemplateContextSelection(chosenContentTemplate));
      }
      const chosenFormat = formatOptionById(formatId);
      if (chosenFormat) {
        contextSelections.push(formatContextSelection(chosenFormat));
      }
      for (const target of selectedTargets) {
        const note = targetNoteContextSelection({
          target,
          note: personalNotes[target.targetKey] ?? '',
        });
        if (note) contextSelections.push(note);
      }

      const commands: OutreachV3Command[] = [
        ...deliveryCommands('personalized_separate', 'high'),
        ...strategyCommands(defaults.strategy),
        acceptContextCommand(contextSelections),
      ];
      const priorReviewPacketRefs = contextRefsCreatedByReviewPacket(controller);
      if (priorReviewPacketRefs.length) {
        commands.push(
          excludeContextCommand(
            priorReviewPacketRefs.map((ref) => ({
              contextKey: ref.contextKey,
              reason: 'superseded',
            })),
          ),
        );
      }
      await controller.applyCommands(commands);

      // The user accepted the exact input review packet above. Persist that
      // distinct human gate server-side; do not mislabel unseen model output as
      // a reviewed representative-sample approach.
      await api.post(
        `/api/engagement/outreach-v3/sessions/${encodeURIComponent(session.session.id)}/generation/review-packet-approval`,
        {},
      );
      const generation = await startOutreachV3FullGeneration(
        api,
        session.session.id,
        randomRequestKey('review-packet'),
      );
      if (generation.jobId) {
        window.sessionStorage.setItem(
          `outreach-v3:${session.session.id}:phase1-job`,
          generation.jobId,
        );
      }
      props.onStepChange('drafts');
    } catch (cause) {
      setError(`Draft generation could not start. ${safeOutreachV3Error(cause)}`);
      setActiveStep('review');
      props.onStepChange('context');
    } finally {
      setBusy(false);
    }
  };

  if (controller.isBootstrapping || !session) {
    return (
      <div className="outreach-guided__loading" aria-busy="true">
        <Loader2 size={22} className="outreach-guided__spin" />
        <span>Opening campaign setup…</span>
      </div>
    );
  }

  const workflow = templateId
    ? OUTREACH_WORKFLOW_TEMPLATES.find((item) => item.id === templateId) ?? null
    : null;

  return (
    <section className="outreach-guided">
      <header className="outreach-guided__header">
        <button
          type="button"
          className="outreach-guided__back"
          onClick={() => {
            if (!previousStepKey) props.onExit();
            else goTo(previousStepKey);
          }}
          disabled={busy}
        >
          <ArrowLeft size={16} />
          {previousStepKey ? 'Back' : 'Campaigns'}
        </button>
        <div className="outreach-guided__heading">
          <span>Outreach V3</span>
          <h1>{workflow?.title ?? 'Build a campaign'}</h1>
          <p>One decision at a time. Nothing sends until final preflight and confirmation.</p>
        </div>
        <div className="outreach-guided__safety">
          <CheckCircle2 size={16} />
          Governed generation
        </div>
      </header>

      <nav className="outreach-guided__steps" aria-label="Campaign setup progress">
        {steps.map((item, index) => (
          <div
            key={item.key}
            className="outreach-guided__step"
            data-state={index < currentStepIndex ? 'complete' : index === currentStepIndex ? 'active' : 'upcoming'}
          >
            <span>{index < currentStepIndex ? <Check size={13} /> : index + 1}</span>
            <strong>{item.label}</strong>
          </div>
        ))}
      </nav>

      <main className="outreach-guided__main">
        {error || controller.errorMessage ? (
          <div className="outreach-guided__error" role="alert">
            <AlertTriangle size={17} />
            <span>{error ?? controller.errorMessage}</span>
          </div>
        ) : null}

        {activeStep === 'template' ? (
          <section className="outreach-guided__surface">
            <div className="outreach-guided__surface-heading">
              <span>Start from scratch</span>
              <h2>What kind of campaign are you creating?</h2>
              <p>Choose the workflow. The next screens collect only what that workflow needs.</p>
            </div>
            <div className="outreach-guided__template-grid">
              {OUTREACH_WORKFLOW_TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className="outreach-guided__template"
                  data-selected={templateId === template.id}
                  onClick={() => {
                    if (template.id !== templateId) setContentTemplateId(null);
                    setTemplateId(template.id);
                    goTo('name');
                  }}
                >
                  <span>{template.eyebrow}</span>
                  <strong>{template.title}</strong>
                  <p>{template.description}</p>
                  <ArrowRight size={18} />
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {activeStep === 'name' ? (
          <section className="outreach-guided__surface outreach-guided__surface--narrow">
            <div className="outreach-guided__surface-heading">
              <span>{workflow?.eyebrow}</span>
              <h2>Name the campaign</h2>
              <p>This name becomes the exact subject line shown in the review packet.</p>
            </div>
            <label className="outreach-guided__field">
              <span>Campaign name and subject line</span>
              <input
                autoFocus
                value={campaignName}
                onChange={(event: { target: { value: string } }) => setCampaignName(event.target.value)}
                placeholder={templateId === 'request_meeting' ? 'Meeting request: autonomous systems briefing' : 'August client update'}
                maxLength={240}
              />
            </label>
            {templateId === 'custom' ? (
              <label className="outreach-guided__field">
                <span>What should this campaign accomplish?</span>
                <textarea
                  value={customPurpose}
                  onChange={(event: { target: { value: string } }) => setCustomPurpose(event.target.value)}
                  placeholder="Describe the desired outcome and next action."
                  rows={4}
                />
              </label>
            ) : null}
            <div className="outreach-guided__actions">
              <button type="button" className="outreach-guided__secondary" onClick={() => goTo('template')}>
                Back
              </button>
              <button
                type="button"
                className="outreach-guided__primary"
                disabled={busy || !campaignName.trim() || (templateId === 'custom' && !customPurpose.trim())}
                onClick={() => void saveCampaignName()}
              >
                {busy ? <Loader2 size={16} className="outreach-guided__spin" /> : null}
                {templateId === 'custom' ? 'Continue to sponsor' : 'Continue to template'}
                <ArrowRight size={16} />
              </button>
            </div>
          </section>
        ) : null}

        {activeStep === 'content_template' ? (
          <section className="outreach-guided__surface outreach-guided__surface--wide">
            <div className="outreach-guided__surface-heading">
              <span>{workflow?.eyebrow}</span>
              <h2>Choose a template</h2>
              <p>Pick the structure Meri should follow. Preview a sample before choosing — the sample is a reference for structure and tone only, never data that gets copied into your draft.</p>
            </div>
            <div className="outreach-guided__content-template-grid">
              {availableContentTemplates.map((template) => (
                <div
                  key={template.id}
                  className="outreach-guided__content-template"
                  data-selected={contentTemplateId === template.id}
                >
                  <button
                    type="button"
                    className="outreach-guided__content-template-select"
                    onClick={() => setContentTemplateId(template.id)}
                  >
                    <span>{template.eyebrow}</span>
                    <strong>{template.title}</strong>
                    <p>{template.description}</p>
                    {contentTemplateId === template.id ? (
                      <CheckCircle2 size={18} className="outreach-guided__content-template-check" />
                    ) : null}
                  </button>
                  <details className="outreach-guided__content-template-preview">
                    <summary>Preview sample draft</summary>
                    <strong>{template.sampleSubject}</strong>
                    <pre>{template.sampleBody}</pre>
                  </details>
                </div>
              ))}
            </div>
            <div className="outreach-guided__actions">
              <button type="button" className="outreach-guided__secondary" onClick={() => goTo('name')}>
                Back
              </button>
              <button
                type="button"
                className="outreach-guided__primary"
                disabled={busy || !contentTemplateId}
                onClick={() => goTo('format')}
              >
                Continue to format
                <ArrowRight size={16} />
              </button>
            </div>
          </section>
        ) : null}

        {activeStep === 'format' ? (
          <section className="outreach-guided__surface outreach-guided__surface--narrow">
            <div className="outreach-guided__surface-heading">
              <span>{workflow?.eyebrow}</span>
              <h2>Choose a writing format</h2>
              <p>This is a plain-text writing style — Capiro drafts and sends plain-text email today, not rendered HTML designs.</p>
            </div>
            <div className="outreach-guided__format-grid">
              {OUTREACH_FORMAT_OPTIONS.map((format) => (
                <button
                  key={format.id}
                  type="button"
                  className="outreach-guided__format"
                  data-selected={formatId === format.id}
                  onClick={() => setFormatId(format.id)}
                >
                  <strong>{format.title}</strong>
                  <p>{format.description}</p>
                  {formatId === format.id ? <CheckCircle2 size={18} /> : null}
                </button>
              ))}
            </div>
            <div className="outreach-guided__actions">
              <button
                type="button"
                className="outreach-guided__secondary"
                onClick={() => goTo('content_template')}
              >
                Back
              </button>
              <button type="button" className="outreach-guided__primary" onClick={() => goTo('sponsor')}>
                Continue to sponsor
                <ArrowRight size={16} />
              </button>
            </div>
          </section>
        ) : null}

        {activeStep === 'sponsor' ? (
          <section className="outreach-guided__surface">
            <div className="outreach-guided__surface-heading">
              <span>Campaign sponsor</span>
              <h2>Which client is this campaign for?</h2>
              <p>All available context in this workflow will be scoped to this client.</p>
            </div>
            <label className="outreach-guided__field outreach-guided__field--search">
              <span>Find a client</span>
              <input
                value={clientSearch}
                onChange={(event: { target: { value: string } }) => setClientSearch(event.target.value)}
                placeholder="Search clients"
              />
            </label>
            <div className="outreach-guided__client-grid">
              {filteredClients.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className="outreach-guided__client"
                  data-selected={item.id === sponsorClientId}
                  onClick={() => setSponsorClientId(item.id)}
                >
                  <span className="outreach-guided__client-logo">
                    {item.logoUrl ? <img src={item.logoUrl} alt="" /> : <Building2 size={19} />}
                  </span>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.sectorTag ?? item.primaryContactName ?? 'Client profile'}</small>
                  </span>
                  {item.id === sponsorClientId ? <CheckCircle2 size={18} /> : null}
                </button>
              ))}
              {!filteredClients.length ? (
                <div className="outreach-guided__empty">No client matches that search.</div>
              ) : null}
            </div>
            <div className="outreach-guided__actions">
              <button
                type="button"
                className="outreach-guided__secondary"
                onClick={() => goTo(previousStepKey ?? 'name')}
              >
                Back
              </button>
              <button
                type="button"
                className="outreach-guided__primary"
                disabled={busy || !client}
                onClick={() => void saveSponsor()}
              >
                {busy ? <Loader2 size={16} className="outreach-guided__spin" /> : null}
                Continue to people
                <ArrowRight size={16} />
              </button>
            </div>
          </section>
        ) : null}

        {activeStep === 'target' ? (
          <section className="outreach-guided__surface outreach-guided__surface--wide">
            <div className="outreach-guided__surface-heading">
              <span>Directory targets</span>
              <h2>Who should receive this campaign?</h2>
              <p>Select one or more people from the Directory. Every selected person gets a separate destination draft.</p>
            </div>
            <SavedTargetListsPanel
              selected={selectedTargets}
              busy={controller.applyingCommands || busy}
              onAddLocators={(locators) => {
                void controller.applyCommands(locators.map((locator) => addTargetCommand(locator)));
              }}
            />
            <TargetDirectoryBrowser
              selected={selectedTargets}
              busy={controller.applyingCommands || busy}
              applyCommands={controller.applyCommands}
              onProfile={(locator) => {
                setProfileLocator(locator);
                void controller.getTargetProfile(locator).catch(() => undefined);
              }}
            />
            {profileLocator ? (
              <aside className="outreach-guided__profile" aria-live="polite">
                <button type="button" onClick={() => setProfileLocator(null)} aria-label="Close profile">×</button>
                {controller.targetProfilePending ? (
                  <span><Loader2 size={15} className="outreach-guided__spin" /> Loading profile…</span>
                ) : profileSummary ? (
                  <>
                    <strong>{profileSummary.title}</strong>
                    <p>{profileSummary.body}</p>
                  </>
                ) : (
                  <p>{controller.targetSearchError ?? 'Profile details are unavailable.'}</p>
                )}
              </aside>
            ) : null}
            <div className="outreach-guided__selection-receipt">
              <strong>{selectedTargets.length} selected</strong>
              <span>{selectedTargets.slice(0, 4).map(targetDisplayName).join(', ') || 'Choose recipients above.'}</span>
            </div>
            <div className="outreach-guided__actions">
              <button type="button" className="outreach-guided__secondary" onClick={() => goTo('sponsor')}>
                Back
              </button>
              <button
                type="button"
                className="outreach-guided__primary"
                disabled={busy || controller.applyingCommands || !selectedTargets.length}
                onClick={() => goTo('context')}
              >
                Continue to context
                <ArrowRight size={16} />
              </button>
            </div>
          </section>
        ) : null}

        {activeStep === 'context' ? (
          <section className="outreach-guided__surface">
            <div className="outreach-guided__surface-heading">
              <span>{client?.name ?? 'Sponsor client'}</span>
              <h2>Choose client context</h2>
              <p>Only these client-profile sections will be packaged for generation.</p>
            </div>
            <div className="outreach-guided__context-grid">
              {CLIENT_PROFILE_CONTEXT_OPTIONS.map((option) => {
                const Icon = SECTION_ICON[option.key];
                const checked = selectedContext.has(option.key);
                return (
                  <label key={option.key} className="outreach-guided__context" data-selected={checked}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        setSelectedContext((current) => {
                          const next = new Set(current);
                          if (next.has(option.key)) next.delete(option.key);
                          else next.add(option.key);
                          return next;
                        });
                      }}
                    />
                    <span className="outreach-guided__context-icon"><Icon size={18} /></span>
                    <span>
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </span>
                    <CheckCircle2 size={18} />
                  </label>
                );
              })}
            </div>
            <div className="outreach-guided__context-note">
              <CheckCircle2 size={16} />
              Files contributes profile file metadata only. Document bodies keep their normal evidence and approval controls.
            </div>
            <div className="outreach-guided__actions">
              <button type="button" className="outreach-guided__secondary" onClick={() => goTo('target')}>
                Back
              </button>
              <button
                type="button"
                className="outreach-guided__primary"
                disabled={busy || !selectedContext.size}
                onClick={() => void loadReviewPacket()}
              >
                {busy ? <Loader2 size={16} className="outreach-guided__spin" /> : null}
                Build review packet
                <ArrowRight size={16} />
              </button>
            </div>
          </section>
        ) : null}

        {activeStep === 'review' || activeStep === 'generating' ? (
          <section className="outreach-guided__surface outreach-guided__surface--wide">
            <div className="outreach-guided__surface-heading outreach-guided__surface-heading--split">
              <div>
                <span>Review packet</span>
                <h2>Confirm exactly what Meri will use</h2>
                <p>Add an optional personal note beside each attendee before generation.</p>
              </div>
              <span className="outreach-guided__review-status">
                <CheckCircle2 size={16} />
                No send authorization
              </span>
            </div>

            {!preparedContext.length ? (
              <div className="outreach-guided__packet-missing">
                <AlertTriangle size={18} />
                <div>
                  <strong>Reload the client context snapshot</strong>
                  <p>The campaign state is saved, but the review display needs a fresh profile snapshot.</p>
                </div>
                <button type="button" onClick={() => void loadReviewPacket()} disabled={busy}>
                  {busy ? <Loader2 size={15} className="outreach-guided__spin" /> : null}
                  Load packet
                </button>
              </div>
            ) : null}

            <div className="outreach-guided__packet-summary">
              <div>
                <span>Subject line</span>
                <strong>{campaignName}</strong>
              </div>
              <div>
                <span>Sponsor</span>
                <strong>{client?.name}</strong>
              </div>
              <div>
                <span>Destinations</span>
                <strong>{selectedTargets.length}</strong>
              </div>
              <div>
                <span>Context sections</span>
                <strong>{preparedContext.length}</strong>
              </div>
            </div>

            <div className="outreach-guided__review-layout">
              <section className="outreach-guided__review-panel">
                <div className="outreach-guided__review-panel-heading">
                  <span>People selected</span>
                  <strong>{selectedTargets.length} separate drafts</strong>
                </div>
                <div className="outreach-guided__attendees">
                  {selectedTargets.map((target) => (
                    <label key={target.targetKey} className="outreach-guided__attendee">
                      <span className="outreach-guided__avatar">{targetDisplayName(target).slice(0, 1).toUpperCase()}</span>
                      <span className="outreach-guided__attendee-copy">
                        <strong>{targetDisplayName(target)}</strong>
                        <small>{targetSubtitle(target) || 'Directory contact'}</small>
                        <textarea
                          rows={3}
                          value={personalNotes[target.targetKey] ?? ''}
                          onChange={(event: { target: { value: string } }) =>
                            setPersonalNotes((current) => ({
                              ...current,
                              [target.targetKey]: event.target.value,
                            }))
                          }
                          placeholder="Optional personal note for this attendee only"
                          disabled={busy}
                        />
                      </span>
                    </label>
                  ))}
                </div>
              </section>

              <section className="outreach-guided__review-panel">
                <div className="outreach-guided__review-panel-heading">
                  <span>Context selected</span>
                  <strong>{preparedContext.reduce((total, section) => total + section.count, 0)} records</strong>
                </div>
                <div className="outreach-guided__context-receipts">
                  {preparedContext.map((section) => {
                    const Icon = SECTION_ICON[section.key];
                    return (
                      <details key={section.key} className="outreach-guided__context-receipt">
                        <summary>
                          <span><Icon size={17} /></span>
                          <strong>{section.label}</strong>
                          <small>{section.count} {section.count === 1 ? 'record' : 'records'}</small>
                        </summary>
                        <pre>{section.preview}</pre>
                      </details>
                    );
                  })}
                </div>
              </section>
            </div>

            <div className="outreach-guided__review-disclosure">
              Accepting this packet authorizes draft generation from this exact setup. It does not approve final draft versions, test sends, or real sending.
            </div>
            <div className="outreach-guided__actions">
              <button
                type="button"
                className="outreach-guided__secondary"
                onClick={() => goTo('context')}
                disabled={busy}
              >
                Change context
              </button>
              <button
                type="button"
                className="outreach-guided__primary outreach-guided__primary--generate"
                disabled={busy || !preparedContext.length}
                onClick={() => void generateDrafts()}
              >
                {busy ? <Loader2 size={16} className="outreach-guided__spin" /> : <Sparkles size={16} />}
                {busy ? 'Generating drafts…' : `Accept and generate ${selectedTargets.length} drafts`}
              </button>
            </div>
          </section>
        ) : null}
      </main>
    </section>
  );
}
