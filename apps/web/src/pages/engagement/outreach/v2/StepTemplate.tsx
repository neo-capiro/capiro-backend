// Step 2 (continued) — template selection. Extracted from NewOutreachWizard.tsx
// (previously the inline StepTemplate/PreviewTemplateModal/CreateTemplateModal
// functions) as part of the real Tailwind + React Aria migration (handover §0,
// §6.5) — every handler, query, and mutation is unchanged, only the JSX/CSS.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App } from 'antd';
import { useApi } from '../../../../lib/use-api.js';
import './ui/tailwind.css';
import { Icon } from './ui/icons.js';
import { Button } from './ui/Button.js';
import { Badge } from './ui/Badge.js';
import { Input, TextArea } from './ui/Input.js';
import { Select } from './ui/Select.js';
import { Dialog } from './ui/Dialog.js';

// Shape returned by GET /api/engagement/outreach/ai-templates. The backend
// merges system templates (hardcoded in engagement.service.ts) with any
// user-created custom templates from outreach_ai_template. We render both
// in the same grid; the only visible difference is a "Custom" tag on
// user-owned ones so the user can find their own templates at a glance.
interface AiTemplate {
  id: string;
  source: 'system' | 'user';
  name: string;
  category: string;
  prompt: string;
  description: string | null;
  samplePreview: string | null;
  tone: string;
  usageCount: number;
}

export function StepTemplate({
  templateId,
  onChange,
}: {
  templateId: string | null;
  onChange: (id: string) => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [previewing, setPreviewing] = useState<AiTemplate | null>(null);
  const [creatingOpen, setCreatingOpen] = useState(false);

  const templatesQuery = useQuery<AiTemplate[]>({
    queryKey: ['outreach-ai-templates'],
    queryFn: async () =>
      (await api.get<AiTemplate[]>('/api/engagement/outreach/ai-templates')).data,
  });

  const createMutation = useMutation({
    mutationFn: async (input: {
      name: string;
      category: string;
      prompt: string;
      description?: string;
      tone?: string;
    }) => (await api.post<AiTemplate>('/api/engagement/outreach/ai-templates', input)).data,
    onSuccess: (created) => {
      message.success(`Created "${created.name}"`);
      qc.invalidateQueries({ queryKey: ['outreach-ai-templates'] });
      setCreatingOpen(false);
      // Auto-select the newly created template so the user doesn't have
      // to click it again before continuing.
      onChange(created.id);
    },
    onError: () => message.error('Could not create template'),
  });

  const templates = templatesQuery.data ?? [];

  return (
    <div className="ov2-tw-root">
      <h2 className="text-[22px] leading-7 font-bold tracking-[-0.02em] text-ink-primary">
        Choose a template
      </h2>
      <div className="mt-1.5 mb-5 text-sm leading-5 text-ink-secondary">
        Templates seed the structure. Meri fills it from your context. Preview to see a sample, or
        create your own.
      </div>

      {templatesQuery.isLoading ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-[120px] animate-pulse rounded-lg bg-surface-subtle" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3.5">
          {templates.map((t) => {
            const selected = templateId === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onChange(t.id)}
                className={`relative flex flex-col gap-2 rounded-lg border p-[18px] text-left transition-colors ${
                  selected
                    ? 'border-accent-border bg-accent-tint'
                    : 'border-line-hairline bg-surface hover:border-accent-border'
                }`}
              >
                {selected && (
                  <span className="btn-dark absolute top-3.5 right-3.5 flex h-[18px] w-[18px] items-center justify-center rounded-full text-white">
                    <Icon.Check size={11} />
                  </span>
                )}
                <div className="flex items-center gap-1.5">
                  <div className="text-[15px] leading-5 font-semibold text-ink-primary">
                    {t.name}
                  </div>
                  {t.source === 'user' && <Badge color="brand">Custom</Badge>}
                </div>
                <div className="flex-1 text-[13px] leading-[19px] text-ink-secondary">
                  {t.description ?? 'No description'}
                </div>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPreviewing(t);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      setPreviewing(t);
                    }
                  }}
                  className="inline-flex w-fit cursor-pointer items-center gap-1 text-[12px] font-semibold text-accent-ink"
                >
                  <Icon.Eye size={13} /> Preview
                </span>
              </button>
            );
          })}

          {/* "Create custom" tile, same grid slot as a template card so the
              shape stays predictable as the catalog grows. */}
          <button
            type="button"
            onClick={() => setCreatingOpen(true)}
            className="flex min-h-[110px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line-control text-ink-secondary hover:border-accent-border"
          >
            <Icon.Plus size={18} />
            <span className="text-[13px] font-semibold">Create custom template</span>
            <span className="text-[11px] text-ink-tertiary">Define your own prompt</span>
          </button>
        </div>
      )}

      <PreviewTemplateModal
        template={previewing}
        onClose={() => setPreviewing(null)}
        onSelect={(id) => {
          onChange(id);
          setPreviewing(null);
        }}
      />
      <CreateTemplateModal
        open={creatingOpen}
        onCancel={() => setCreatingOpen(false)}
        onSubmit={(input) => createMutation.mutate(input)}
        submitting={createMutation.isPending}
      />
    </div>
  );
}

function PreviewTemplateModal({
  template,
  onClose,
  onSelect,
}: {
  template: AiTemplate | null;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <Dialog
      open={!!template}
      onClose={onClose}
      title={template ? `Preview · ${template.name}` : ''}
      width={640}
      footer={
        template && (
          <>
            <Button variant="secondary" onPress={onClose}>
              Close
            </Button>
            <Button variant="primary" onPress={() => onSelect(template.id)}>
              Use this template
            </Button>
          </>
        )
      }
    >
      {template && (
        <div className="ov2-tw-root flex flex-col gap-3.5">
          <div>
            <div className="mb-1 font-mono text-[11px] tracking-[0.06em] text-ink-tertiary uppercase">
              Description
            </div>
            <div className="text-[13.5px] text-ink-primary">
              {template.description ?? 'No description provided.'}
            </div>
          </div>
          <div>
            <div className="mb-1 font-mono text-[11px] tracking-[0.06em] text-ink-tertiary uppercase">
              Sample output
            </div>
            <pre className="rounded-md border border-line-hairline bg-surface-subtle p-3.5 font-sans text-[12.5px] leading-[1.55] whitespace-pre-wrap text-ink-primary">
              {template.samplePreview ?? '(no sample preview available)'}
            </pre>
          </div>
          <div>
            <div className="mb-1 font-mono text-[11px] tracking-[0.06em] text-ink-tertiary uppercase">
              Prompt sent to Meri
            </div>
            <div className="rounded-md border border-line-hairline bg-surface-subtle p-3.5 text-[12.5px] leading-[1.55] text-ink-secondary">
              {template.prompt}
            </div>
          </div>
          <div className="flex gap-4 text-xs text-ink-tertiary">
            <span>
              Tone: <b className="text-ink-primary">{template.tone}</b>
            </span>
            <span>
              Category: <b className="text-ink-primary">{template.category}</b>
            </span>
            {template.source === 'user' && (
              <span>
                Used: <b className="text-ink-primary">{template.usageCount}×</b>
              </span>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

const CATEGORY_OPTIONS = [
  { value: 'general', label: 'General' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'follow_up', label: 'Follow-up' },
  { value: 'policy', label: 'Policy' },
];

const TONE_OPTIONS = [
  { value: 'professional', label: 'Professional' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'formal', label: 'Formal' },
  { value: 'concise', label: 'Concise' },
];

function CreateTemplateModal({
  open,
  onCancel,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onCancel: () => void;
  onSubmit: (input: {
    name: string;
    category: string;
    prompt: string;
    description?: string;
    tone?: string;
  }) => void;
  submitting: boolean;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [category, setCategory] = useState('general');
  const [tone, setTone] = useState('professional');
  const [nameError, setNameError] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setName('');
      setDescription('');
      setPrompt('');
      setCategory('general');
      setTone('professional');
      setNameError(null);
      setPromptError(null);
    }
  }, [open]);

  const handleSubmit = () => {
    const nameOk = name.trim().length > 0;
    const promptOk = prompt.trim().length >= 20;
    setNameError(nameOk ? null : 'Name is required');
    setPromptError(
      promptOk
        ? null
        : prompt.trim().length === 0
          ? 'Prompt is required'
          : 'Prompt should be at least 20 characters',
    );
    if (!nameOk || !promptOk) return;
    onSubmit({
      name,
      category: category || 'general',
      prompt,
      description: description || undefined,
      tone: tone || 'professional',
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title="Create custom template"
      width={620}
      footer={
        <>
          <Button variant="secondary" onPress={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onPress={handleSubmit} isDisabled={submitting}>
            Create
          </Button>
        </>
      }
    >
      <div className="ov2-tw-root flex flex-col gap-4">
        <div>
          <Input
            label="Name"
            value={name}
            onChange={setName}
            placeholder="e.g. FY27 NDAA position memo"
            maxLength={120}
          />
          {nameError && <div className="mt-1 text-xs text-warning">{nameError}</div>}
        </div>
        <Input
          label="Short description (optional)"
          value={description}
          onChange={setDescription}
          placeholder="One-line summary shown on the template card"
          maxLength={500}
        />
        <div>
          <TextArea
            label="Prompt"
            value={prompt}
            onChange={setPrompt}
            rows={6}
            placeholder="Write a concise email to a congressional office that... Include... Under 200 words."
            maxLength={5000}
            showCount
          />
          {promptError && <div className="mt-1 text-xs text-warning">{promptError}</div>}
        </div>
        <div className="flex gap-3">
          <Select
            label="Category"
            selectedKey={category}
            onSelectionChange={setCategory}
            options={CATEGORY_OPTIONS}
            className="flex-1"
          />
          <Select
            label="Tone"
            selectedKey={tone}
            onSelectionChange={setTone}
            options={TONE_OPTIONS}
            className="flex-1"
          />
        </div>
      </div>
    </Dialog>
  );
}
