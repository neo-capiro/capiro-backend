import { useState } from 'react';
import {
  ChevronDown,
  Loader2,
  Pencil,
  RefreshCcw,
  Sparkles,
} from 'lucide-react';
import type { OutreachV3DraftArtifact } from './engagement-api.js';
import './outreach-v3-draft-recipient-controls.css';

const TONES = [
  'Professional',
  'Warm',
  'Concise',
  'Direct',
  'Persuasive',
  'Conversational',
] as const;

export function DraftRecipientControls({
  draft,
  busy,
  refineBusy,
  onEdit,
  onRefine,
}: {
  draft: OutreachV3DraftArtifact;
  busy: boolean;
  refineBusy: boolean;
  onEdit: () => void;
  onRefine: (instruction: string) => void;
}) {
  const [meriOpen, setMeriOpen] = useState(false);
  const [toneOpen, setToneOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [tone, setTone] = useState<(typeof TONES)[number]>('Professional');
  const disabled = busy || refineBusy || !draft.current;

  const submitMeriEdit = () => {
    const request = instruction.trim();
    if (!request) return;
    onRefine(
      `Create a new version of this recipient's draft with this instruction: ${request}. Preserve the exact approved subject line, recipient, sponsor facts, recipient-specific note, and ask. Do not introduce unsupported facts.`,
    );
    setInstruction('');
    setMeriOpen(false);
  };

  const changeTone = () => {
    onRefine(
      `Create a new version of this recipient's draft in a ${tone.toLowerCase()} tone. Preserve the exact approved subject line, recipient, factual content, recipient-specific note, and ask. Do not add new facts.`,
    );
    setToneOpen(false);
  };

  const regenerate = () => {
    onRefine(
      "Regenerate this recipient's draft from the approved campaign packet. Keep the exact approved subject line, recipient, sponsor facts, recipient-specific note, and ask. Write a genuinely fresh body instead of lightly editing the current wording, and do not introduce unsupported facts.",
    );
  };

  return (
    <div className="ov3-recipient-controls" aria-label="Draft editing controls">
      <div className="ov3-recipient-controls__bar">
        <span>Draft tools</span>
        <button type="button" disabled={disabled} onClick={onEdit}>
          <Pencil size={14} />
          Edit text
        </button>
        <button
          type="button"
          disabled={disabled}
          data-active={meriOpen || undefined}
          onClick={() => {
            setMeriOpen((current) => !current);
            setToneOpen(false);
          }}
        >
          <Sparkles size={14} />
          Edit with Meri
          <ChevronDown size={13} />
        </button>
        <button
          type="button"
          disabled={disabled}
          data-active={toneOpen || undefined}
          onClick={() => {
            setToneOpen((current) => !current);
            setMeriOpen(false);
          }}
        >
          Change tone
          <ChevronDown size={13} />
        </button>
        <button type="button" disabled={disabled} onClick={regenerate}>
          {refineBusy ? <Loader2 size={14} className="ov3-recipient-controls__spin" /> : <RefreshCcw size={14} />}
          Regenerate
        </button>
      </div>

      {meriOpen ? (
        <div className="ov3-recipient-controls__panel">
          <label>
            <span>Tell Meri what to change</span>
            <textarea
              autoFocus
              rows={3}
              value={instruction}
              onChange={(event: { target: { value: string } }) => setInstruction(event.target.value)}
              placeholder="Make the opening more personal and shorten the second paragraph."
            />
          </label>
          <div>
            <button type="button" className="is-quiet" onClick={() => setMeriOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="is-primary"
              disabled={disabled || !instruction.trim()}
              onClick={submitMeriEdit}
            >
              {refineBusy ? <Loader2 size={14} className="ov3-recipient-controls__spin" /> : <Sparkles size={14} />}
              Create new version
            </button>
          </div>
        </div>
      ) : null}

      {toneOpen ? (
        <div className="ov3-recipient-controls__panel ov3-recipient-controls__panel--tone">
          <label>
            <span>New tone</span>
            <select value={tone} onChange={(event: { target: { value: string } }) => setTone(event.target.value as (typeof TONES)[number])}>
              {TONES.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
          <div>
            <button type="button" className="is-quiet" onClick={() => setToneOpen(false)}>
              Cancel
            </button>
            <button type="button" className="is-primary" disabled={disabled} onClick={changeTone}>
              {refineBusy ? <Loader2 size={14} className="ov3-recipient-controls__spin" /> : <Sparkles size={14} />}
              Apply to new version
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
