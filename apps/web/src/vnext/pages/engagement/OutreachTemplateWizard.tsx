import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Loader2, Plus, Trash2 } from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import { EngagementDialog } from '../../../pages/engagement/meetings/EngagementDialog.js';
import { safeOutreachV3Error } from '../../../pages/engagement/outreach/v3/outreach-v3-api.js';
import {
  blankOutreachTemplateSpec,
  createOutreachTemplateFromScratch,
  DEFAULTS_POLICY_FIELD_LABELS,
  OUTREACH_TEMPLATE_DEFAULTS_POLICY_FIELDS,
  OUTREACH_TEMPLATE_VARIABLE_TEXT_FIELDS,
  publishOutreachTemplate,
  replaceOutreachTemplateDraft,
  RESOLUTION_MODE_LABELS,
  updateOutreachTemplateMetadata,
  type OutreachTemplateDefaultsPolicyField,
  type OutreachTemplateFieldResolutionMode,
  type OutreachTemplateSpec,
  type OutreachTemplateVariable,
  type OutreachTemplateVariableTextField,
} from './outreach-v3-template-api.js';
import './outreach-v3-templates.css';

const STEPS = ['basics', 'defaults', 'questions', 'guardrails', 'review'] as const;
type WizardStep = (typeof STEPS)[number];
const STEP_LABELS: Record<WizardStep, string> = {
  basics: 'Basics',
  defaults: 'Defaults',
  questions: 'Questions & Variables',
  guardrails: 'Guardrails',
  review: 'Review & Publish',
};

// Guidance-only fields have no dedicated spec slot; they live on spec.guidance.
const GUIDANCE_TEXT_KEY: Partial<Record<OutreachTemplateDefaultsPolicyField, keyof OutreachTemplateSpec['guidance']>> = {
  audience: 'audienceRule',
  contextPolicy: 'contextPolicy',
  subjectStyle: 'subjectStyle',
  ctaStyle: 'ctaStyle',
  senderPolicy: 'senderPolicy',
  signaturePolicy: 'signaturePolicy',
  schedulingPolicy: 'schedulingPolicy',
  attachmentPolicy: 'attachmentPolicy',
  followUpPolicy: 'followUpPolicy',
};

function newVariable(): OutreachTemplateVariable {
  return {
    key: '',
    label: '',
    question: null,
    type: 'text',
    choices: null,
    required: false,
    defaultValue: null,
    resolutionPolicy: 'user_must_confirm',
    scope: 'public',
    appliesTo: [],
  };
}

function ResolutionModeSelect({
  field,
  value,
  onChange,
}: {
  field: OutreachTemplateDefaultsPolicyField;
  value: OutreachTemplateFieldResolutionMode;
  onChange: (mode: OutreachTemplateFieldResolutionMode) => void;
}) {
  return (
    <select
      aria-label={`How ${DEFAULTS_POLICY_FIELD_LABELS[field]} is decided`}
      className="uui-wizard-mode-select"
      value={value}
      onChange={(event) => onChange(event.target.value as OutreachTemplateFieldResolutionMode)}
    >
      {(['fixed', 'suggested', 'ask_each_campaign', 'meri_determines_user_confirms', 'required_unresolved', 'not_applicable'] as const).map(
        (mode) => (
          <option key={mode} value={mode}>{RESOLUTION_MODE_LABELS[mode]}</option>
        ),
      )}
    </select>
  );
}

export function OutreachTemplateWizard({
  mode,
  existing,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  existing?: { templateId: string; name: string; description: string | null; campaignType: string | null; spec: OutreachTemplateSpec };
  onClose: () => void;
  onSaved: (result: { templateId: string }) => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [step, setStep] = useState<WizardStep>('basics');
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [campaignType, setCampaignType] = useState(existing?.campaignType ?? '');
  const [spec, setSpec] = useState<OutreachTemplateSpec>(existing?.spec ?? blankOutreachTemplateSpec());
  const [error, setError] = useState<string | null>(null);
  const [savedTemplateId, setSavedTemplateId] = useState<string | null>(existing?.templateId ?? null);
  const [saved, setSaved] = useState(false);

  const stepIndex = STEPS.indexOf(step);
  const dirty = name !== (existing?.name ?? '') || JSON.stringify(spec) !== JSON.stringify(existing?.spec ?? blankOutreachTemplateSpec());

  const updateSpec = (patch: (draft: OutreachTemplateSpec) => OutreachTemplateSpec) => setSpec((prev) => patch(prev));
  const setPolicy = (field: OutreachTemplateDefaultsPolicyField, policyMode: OutreachTemplateFieldResolutionMode) =>
    updateSpec((prev) => ({ ...prev, defaultsPolicy: { ...prev.defaultsPolicy, [field]: policyMode } }));

  const saveDraft = useMutation({
    mutationFn: async () => {
      if (mode === 'create') {
        const result = await createOutreachTemplateFromScratch(api, {
          name: name.trim(),
          description: description.trim() || null,
          campaignType: campaignType.trim() || null,
          spec,
        });
        return result.template.id;
      }
      const templateId = existing!.templateId;
      await replaceOutreachTemplateDraft(api, templateId, spec);
      if (name !== existing?.name || description !== (existing?.description ?? '') || campaignType !== (existing?.campaignType ?? '')) {
        // Metadata (name/description/campaignType) is separate from
        // versioned content — scope/client are intentionally left untouched
        // here; that governance action stays in the library's Edit dialog.
        await updateOutreachTemplateMetadata(api, templateId, {
          name: name.trim(),
          description: description.trim() || null,
          campaignType: campaignType.trim() || null,
          scope: 'private',
        }).catch(() => undefined);
      }
      return templateId;
    },
    onSuccess: async (templateId) => {
      setError(null);
      setSavedTemplateId(templateId);
      setSaved(true);
      await qc.invalidateQueries({ queryKey: ['outreach-v3', 'templates'] });
    },
    onError: (cause) => setError(safeOutreachV3Error(cause)),
  });

  const publish = useMutation({
    mutationFn: () => publishOutreachTemplate(api, savedTemplateId!),
    onSuccess: async () => {
      setError(null);
      await qc.invalidateQueries({ queryKey: ['outreach-v3', 'templates'] });
      onSaved({ templateId: savedTemplateId! });
    },
    onError: (cause) => setError(safeOutreachV3Error(cause)),
  });

  const canLeaveBasics = name.trim().length > 0 && name.trim().length <= 160;
  const variableKeysValid = spec.variables.every((v) => /^[a-z][a-z0-9_]{0,39}$/.test(v.key));
  const canLeaveQuestions = variableKeysValid && new Set(spec.variables.map((v) => v.key)).size === spec.variables.length;

  const canGoNext = step === 'basics' ? canLeaveBasics : step === 'questions' ? canLeaveQuestions : true;

  return (
    <EngagementDialog
      open
      eyebrow={mode === 'create' ? 'Create template' : 'Edit template content'}
      title={STEP_LABELS[step]}
      description="Templates store reusable rules and intent, not live execution state — recipients, evidence, drafts, approvals, and sending always start fresh."
      width={760}
      busy={saveDraft.isPending || publish.isPending}
      dirty={dirty && !saved}
      error={error}
      onClose={onClose}
      footer={
        saved ? (
          <>
            <button type="button" className="uui-button" onClick={onClose}>Keep as draft</button>
            <button type="button" className="uui-button--primary" disabled={publish.isPending} onClick={() => publish.mutate()}>
              {publish.isPending ? <Loader2 className="uui-spin" size={14} /> : <Check size={14} />} Publish v1
            </button>
          </>
        ) : (
          <>
            <button type="button" className="uui-button" onClick={onClose}>Cancel</button>
            {stepIndex > 0 ? (
              <button type="button" className="uui-button" onClick={() => setStep(STEPS[stepIndex - 1]!)}>Back</button>
            ) : null}
            {step !== 'review' ? (
              <button
                type="button"
                className="uui-button--primary"
                disabled={!canGoNext}
                onClick={() => setStep(STEPS[stepIndex + 1]!)}
              >
                Next
              </button>
            ) : (
              <button type="button" className="uui-button--primary" disabled={saveDraft.isPending} onClick={() => saveDraft.mutate()}>
                {saveDraft.isPending ? <Loader2 className="uui-spin" size={14} /> : <Check size={14} />} Save draft
              </button>
            )}
          </>
        )
      }
    >
      <nav className="uui-wizard-steps" aria-label="Template steps">
        {STEPS.map((candidate, index) => (
          <button
            key={candidate}
            type="button"
            data-active={candidate === step || undefined}
            data-done={index < stepIndex || undefined}
            disabled={saved}
            onClick={() => setStep(candidate)}
          >
            {index + 1}. {STEP_LABELS[candidate]}
          </button>
        ))}
      </nav>

      {saved ? (
        <div className="ov3p1-template-receipt">
          <span><Check size={18} /></span>
          <strong>Draft saved.</strong>
          <p>Publish to make this exact version available in Outreach → Templates, or keep it as a draft and come back later.</p>
        </div>
      ) : (
        <div className="uui-wizard-step-body">
          {step === 'basics' ? (
            <div className="uui-template-dialog-fields">
              <label>Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={160} placeholder="e.g. HAC-D Program Support" /></label>
              <label>Description<textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} /></label>
              <label>Campaign type<input value={campaignType} onChange={(e) => setCampaignType(e.target.value)} maxLength={60} placeholder="e.g. Funding ask" /></label>
              <p>New templates start as a private draft. Publish, then change who can use it from the library.</p>
            </div>
          ) : null}

          {step === 'defaults' ? (
            <div className="uui-wizard-defaults">
              <FieldRow field="goal" label="Goal" mode={spec.defaultsPolicy.goal} onMode={(m) => setPolicy('goal', m)}>
                <textarea rows={2} value={spec.goal.goal ?? ''} maxLength={2000} onChange={(e) => updateSpec((p) => ({ ...p, goal: { ...p.goal, goal: e.target.value || null } }))} />
              </FieldRow>
              <FieldRow field="objective" label="Objective" mode={spec.defaultsPolicy.objective} onMode={(m) => setPolicy('objective', m)}>
                <textarea rows={2} value={spec.goal.objective ?? ''} maxLength={4000} onChange={(e) => updateSpec((p) => ({ ...p, goal: { ...p.goal, objective: e.target.value || null } }))} />
              </FieldRow>
              <FieldRow field="topic" label="Topic" mode={spec.defaultsPolicy.topic} onMode={(m) => setPolicy('topic', m)}>
                <input value={spec.goal.topic ?? ''} maxLength={500} onChange={(e) => updateSpec((p) => ({ ...p, goal: { ...p.goal, topic: e.target.value || null } }))} />
              </FieldRow>
              <FieldRow field="desiredOutcome" label="Desired outcome" mode={spec.defaultsPolicy.desiredOutcome} onMode={(m) => setPolicy('desiredOutcome', m)}>
                <textarea rows={2} value={spec.goal.desiredOutcome ?? ''} maxLength={2000} onChange={(e) => updateSpec((p) => ({ ...p, goal: { ...p.goal, desiredOutcome: e.target.value || null } }))} />
              </FieldRow>
              <FieldRow field="ask" label="Ask" mode={spec.defaultsPolicy.ask} onMode={(m) => setPolicy('ask', m)}>
                <select
                  value={spec.goal.ask.mode}
                  onChange={(e) => {
                    const askMode = e.target.value as OutreachTemplateSpec['goal']['ask']['mode'];
                    updateSpec((p) => ({ ...p, goal: { ...p.goal, ask: { mode: askMode, text: askMode === 'explicit' ? p.goal.ask.text || '' : null } } }));
                  }}
                >
                  <option value="undecided">Undecided</option>
                  <option value="explicit">Explicit</option>
                  <option value="none">None</option>
                </select>
                {spec.goal.ask.mode === 'explicit' ? (
                  <textarea rows={2} value={spec.goal.ask.text ?? ''} maxLength={2000} onChange={(e) => updateSpec((p) => ({ ...p, goal: { ...p.goal, ask: { ...p.goal.ask, text: e.target.value } } }))} />
                ) : null}
              </FieldRow>
              <FieldRow field="whyNow" label="Why now" mode={spec.defaultsPolicy.whyNow} onMode={(m) => setPolicy('whyNow', m)}>
                <textarea rows={2} value={spec.goal.whyNow ?? ''} maxLength={2000} onChange={(e) => updateSpec((p) => ({ ...p, goal: { ...p.goal, whyNow: e.target.value || null } }))} />
              </FieldRow>
              <FieldRow field="delivery" label="Delivery pattern" mode={spec.defaultsPolicy.delivery} onMode={(m) => setPolicy('delivery', m)}>
                <select value={spec.delivery.pattern} onChange={(e) => updateSpec((p) => ({ ...p, delivery: { ...p.delivery, pattern: e.target.value as OutreachTemplateSpec['delivery']['pattern'] } }))}>
                  <option value="undecided">Undecided</option>
                  <option value="personalized_separate">Personalized, separate</option>
                  <option value="uniform_separate">Uniform, separate</option>
                  <option value="shared_thread">Shared thread</option>
                </select>
              </FieldRow>
              <FieldRow field="personalization" label="Personalization" mode={spec.defaultsPolicy.personalization} onMode={(m) => setPolicy('personalization', m)}>
                <select value={spec.delivery.personalization} onChange={(e) => updateSpec((p) => ({ ...p, delivery: { ...p.delivery, personalization: e.target.value as OutreachTemplateSpec['delivery']['personalization'] } }))}>
                  <option value="undecided">Undecided</option>
                  <option value="high">High</option>
                  <option value="light">Light</option>
                  <option value="none">None</option>
                </select>
              </FieldRow>
              <FieldRow field="campaignAngle" label="Campaign angle" mode={spec.defaultsPolicy.campaignAngle} onMode={(m) => setPolicy('campaignAngle', m)}>
                <textarea rows={2} value={spec.strategy.campaignAngle ?? ''} maxLength={4000} onChange={(e) => updateSpec((p) => ({ ...p, strategy: { ...p.strategy, campaignAngle: e.target.value || null } }))} />
              </FieldRow>
              <FieldRow field="tone" label="Tone" mode={spec.defaultsPolicy.tone} onMode={(m) => setPolicy('tone', m)}>
                <input value={spec.strategy.tone ?? ''} maxLength={120} onChange={(e) => updateSpec((p) => ({ ...p, strategy: { ...p.strategy, tone: e.target.value || null } }))} />
              </FieldRow>
              <FieldRow field="length" label="Length" mode={spec.defaultsPolicy.length} onMode={(m) => setPolicy('length', m)}>
                <select value={spec.strategy.length} onChange={(e) => {
                  const length = e.target.value as OutreachTemplateSpec['strategy']['length'];
                  updateSpec((p) => ({ ...p, strategy: { ...p.strategy, length, customLengthInstruction: length === 'custom' ? p.strategy.customLengthInstruction || '' : null } }));
                }}>
                  <option value="undecided">Undecided</option>
                  <option value="short">Short</option>
                  <option value="medium">Medium</option>
                  <option value="long">Long</option>
                  <option value="custom">Custom</option>
                </select>
                {spec.strategy.length === 'custom' ? (
                  <input value={spec.strategy.customLengthInstruction ?? ''} maxLength={1000} onChange={(e) => updateSpec((p) => ({ ...p, strategy: { ...p.strategy, customLengthInstruction: e.target.value } }))} />
                ) : null}
              </FieldRow>
              {(Object.entries(GUIDANCE_TEXT_KEY) as Array<[OutreachTemplateDefaultsPolicyField, keyof OutreachTemplateSpec['guidance']]>).map(([field, guidanceKey]) => (
                <FieldRow key={field} field={field} label={DEFAULTS_POLICY_FIELD_LABELS[field]} mode={spec.defaultsPolicy[field]} onMode={(m) => setPolicy(field, m)}>
                  <textarea
                    rows={2}
                    value={spec.guidance[guidanceKey] ?? ''}
                    maxLength={2000}
                    placeholder="Guidance shown during Plan/Drafts — not auto-applied to the campaign."
                    onChange={(e) => updateSpec((p) => ({ ...p, guidance: { ...p.guidance, [guidanceKey]: e.target.value || null } }))}
                  />
                </FieldRow>
              ))}
              <FieldRow field="sponsorScope" label="Sponsor scope" mode={spec.defaultsPolicy.sponsorScope} onMode={(m) => setPolicy('sponsorScope', m)}>
                <p className="uui-wizard-hint">Sponsor is decided per campaign for a from-scratch template.</p>
              </FieldRow>
            </div>
          ) : null}

          {step === 'questions' ? (
            <div className="uui-wizard-variables">
              <p>Typed variables like <code>{'{client}'}</code>, <code>{'{amount}'}</code>, or <code>{'{deadline}'}</code> can appear in Goal, Objective, Topic, Desired outcome, Ask, Why now, and Campaign angle.</p>
              {spec.variables.map((variable, index) => (
                <VariableEditor
                  key={index}
                  variable={variable}
                  onChange={(next) => updateSpec((p) => ({ ...p, variables: p.variables.map((v, i) => (i === index ? next : v)) }))}
                  onRemove={() => updateSpec((p) => ({ ...p, variables: p.variables.filter((_, i) => i !== index) }))}
                />
              ))}
              {spec.variables.length < 20 ? (
                <button type="button" className="uui-button" onClick={() => updateSpec((p) => ({ ...p, variables: [...p.variables, newVariable()] }))}>
                  <Plus size={14} /> Add variable
                </button>
              ) : null}
              {!variableKeysValid ? <p className="uui-wizard-warning"><AlertTriangle size={14} /> Every variable needs a lowercase_key like <code>client</code> or <code>event_date</code>.</p> : null}
            </div>
          ) : null}

          {step === 'guardrails' ? (
            <div className="uui-template-dialog-fields">
              <label>Who may send<select value={spec.guardrails.sendAuthority} onChange={(e) => updateSpec((p) => ({ ...p, guardrails: { ...p.guardrails, sendAuthority: e.target.value as OutreachTemplateSpec['guardrails']['sendAuthority'] } }))}>
                <option value="any_authorized_sender">Any authorized sender</option>
                <option value="owner_only">Owner only</option>
                <option value="tenant_admin">Tenant admin</option>
              </select></label>
              <label>Approval mode<select value={spec.guardrails.approvalMode} onChange={(e) => updateSpec((p) => ({ ...p, guardrails: { ...p.guardrails, approvalMode: e.target.value as OutreachTemplateSpec['guardrails']['approvalMode'] } }))}>
                <option value="individual">Approve individually</option>
                <option value="bulk_allowed">Bulk approval allowed</option>
              </select></label>
              <label><input type="checkbox" checked={spec.guardrails.partialSendAllowed} onChange={(e) => updateSpec((p) => ({ ...p, guardrails: { ...p.guardrails, partialSendAllowed: e.target.checked } }))} /> Allow sending to only some recipients</label>
              <label>Sender requirement<select value={spec.guardrails.senderRequirement} onChange={(e) => updateSpec((p) => ({ ...p, guardrails: { ...p.guardrails, senderRequirement: e.target.value as OutreachTemplateSpec['guardrails']['senderRequirement'] } }))}>
                <option value="any_authorized">Any authorized sender</option>
                <option value="specific_role_required">Specific role required</option>
                <option value="not_applicable">Not applicable</option>
              </select></label>
              <label>Attachment requirement<select value={spec.guardrails.attachmentRequirement} onChange={(e) => updateSpec((p) => ({ ...p, guardrails: { ...p.guardrails, attachmentRequirement: e.target.value as OutreachTemplateSpec['guardrails']['attachmentRequirement'] } }))}>
                <option value="none">None</option>
                <option value="optional">Optional</option>
                <option value="required">Required</option>
              </select></label>
              <label><input type="checkbox" checked={spec.guardrails.followUpRequired} onChange={(e) => updateSpec((p) => ({ ...p, guardrails: { ...p.guardrails, followUpRequired: e.target.checked } }))} /> Follow-up required</label>
              <label><input type="checkbox" checked={spec.guardrails.variablesAutoResolveAllowed} onChange={(e) => updateSpec((p) => ({ ...p, guardrails: { ...p.guardrails, variablesAutoResolveAllowed: e.target.checked } }))} /> Allow Meri to auto-resolve "Meri can determine" variables</label>
              <label>Who may edit<select value={spec.guardrails.editAuthority} onChange={(e) => updateSpec((p) => ({ ...p, guardrails: { ...p.guardrails, editAuthority: e.target.value as OutreachTemplateSpec['guardrails']['editAuthority'] } }))}>
                <option value="owner_only">Owner only</option>
                <option value="managers">Managers</option>
                <option value="firm_admins">Firm admins</option>
              </select></label>
              <label>Who may publish<select value={spec.guardrails.publishAuthority} onChange={(e) => updateSpec((p) => ({ ...p, guardrails: { ...p.guardrails, publishAuthority: e.target.value as OutreachTemplateSpec['guardrails']['publishAuthority'] } }))}>
                <option value="tenant_admin">Tenant admin</option>
                <option value="owner_only">Owner only (private only)</option>
                <option value="independent_reviewer">Independent reviewer</option>
              </select></label>
              <p>These guardrails are stored with the template and shown during Plan/Drafts. Send authority itself is always enforced by Outreach's own send-authority system, not overridden by a template.</p>
            </div>
          ) : null}

          {step === 'review' ? <ReviewSummary spec={spec} name={name} /> : null}
        </div>
      )}
    </EngagementDialog>
  );
}

function FieldRow({
  field,
  label,
  mode,
  onMode,
  children,
}: {
  field: OutreachTemplateDefaultsPolicyField;
  label: string;
  mode: OutreachTemplateFieldResolutionMode;
  onMode: (mode: OutreachTemplateFieldResolutionMode) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="uui-wizard-field-row">
      <div className="uui-wizard-field-row__header">
        <span>{label}</span>
        <ResolutionModeSelect field={field} value={mode} onChange={onMode} />
      </div>
      {children}
    </div>
  );
}

function VariableEditor({
  variable,
  onChange,
  onRemove,
}: {
  variable: OutreachTemplateVariable;
  onChange: (next: OutreachTemplateVariable) => void;
  onRemove: () => void;
}) {
  return (
    <div className="uui-wizard-variable">
      <div className="uui-wizard-variable__row">
        <input placeholder="key (e.g. client)" value={variable.key} maxLength={40} onChange={(e) => onChange({ ...variable, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} />
        <input placeholder="Label" value={variable.label} maxLength={120} onChange={(e) => onChange({ ...variable, label: e.target.value })} />
        <button type="button" className="uui-button uui-template-card__archive" onClick={onRemove}><Trash2 size={14} /></button>
      </div>
      <input placeholder="Question shown to the operator" value={variable.question ?? ''} maxLength={500} onChange={(e) => onChange({ ...variable, question: e.target.value || null })} />
      <div className="uui-wizard-variable__row">
        <select value={variable.type} onChange={(e) => onChange({ ...variable, type: e.target.value as OutreachTemplateVariable['type'], choices: e.target.value === 'choice' ? variable.choices ?? [''] : null })}>
          <option value="text">Text</option>
          <option value="number">Number</option>
          <option value="date">Date</option>
          <option value="url">URL</option>
          <option value="email">Email</option>
          <option value="choice">Choice</option>
        </select>
        <select value={variable.resolutionPolicy} onChange={(e) => onChange({ ...variable, resolutionPolicy: e.target.value as OutreachTemplateVariable['resolutionPolicy'], defaultValue: e.target.value === 'always_ask' ? null : variable.defaultValue })}>
          <option value="meri_can_determine">Meri can determine</option>
          <option value="user_must_confirm">User must confirm</option>
          <option value="always_ask">Always ask</option>
        </select>
        <select value={variable.scope} onChange={(e) => onChange({ ...variable, scope: e.target.value as OutreachTemplateVariable['scope'] })}>
          <option value="public">Public</option>
          <option value="client_confidential">Client-confidential</option>
        </select>
        <label><input type="checkbox" checked={variable.required} onChange={(e) => onChange({ ...variable, required: e.target.checked })} /> Required</label>
      </div>
      {variable.type === 'choice' ? (
        <input
          placeholder="Choices, comma-separated"
          value={(variable.choices ?? []).join(', ')}
          onChange={(e) => onChange({ ...variable, choices: e.target.value.split(',').map((c) => c.trim()).filter(Boolean) })}
        />
      ) : null}
      {variable.resolutionPolicy !== 'always_ask' ? (
        <input placeholder="Default value (optional)" value={variable.defaultValue ?? ''} maxLength={500} onChange={(e) => onChange({ ...variable, defaultValue: e.target.value || null })} />
      ) : null}
      <fieldset className="uui-wizard-applies-to">
        <legend>Appears in</legend>
        {OUTREACH_TEMPLATE_VARIABLE_TEXT_FIELDS.map((field: OutreachTemplateVariableTextField) => (
          <label key={field}>
            <input
              type="checkbox"
              checked={variable.appliesTo.includes(field)}
              onChange={(e) => onChange({
                ...variable,
                appliesTo: e.target.checked ? [...variable.appliesTo, field] : variable.appliesTo.filter((f) => f !== field),
              })}
            />
            {field}
          </label>
        ))}
      </fieldset>
    </div>
  );
}

function ReviewSummary({ spec, name }: { spec: OutreachTemplateSpec; name: string }) {
  const fixedCount = useMemo(
    () => OUTREACH_TEMPLATE_DEFAULTS_POLICY_FIELDS.filter((f) => spec.defaultsPolicy[f] === 'fixed' || spec.defaultsPolicy[f] === 'suggested').length,
    [spec],
  );
  const openCount = OUTREACH_TEMPLATE_DEFAULTS_POLICY_FIELDS.length - fixedCount - OUTREACH_TEMPLATE_DEFAULTS_POLICY_FIELDS.filter((f) => spec.defaultsPolicy[f] === 'not_applicable').length;
  return (
    <div className="uui-wizard-review">
      <h3>{name || 'Untitled template'}</h3>
      <ul>
        <li>{fixedCount} field(s) carry a fixed or suggested default.</li>
        <li>{openCount} field(s) stay open for every campaign.</li>
        <li>{spec.variables.length} variable(s), {spec.variables.filter((v) => v.required).length} required.</li>
        <li>Send authority: {spec.guardrails.sendAuthority.replaceAll('_', ' ')}.</li>
      </ul>
      <p>Recipients, evidence, drafts, approvals, and sending are never stored on a template — they are resolved fresh every time it is used.</p>
    </div>
  );
}
