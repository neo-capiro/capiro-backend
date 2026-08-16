import { useEffect, useRef, useState } from 'react';
import {
  hydrateMeriStarterPrompt,
  type MeriSkillDefinition,
} from '@capiro/shared/meri-skills';
import { useApi } from '../../lib/use-api.js';
import './meri-quick-actions.css';

interface MeriSkillsResponse {
  version: 1;
  enabled: boolean;
  skills: MeriSkillDefinition[];
}

export interface MeriQuickActionSelection {
  skillId: string;
  prompt: string;
  requiresClient: boolean;
}

interface MeriQuickActionsPanelProps {
  clientName?: string | null;
  hasThread: boolean;
  onSelect: (selection: MeriQuickActionSelection) => void;
}

interface MeriQuickActionsPanelViewProps extends MeriQuickActionsPanelProps {
  skills: MeriSkillDefinition[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function selectionFor(
  skill: MeriSkillDefinition,
  clientName?: string | null,
): MeriQuickActionSelection {
  return {
    skillId: skill.id,
    prompt: hydrateMeriStarterPrompt(skill, { clientName }),
    requiresClient: skill.requiresClient === true,
  };
}

export function MeriQuickActionsPanelView({
  skills,
  clientName,
  hasThread,
  open,
  onOpenChange,
  onSelect,
}: MeriQuickActionsPanelViewProps) {
  if (skills.length === 0) return null;

  return (
    <div className={`meri-v3-quick-actions${hasThread ? ' is-thread' : ' is-fresh'}`}>
      {open ? (
        <section className="meri-v3-quick-actions-card" aria-label="Meri Quick Actions">
          <header>
            <div>
              <span>QUICK ACTIONS</span>
              <small>START WITH AN EDITABLE INTENTION</small>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="Close Quick Actions"
            >
              ×
            </button>
          </header>
          <div className="meri-v3-quick-actions-list">
            {skills.map((skill) => (
              <button
                type="button"
                key={skill.id}
                onClick={() => {
                  onSelect(selectionFor(skill, clientName));
                  onOpenChange(false);
                }}
              >
                <span>{skill.label}</span>
                <small>{skill.description}</small>
              </button>
            ))}
          </div>
          <footer>Nothing runs until you review the prompt and press Send.</footer>
        </section>
      ) : (
        <button
          type="button"
          className="meri-v3-quick-actions-trigger"
          onClick={() => onOpenChange(true)}
          aria-label="Open Quick Actions"
        >
          <span>⌁</span>
          <strong>Quick Actions</strong>
        </button>
      )}
    </div>
  );
}

export function MeriQuickActionsPanel(props: MeriQuickActionsPanelProps) {
  const api = useApi();
  const [skills, setSkills] = useState<MeriSkillDefinition[]>([]);
  const [open, setOpen] = useState(!props.hasThread);
  const pendingClientSkillRef = useRef<MeriSkillDefinition | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .get<MeriSkillsResponse>('/api/clio/v3/skills')
      .then(({ data }) => {
        if (!active) return;
        setSkills(data.enabled && Array.isArray(data.skills) ? data.skills : []);
      })
      .catch(() => {
        if (active) setSkills([]);
      });
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    if (!props.hasThread && skills.length > 0) setOpen(true);
  }, [props.hasThread, skills.length]);

  useEffect(() => {
    const pendingClientSkill = pendingClientSkillRef.current;
    if (!pendingClientSkill || !props.clientName) return;
    pendingClientSkillRef.current = null;
    props.onSelect(selectionFor(pendingClientSkill, props.clientName));
    setOpen(false);
  }, [props.clientName, props.onSelect]);

  const handleSelect = (selection: MeriQuickActionSelection) => {
    if (!selection.requiresClient || props.clientName) {
      props.onSelect(selection);
      return;
    }

    pendingClientSkillRef.current =
      skills.find((candidate) => candidate.id === selection.skillId) ?? null;
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>('.meri-v3-scope-trigger')?.click();
    });
  };

  return (
    <MeriQuickActionsPanelView
      {...props}
      skills={skills}
      open={open}
      onOpenChange={setOpen}
      onSelect={handleSelect}
    />
  );
}
