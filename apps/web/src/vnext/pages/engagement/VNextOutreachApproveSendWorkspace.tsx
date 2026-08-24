import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Loader2,
  MoreHorizontal,
  ShieldCheck,
} from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import type { OutreachV3Proposal } from '../../../pages/engagement/outreach/v3/contracts.js';
import { useOutreachV3Session } from '../../../pages/engagement/outreach/v3/useOutreachV3Session.js';
import {
  approveOutreachV3Approach,
  approveOutreachV3Draft,
  cancelOutreachV3GenerationJob,
  cancelOutreachV3SendIntent,
  classifyOutreachV3FullGenerationResult,
  createOutreachV3SendIntent,
  createOutreachV3TestSend,
  generateOutreachV3Samples,
  getLatestOutreachV3FullGenerationJob,
  getOutreachV3ApproachApproval,
  getOutreachV3GenerationJob,
  getOutreachV3GenerationPlan,
  getOutreachV3SendIntent,
  getOutreachV3SendSettings,
  listOutreachAttachments,
  listOutreachReplyCandidates,
  listOutreachV3Drafts,
  outreachV3FullGenerationRequestKey,
  proposeOutreachReplyLearning,
  refineOutreachV3Draft,
  refreshOutreachV3SendIntent,
  retryOutreachV3GenerationItem,
  reviseOutreachV3Draft,
  runOutreachV3Preflight,
  saveOutreachV3SendSettings,
  startOutreachV3FullGeneration,
  uploadOutreachAttachment,
  type OutreachAttachment,
  type OutreachV3DraftArtifact,
  type OutreachV3DraftVersion,
  type OutreachV3PreflightInput,
  type OutreachV3ServerPreflight,
} from './engagement-api.js';
import {
  describeOutreachProposal,
  outreachStepForStage,
  type VNextOutreachOperatorWorkspaceProps,
} from './VNextOutreachOperatorWorkspace.js';
import {
  approvalCount,
  deriveOutreachPhase1View,
  isGenerationTerminal,
  isSendTerminal,
} from './outreach-v3-phase1-model.js';
import {
  type DraftDiff,
  DraftEditDialog,
  EmptyState,
  type IntegrationConnection,
  type MeriReceipt,
  TERMINAL_GENERATION,
  TERMINAL_SEND,
  campaignTitle,
  deliveryLabel,
  errorText,
  formatClock,
  phaseLabel,
  providerLabel,
  randomKey,
  sessionStorageGet,
  sessionStorageSet,
} from './outreach-v3-phase1-shared.js';
import { ApproachScreen } from './outreach-v3-phase1-approach.js';
import { GenerationScreen } from './outreach-v3-phase1-draft-card.js';
import { DraftReviewScreen } from './outreach-v3-phase1-draft-review.js';
import { SendScreen } from './outreach-v3-phase1-send-setup.js';
import {
  ResultsScreen,
  SendConfirmDialog,
  SendingScreen,
} from './outreach-v3-phase1-results.js';
import { MeriRail } from './outreach-v3-phase1-meri.js';
import './outreach-v3-phase1.css';
import './outreach-v3-templates.css';

export function VNextOutreachApproveSendWorkspace({
  sessionId: routeSessionId,
  selectedClientId,
  integrations,
  step,
  onStepChange,
  onExit,
}: VNextOutreachOperatorWorkspaceProps) {
  const api = useApi();
  const qc = useQueryClient();
  const controller = useOutreachV3Session({ sessionId: routeSessionId });
  const sessionId = controller.sessionId || routeSessionId;
  const session = controller.session;
  const jobStorageKey = `outreach-v3:${sessionId}:phase1-job`;
  const intentStorageKey = `outreach-v3:${sessionId}:phase1-intent`;
  const sendKeyStorageKey = `outreach-v3:${sessionId}:phase1-send-request`;
  const [jobId, setJobId] = useState<string | null>(() => sessionStorageGet(jobStorageKey));
  const [intentId, setIntentId] = useState<string | null>(() => sessionStorageGet(intentStorageKey));
  const [sendRequestKey] = useState(() => sessionStorageGet(sendKeyStorageKey) || randomKey('send'));
  const [preflight, setPreflight] = useState<OutreachV3ServerPreflight | null>(null);
  const [preflightAt, setPreflightAt] = useState<Date | null>(null);
  const [editingDraft, setEditingDraft] = useState<OutreachV3DraftArtifact | null>(null);
  const [diffs, setDiffs] = useState<Map<string, DraftDiff>>(new Map());
  const [confirmInput, setConfirmInput] = useState<OutreachV3PreflightInput | null>(null);
  const [meriCollapsed, setMeriCollapsed] = useState(false);
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<MeriReceipt[]>([]);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [uploadedAttachments, setUploadedAttachments] = useState<OutreachAttachment[]>([]);

  useEffect(() => sessionStorageSet(jobStorageKey, jobId), [jobId, jobStorageKey]);
  useEffect(() => sessionStorageSet(intentStorageKey, intentId), [intentId, intentStorageKey]);
  useEffect(() => sessionStorageSet(sendKeyStorageKey, sendRequestKey), [sendKeyStorageKey, sendRequestKey]);

  // Server-truth recovery (section 8): sessionStorage seeds `jobId` above as
  // a same-tab cache/optimization only. The server's "latest job for this
  // session" is authoritative on MOUNT — a refresh, a browser navigation
  // away-and-back, a lost tab, or opening the campaign on a different device
  // must all still resume the real active/completed job rather than showing
  // an empty Drafts screen. Reconciliation runs exactly once per sessionId
  // (guarded by the ref below) so it seeds/corrects the initial state without
  // fighting a job this component itself just started via startFullGeneration
  // — that job legitimately doesn't exist in the "latest" snapshot fetched
  // moments earlier.
  const latestJobQuery = useQuery({
    queryKey: ['outreach-v3', 'latest-generation-job', sessionId],
    queryFn: () => getLatestOutreachV3FullGenerationJob(api, sessionId),
    enabled: Boolean(sessionId),
    retry: false,
  });
  const reconciledForSession = useRef<string | null>(null);
  useEffect(() => {
    if (!latestJobQuery.isSuccess || reconciledForSession.current === sessionId) return;
    reconciledForSession.current = sessionId;
    const latest = latestJobQuery.data;
    if (!latest) {
      // No job has ever been created server-side. Do not trust a stale
      // sessionStorage id pointing at a job from a different session/browser
      // profile — server truth here is "no job", full stop.
      setJobId(null);
      return;
    }
    setJobId(latest.id);
  }, [latestJobQuery.isSuccess, latestJobQuery.data, sessionId]);

  const planQuery = useQuery({
    queryKey: ['outreach-v3', 'generation-plan', sessionId],
    queryFn: () => getOutreachV3GenerationPlan(api, sessionId),
    enabled: Boolean(sessionId && session && controller.stage === 'ready_for_generation'),
    retry: false,
  });
  const draftsQuery = useQuery({
    queryKey: ['outreach-v3', 'drafts', sessionId],
    queryFn: () => listOutreachV3Drafts(api, sessionId),
    enabled: Boolean(sessionId),
    retry: false,
  });
  const approachQuery = useQuery({
    queryKey: ['outreach-v3', 'approach-approval', sessionId],
    queryFn: () => getOutreachV3ApproachApproval(api, sessionId),
    enabled: Boolean(sessionId && planQuery.data?.eligible),
    retry: false,
  });
  const jobQuery = useQuery({
    queryKey: ['outreach-v3', 'generation-job', sessionId, jobId],
    queryFn: () => getOutreachV3GenerationJob(api, sessionId, jobId!),
    enabled: Boolean(jobId),
    refetchInterval: (query) => TERMINAL_GENERATION.includes(String(query.state.data?.status ?? '').toLowerCase()) ? false : 2_000,
    retry: false,
  });
  const settingsQuery = useQuery({
    queryKey: ['outreach-v3', 'send-settings', sessionId],
    queryFn: () => getOutreachV3SendSettings(api, sessionId),
    enabled: Boolean(sessionId),
    retry: false,
  });
  const attachmentsQuery = useQuery({
    queryKey: ['outreach-v3', 'attachments', selectedClientId ?? null],
    queryFn: () => listOutreachAttachments(api, selectedClientId),
    enabled: Boolean(sessionId),
    staleTime: 30_000,
  });
  const intentQuery = useQuery({
    queryKey: ['outreach-v3', 'send-intent', sessionId, intentId],
    queryFn: () => getOutreachV3SendIntent(api, sessionId, intentId!),
    enabled: Boolean(intentId),
    refetchInterval: (query) => TERMINAL_SEND.includes(String(query.state.data?.status ?? '').toLowerCase()) ? false : 2_000,
    retry: false,
  });
  const repliesQuery = useQuery({
    queryKey: ['outreach-v3', 'reply-candidates', intentId],
    queryFn: () => listOutreachReplyCandidates(api, intentId!),
    enabled: Boolean(intentId && intentQuery.data && isSendTerminal(intentQuery.data.status) && !intentQuery.data.testMode),
    staleTime: 15_000,
  });

  useEffect(() => {
    if (!jobQuery.data || !isGenerationTerminal(jobQuery.data.status)) return;
    void qc.invalidateQueries({ queryKey: ['outreach-v3', 'drafts', sessionId] });
  }, [jobQuery.data, qc, sessionId]);

  const invalidateDraftState = async () => {
    setPreflight(null);
    setPreflightAt(null);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['outreach-v3', 'drafts', sessionId] }),
      qc.invalidateQueries({ queryKey: ['outreach-v3', 'approach-approval', sessionId] }),
    ]);
  };

  const sampleMutation = useMutation({
    mutationFn: () => generateOutreachV3Samples(api, sessionId),
    onSuccess: invalidateDraftState,
    onError: (error) => setOperationError(errorText(error, 'Samples could not be generated.')),
  });
  const fullGeneration = useMutation({
    mutationFn: (requestKey: string) => startOutreachV3FullGeneration(api, sessionId, requestKey),
    onSuccess: (result) => {
      const outcome = classifyOutreachV3FullGenerationResult(result);
      if (outcome.kind === 'job') {
        setJobId(outcome.jobId);
        return;
      }
      if (outcome.kind === 'complete') {
        void qc.invalidateQueries({ queryKey: ['outreach-v3', 'drafts', sessionId] });
        return;
      }
      // Neither a job nor a completed result — never silently treat this as
      // success. Surface it exactly like any other failed-to-start case.
      setOperationError(
        'Generation did not start. The server returned neither a generation job nor a completed result.',
      );
    },
    onError: (error) => setOperationError(errorText(error, 'Full generation could not start.')),
  });
  const startFullGeneration = () => {
    if (!approach?.approvalHash) {
      setOperationError('Approve the current approach before starting full generation.');
      return;
    }
    fullGeneration.mutate(outreachV3FullGenerationRequestKey(sessionId, approach.approvalHash));
  };
  const approachMutation = useMutation({
    mutationFn: (versionIds: string[]) => approveOutreachV3Approach(api, sessionId, versionIds),
    onSuccess: async (result) => {
      await qc.invalidateQueries({ queryKey: ['outreach-v3', 'approach-approval', sessionId] });
      fullGeneration.mutate(
        outreachV3FullGenerationRequestKey(sessionId, result.approval.approvalHash),
      );
    },
    onError: (error) => setOperationError(errorText(error, 'The approach could not be approved.')),
  });
  const reviseMutation = useMutation({
    mutationFn: ({ draft, subject, body }: { draft: OutreachV3DraftArtifact; subject: string; body: string }) => reviseOutreachV3Draft(api, sessionId, draft.id, {
      baseVersionId: draft.current!.id,
      subject,
      body,
      editKind: 'manual',
    }),
    onSuccess: async (version, variables) => {
      if (variables.draft.current) setDiffs((current) => new Map(current).set(variables.draft.id, { from: variables.draft.current!, to: version }));
      setEditingDraft(null);
      await invalidateDraftState();
    },
    onError: (error) => setOperationError(errorText(error, 'The new draft version could not be saved.')),
  });
  const refineMutation = useMutation({
    mutationFn: ({ draft, instruction }: { draft: OutreachV3DraftArtifact; instruction: string }) => refineOutreachV3Draft(api, sessionId, draft.id, {
      baseVersionId: draft.current!.id,
      instruction,
    }),
    onSuccess: async (version, variables) => {
      if (variables.draft.current) setDiffs((current) => new Map(current).set(variables.draft.id, { from: variables.draft.current!, to: version }));
      await invalidateDraftState();
    },
    onError: (error) => setOperationError(errorText(error, 'Meri could not create the new draft version.')),
  });
  const bulkRefineMutation = useMutation({
    mutationFn: async ({ drafts, instruction }: { drafts: OutreachV3DraftArtifact[]; instruction: string }) => {
      const results: Array<{ draft: OutreachV3DraftArtifact; version: OutreachV3DraftVersion }> = [];
      for (const draft of drafts) {
        if (!draft.current) continue;
        const version = await refineOutreachV3Draft(api, sessionId, draft.id, { baseVersionId: draft.current.id, instruction });
        results.push({ draft, version });
      }
      return results;
    },
    onSuccess: async (results) => {
      setDiffs((current) => {
        const next = new Map(current);
        for (const result of results) if (result.draft.current) next.set(result.draft.id, { from: result.draft.current, to: result.version });
        return next;
      });
      await invalidateDraftState();
    },
    onError: (error) => setOperationError(errorText(error, 'One or more draft revisions failed.')),
  });
  const approveMutation = useMutation({
    mutationFn: (versionId: string) => approveOutreachV3Draft(api, sessionId, versionId),
    onSuccess: async () => {
      setPreflight(null);
      await qc.invalidateQueries({ queryKey: ['outreach-v3', 'drafts', sessionId] });
    },
    onError: (error) => setOperationError(errorText(error, 'The exact version could not be approved.')),
  });
  const approveManyMutation = useMutation({
    mutationFn: async (drafts: OutreachV3DraftArtifact[]) => {
      for (const draft of drafts) {
        if (!draft.current || draft.current.approvalStatus === 'approved') continue;
        await approveOutreachV3Draft(api, sessionId, draft.current.id);
      }
    },
    onSuccess: async () => {
      setPreflight(null);
      await qc.invalidateQueries({ queryKey: ['outreach-v3', 'drafts', sessionId] });
    },
    onError: (error) => setOperationError(errorText(error, 'Not every selected version could be approved.')),
  });
  const saveSettingsMutation = useMutation({
    mutationFn: (input: { senderConnectionId: string; appendSignature: boolean; attachmentIds: string[] }) => saveOutreachV3SendSettings(api, sessionId, input),
    onSuccess: async () => {
      setPreflight(null);
      setPreflightAt(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['outreach-v3', 'send-settings', sessionId] }),
        qc.invalidateQueries({ queryKey: ['outreach-v3', 'drafts', sessionId] }),
      ]);
    },
    onError: (error) => setOperationError(errorText(error, 'Sending identity could not be saved.')),
  });
  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadOutreachAttachment(api, file, selectedClientId),
    onSuccess: (attachment) => {
      setUploadedAttachments((current) => [...current.filter((item) => item.id !== attachment.id), attachment]);
      void qc.invalidateQueries({ queryKey: ['outreach-v3', 'attachments', selectedClientId ?? null] });
    },
    onError: (error) => setOperationError(errorText(error, 'The attachment could not be uploaded.')),
  });
  const preflightMutation = useMutation({
    mutationFn: (input: OutreachV3PreflightInput) => runOutreachV3Preflight(api, sessionId, input),
    onSuccess: (value) => {
      setPreflight(value);
      setPreflightAt(new Date());
    },
    onError: (error) => setOperationError(errorText(error, 'Preflight could not complete.')),
  });
  const testSendMutation = useMutation({
    mutationFn: ({ generationKey, input }: { generationKey: string; input: OutreachV3PreflightInput }) => createOutreachV3TestSend(api, sessionId, {
      ...input,
      requestKey: randomKey('test'),
      testGenerationKey: generationKey,
    }),
    onError: (error) => setOperationError(errorText(error, 'The test send could not be created.')),
  });
  const realSendMutation = useMutation({
    mutationFn: (input: OutreachV3PreflightInput) => createOutreachV3SendIntent(api, sessionId, { ...input, requestKey: sendRequestKey }),
    onSuccess: (result) => {
      setIntentId(result.intentId);
      setConfirmInput(null);
    },
    onError: (error) => setOperationError(errorText(error, 'The send intent could not be created.')),
  });
  const refreshIntentMutation = useMutation({
    mutationFn: () => refreshOutreachV3SendIntent(api, sessionId, intentId!),
    onSuccess: (value) => qc.setQueryData(['outreach-v3', 'send-intent', sessionId, intentId], value),
    onError: (error) => setOperationError(errorText(error, 'Provider state could not be refreshed.')),
  });
  const cancelIntentMutation = useMutation({
    mutationFn: () => cancelOutreachV3SendIntent(api, sessionId, intentId!),
    onSuccess: (value) => qc.setQueryData(['outreach-v3', 'send-intent', sessionId, intentId], value),
    onError: (error) => setOperationError(errorText(error, 'The remaining send could not be stopped.')),
  });
  const learningMutation = useMutation({
    mutationFn: ({ replyId, learning }: { replyId: string; learning: string }) => proposeOutreachReplyLearning(api, { sendIntentId: intentId!, mailMessageId: replyId, learning }),
    onError: (error) => setOperationError(errorText(error, 'The memory proposal could not be submitted.')),
  });

  const plan = planQuery.data ?? null;
  const drafts = draftsQuery.data ?? [];
  const approach = approachQuery.data ?? null;
  const job = jobQuery.data ?? null;
  const intent = intentQuery.data ?? null;
  const view = deriveOutreachPhase1View({ step: step as 'drafts' | 'send', plan, drafts, approach, job, intent });
  const sampleKeys = new Set(plan?.representativeSampleKeys ?? []);
  const sampleDrafts = drafts.filter((draft) => sampleKeys.has(draft.generationKey));
  const sampleVersionIds = sampleDrafts.map((draft) => draft.current?.id).filter((id): id is string => Boolean(id));
  const mergedAttachments = [...(attachmentsQuery.data ?? []), ...uploadedAttachments].filter((attachment, index, all) => all.findIndex((value) => value.id === attachment.id) === index);
  const selectedConnection = integrations.find((connection) => connection.id === settingsQuery.data?.senderConnectionId) ?? null;
  const approved = approvalCount(drafts);
  const held = preflight?.excludedGenerationKeys.length ?? 0;

  const applyProposal = async (proposal: OutreachV3Proposal) => {
    const currentSession = controller.session;
    if (!currentSession) return;
    const preview = describeOutreachProposal(proposal, currentSession.spec, currentSession.currentStateVersion);
    setBusyProposalId(proposal.id);
    setProposalError(null);
    try {
      await controller.applyProposal(proposal);
      setReceipts((current) => [{
        id: `${proposal.id}-${Date.now()}`,
        title: preview.title,
        body: preview.after.join(' · '),
        version: `Applied at ${formatClock(new Date())}`,
        safeToReverse: false,
      }, ...current].slice(0, 5));
      onStepChange(preview.step);
    } catch (error) {
      setProposalError(errorText(error, 'The proposal could not be applied.'));
    } finally {
      setBusyProposalId(null);
    }
  };

  const discardProposal = async (proposal: OutreachV3Proposal) => {
    setBusyProposalId(proposal.id);
    setProposalError(null);
    try {
      await controller.rejectProposal(proposal);
    } catch (error) {
      setProposalError(errorText(error, 'The proposal could not be discarded.'));
    } finally {
      setBusyProposalId(null);
    }
  };

  const prepareReversal = (receipt: MeriReceipt) => {
    void controller.sendTurn(
      receipt.safeToReverse
        ? `Prepare a governed reversal for this change: ${receipt.title}. Show me the before and after state before applying it.`
        : `The campaign changed after this action. Prepare a safe reversal proposal for: ${receipt.title}. Do not apply it automatically.`,
    );
  };

  if (controller.isBootstrapping || draftsQuery.isLoading) {
    return <div className="ov3p1-loading"><Loader2 className="ov3p1-spin" size={20} /><span>Loading the exact campaign state…</span></div>;
  }
  if (!session || !sessionId) {
    return <div className="ov3p1-error-page"><AlertTriangle size={22} /><h2>This campaign could not be opened</h2><p>{controller.errorMessage || 'The canonical session is unavailable.'}</p><button type="button" className="ov3p1-button is-secondary" onClick={onExit}>Back to campaigns</button></div>;
  }
  // Section 12 of the reliability repair: a completed/partial generation job
  // with a failed drafts fetch must be distinguishable from generation
  // itself having failed, and must be safely retryable — never silently
  // falling back to an empty draft list, which would otherwise read as
  // "generation is still running" forever (deriveOutreachPhase1View treats
  // drafts.length < expected as 'generating' when the job is terminal).
  if (draftsQuery.isError && job && isGenerationTerminal(job.status)) {
    return (
      <div className="ov3p1-error-page">
        <AlertTriangle size={22} />
        <h2>Generation finished, but drafts could not be loaded</h2>
        <p>
          {errorText(
            draftsQuery.error,
            'The generated drafts could not be retrieved from the server. Generation itself succeeded — this is a retrieval problem, not a generation failure.',
          )}
        </p>
        <button type="button" className="ov3p1-button is-primary" onClick={() => draftsQuery.refetch()}>
          Retry loading drafts
        </button>
      </div>
    );
  }

  const renderMain = () => {
    if (controller.stage !== 'ready_for_generation' && step === 'drafts') {
      return <div className="ov3p1-content ov3p1-content--narrow"><EmptyState icon={<AlertTriangle size={24} />} title="The plan still needs a decision" body="Return to Plan and finish the open goal, audience, delivery, context or voice decision before samples are written." action={<button type="button" className="ov3p1-button is-primary" onClick={() => onStepChange(outreachStepForStage(controller.stage))}>Return to Plan</button>} /></div>;
    }
    if (view === 'approach-start' || view === 'approach-review') {
      return <ApproachScreen plan={plan} drafts={drafts} generationBusy={sampleMutation.isPending} approvalBusy={approachMutation.isPending || fullGeneration.isPending} refinementBusy={bulkRefineMutation.isPending} error={operationError} onGenerateSamples={() => { setOperationError(null); sampleMutation.mutate(); }} onApprove={() => approachMutation.mutate(sampleVersionIds)} onEdit={setEditingDraft} onRegenerate={(draft) => draft.current && refineMutation.mutate({ draft, instruction: 'Regenerate this representative sample from the approved campaign plan, preserving only grounded facts.' })} onRefineAll={(instruction) => bulkRefineMutation.mutate({ drafts: sampleDrafts, instruction })} />;
    }
    if (view === 'generating') {
      return <GenerationScreen plan={plan} drafts={drafts} job={job} busy={fullGeneration.isPending} error={operationError} onStart={startFullGeneration} onRetry={(itemId) => jobId && retryOutreachV3GenerationItem(api, sessionId, jobId, itemId).then(() => jobQuery.refetch()).catch((error) => setOperationError(errorText(error, 'Retry failed.')))} onCancel={() => jobId && cancelOutreachV3GenerationJob(api, sessionId, jobId).then(() => jobQuery.refetch()).catch((error) => setOperationError(errorText(error, 'Generation could not be stopped.')))} />;
    }
    if (view === 'draft-review') {
      return <DraftReviewScreen plan={plan} drafts={drafts} busy={approveMutation.isPending || approveManyMutation.isPending || bulkRefineMutation.isPending} refineBusyId={refineMutation.isPending ? refineMutation.variables?.draft.id ?? null : null} diffs={diffs} error={operationError} onApprove={(draft) => draft.current && approveMutation.mutate(draft.current.id)} onApproveMany={(values) => approveManyMutation.mutate(values)} onRefine={(draft, instruction) => draft.current && refineMutation.mutate({ draft, instruction })} onRefineMany={(values, instruction) => bulkRefineMutation.mutate({ drafts: values, instruction })} onRegenerateMany={(values) => bulkRefineMutation.mutate({ drafts: values, instruction: 'Regenerate these drafts from the approved approach and current governed context. Preserve the campaign ask and do not add unsupported claims.' })} onEdit={setEditingDraft} onGoSend={() => onStepChange('send')} />;
    }
    if (view === 'send') {
      return <SendScreen sessionId={sessionId} sessionClientId={selectedClientId} plan={plan} drafts={drafts} integrations={integrations as IntegrationConnection[]} settings={settingsQuery.data ?? null} attachments={mergedAttachments} preflight={preflight} preflightAt={preflightAt} settingsBusy={saveSettingsMutation.isPending} preflightBusy={preflightMutation.isPending} testBusy={testSendMutation.isPending} testSucceeded={Boolean(testSendMutation.data)} sendBusy={realSendMutation.isPending} error={operationError} onSaveSettings={(input) => saveSettingsMutation.mutate(input)} onUpload={(file) => uploadMutation.mutate(file)} onRunPreflight={(input) => preflightMutation.mutate(input)} onTestSend={(generationKey, input) => testSendMutation.mutate({ generationKey, input })} onOpenConfirm={setConfirmInput} onGoDrafts={() => onStepChange('drafts')} />;
    }
    if (view === 'sending' && intent) {
      return <SendingScreen intent={intent} plan={plan} drafts={drafts} cancelBusy={cancelIntentMutation.isPending} error={operationError} onCancel={() => cancelIntentMutation.mutate()} onRefresh={() => refreshIntentMutation.mutate()} />;
    }
    if (view === 'results' && intent) {
      return <ResultsScreen sessionId={sessionId} intent={intent} plan={plan} drafts={drafts} replies={repliesQuery.data ?? []} learningBusy={learningMutation.isPending} learningResult={Boolean(learningMutation.data)} error={operationError} onRefresh={() => refreshIntentMutation.mutate()} onOpenDraft={() => onStepChange('drafts')} onProposeLearning={(replyId, learning) => learningMutation.mutate({ replyId, learning })} />;
    }
    return null;
  };

  return (
    <div className="ov3p1-shell" data-view={view} data-meri-collapsed={meriCollapsed || undefined}>
      <main className="ov3p1-main">
        <header className="ov3p1-campaign-header">
          <button type="button" onClick={onExit}><ArrowLeft size={15} /> Outreach</button>
          <div>
            <h1>{campaignTitle(session)}</h1>
            <p>{session.spec.targeting.selectedTargetRefs.length} recipients · {deliveryLabel(session.spec.delivery.pattern)} · V{session.currentStateVersion}</p>
          </div>
          {controller.templateProvenance ? (
            <span className="uui-template-provenance-badge" title="This campaign was created from a template">
              From template · {controller.templateProvenance.templateName} · v{controller.templateProvenance.versionNumber}
            </span>
          ) : null}
          <span><ShieldCheck size={13} /> Saved</span>
          <button type="button" className="ov3p1-icon-button" aria-label="Campaign options"><MoreHorizontal size={18} /></button>
        </header>

        <nav className="ov3p1-phase-nav" aria-label="Campaign phases">
          <button type="button" data-active={false} onClick={() => onStepChange('goal')}><span>Plan</span><small>Goal, audience, delivery, context and voice</small></button>
          <button type="button" data-active={phaseLabel(view) === 'Drafts' || undefined} onClick={() => onStepChange('drafts')}><span>Drafts</span><small>{approved} of {drafts.length || plan?.slots.length || 0} approved</small></button>
          <button type="button" data-active={phaseLabel(view) === 'Send' || undefined} disabled={!drafts.length} onClick={() => onStepChange('send')}><span>Send</span><small>{intent ? intent.status.replaceAll('_', ' ') : preflight ? `${preflight.draftVersionIds.length} ready · ${held} held` : 'Preflight and confirmation'}</small></button>
        </nav>

        <div className="ov3p1-main-scroll">{renderMain()}</div>
      </main>

      <MeriRail controller={controller} campaignName={campaignTitle(session)} collapsed={meriCollapsed} receipts={receipts} busyProposalId={busyProposalId} proposalError={proposalError} onToggle={() => setMeriCollapsed((value) => !value)} onApply={(proposal) => void applyProposal(proposal)} onDiscard={(proposal) => void discardProposal(proposal)} onPrepareReversal={prepareReversal} />

      {editingDraft?.current ? <DraftEditDialog draft={editingDraft} pending={reviseMutation.isPending} onClose={() => setEditingDraft(null)} onSave={(subject, body) => reviseMutation.mutate({ draft: editingDraft, subject, body })} /> : null}

      {confirmInput ? <SendConfirmDialog count={preflight?.draftVersionIds.length ?? approvalCount(drafts)} held={preflight?.excludedGenerationKeys.length ?? 0} sender={providerLabel(selectedConnection as IntegrationConnection | null)} pending={realSendMutation.isPending} onClose={() => setConfirmInput(null)} onConfirm={() => realSendMutation.mutate(confirmInput)} /> : null}
    </div>
  );
}
