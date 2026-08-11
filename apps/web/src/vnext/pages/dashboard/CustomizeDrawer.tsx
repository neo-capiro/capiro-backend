import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { CapiroButton } from '../../components/actions/index.js';
import type {
  DashboardDensity,
  DashboardModuleKey,
  DashboardVNextModel,
} from '../../adapters/legacy/useDashboardVNextModel.js';
import type { NewsPolicyTopic } from '../../../pages/dashboard/DashboardNewsAndNarrative.js';

/**
 * Customize Dashboard drawer (Figma `754:2766`).
 *
 * A full-height right drawer — not a popover. It owns the three concerns the
 * customization contract (`760:2679`) keeps separate: module layout (visibility
 * plus order), news subscriptions, and information density.
 *
 * The subscription rows below render the *real* topic taxonomy from
 * `DashboardNewsAndNarrative`, not the mockup's illustrative labels: the design
 * fixes the row geometry, the product fixes which categories exist.
 */

const TOPIC_ROWS: ReadonlyArray<{ value: NewsPolicyTopic; label: string }> = [
  { value: 'legislation', label: 'Legislation' },
  { value: 'hearings', label: 'Hearings & markups' },
  { value: 'regulation', label: 'Regulation' },
  { value: 'budget', label: 'Budget & appropriations' },
  { value: 'procurement', label: 'Procurement & contracts' },
  { value: 'grants', label: 'Grants & funding' },
  { value: 'state', label: 'State policy' },
  { value: 'executive', label: 'Executive actions' },
];

const MODULE_COPY: Readonly<Record<DashboardModuleKey, { title: string; description: string }>> = {
  news: { title: 'News & Narrative', description: 'Subscription-driven feed' },
  today: { title: 'Today & Coming Up', description: 'Meetings and policy events' },
  work: { title: 'Work Queue', description: 'Outreach and work documents' },
};

const VISIBILITY_KEY: Readonly<Record<DashboardModuleKey, 'news' | 'today' | 'work'>> = {
  news: 'news',
  today: 'today',
  work: 'work',
};

const DENSITY_OPTIONS: ReadonlyArray<{ value: DashboardDensity; label: string }> = [
  { value: 'presentation', label: 'Presentation' },
  { value: 'standard', label: 'Standard' },
  { value: 'compact', label: 'Compact' },
];

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function CustomizeDrawer({
  model,
  onClose,
}: {
  model: DashboardVNextModel;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const [dragging, setDragging] = useState<DashboardModuleKey | null>(null);
  const [editingSources, setEditingSources] = useState(false);
  const [customDraft, setCustomDraft] = useState('');
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Same overlay contract as CapiroDrawer: Escape closes, focus is trapped and
  // restored, and the page behind cannot scroll.
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => element.tabIndex !== -1);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  const move = (key: DashboardModuleKey, delta: number) => {
    const current = [...model.order];
    const from = current.indexOf(key);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= current.length) return;
    current.splice(to, 0, ...current.splice(from, 1));
    model.setOrder(current);
  };

  const dropOn = (target: DashboardModuleKey) => {
    if (!dragging || dragging === target) return;
    const current = [...model.order].filter((key) => key !== dragging);
    current.splice(model.order.indexOf(target), 0, dragging);
    model.setOrder(current);
    setDragging(null);
  };

  const preferences = model.news.preferences;
  const toggleTopic = (topic: NewsPolicyTopic) => {
    const active = preferences.policyTopics.includes(topic);
    model.news.setPreferences({
      ...preferences,
      policyTopics: active
        ? preferences.policyTopics.filter((value) => value !== topic)
        : [...preferences.policyTopics, topic],
    });
  };

  const addCustomSource = () => {
    const value = customDraft.trim();
    if (!value || preferences.customTopics.includes(value)) return;
    model.news.setPreferences({ ...preferences, customTopics: [...preferences.customTopics, value] });
    setCustomDraft('');
  };

  const reset = () => {
    model.setVisibility({ news: true, today: true, work: true });
    model.setOrder(['news', 'today', 'work']);
    model.setDensity('standard');
  };

  const densityLabel =
    DENSITY_OPTIONS.find((option) => option.value === model.density)?.label ?? 'Standard';

  return (
    <div
      className="capiro-dash-drawer__scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Customize Dashboard"
        className="capiro-dash-drawer"
      >
        <div className="capiro-dash-drawer__body">
          <header className="capiro-dash-drawer__header">
            <div className="capiro-dash-drawer__header-row">
              <p className="capiro-dash-drawer__eyebrow">DASHBOARD CONFIGURATION</p>
              <button
                type="button"
                className="capiro-dash-drawer__close"
                aria-label="Close"
                onClick={onClose}
              >
                <X size={16} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </div>
            <h2 className="capiro-dash-drawer__title">Customize Dashboard</h2>
            <p className="capiro-dash-drawer__description">
              Choose optional modules, their order, feed subscriptions, and information density.
              Needs Attention remains pinned.
            </p>
          </header>

          <div className="capiro-dash-drawer__divider" />

          <div className="capiro-dash-drawer__section-head">
            <p className="capiro-dash-drawer__label">PINNED MODULE</p>
            <p className="capiro-dash-drawer__hint">Always visible</p>
          </div>

          {/* Needs Attention is excluded from hide/reorder and always renders
              first, per the customization contract (`760:2683`). */}
          <div className="capiro-dash-drawer__module capiro-dash-drawer__module--pinned">
            <span className="capiro-dash-drawer__grip" aria-hidden="true">
              ◆
            </span>
            <span className="capiro-dash-drawer__index">00</span>
            <span className="capiro-dash-drawer__module-copy">
              <span className="capiro-dash-drawer__module-title">Needs Attention</span>
              <span className="capiro-dash-drawer__module-meta">
                External and time-sensitive signals
              </span>
            </span>
            <span className="capiro-dash-drawer__pinned-pill">PINNED</span>
          </div>

          <div className="capiro-dash-drawer__section-head">
            <p className="capiro-dash-drawer__label">OPTIONAL MODULES</p>
            <p className="capiro-dash-drawer__hint">Drag to reorder</p>
          </div>

          {model.order.map((key, index) => {
            const copy = MODULE_COPY[key];
            const visible = model.visibility[VISIBILITY_KEY[key]];
            return (
              <div
                key={key}
                className="capiro-dash-drawer__module"
                data-dragging={dragging === key || undefined}
                draggable
                onDragStart={() => setDragging(key)}
                onDragEnd={() => setDragging(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => dropOn(key)}
              >
                {/* Drag is the designed affordance; arrow keys make the same
                    reorder reachable without a pointer. */}
                <button
                  type="button"
                  className="capiro-dash-drawer__grip capiro-dash-drawer__grip--button"
                  aria-label={`Reorder ${copy.title}. Position ${index + 1} of ${model.order.length}. Use arrow keys.`}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      move(key, -1);
                    } else if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      move(key, 1);
                    }
                  }}
                >
                  <span aria-hidden="true">⋮⋮</span>
                </button>
                <span className="capiro-dash-drawer__index">{`0${index + 1}`}</span>
                <span className="capiro-dash-drawer__module-copy">
                  <span className="capiro-dash-drawer__module-title">{copy.title}</span>
                  <span className="capiro-dash-drawer__module-meta">{copy.description}</span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={visible}
                  aria-label={`Show ${copy.title}`}
                  className="capiro-dash-drawer__switch"
                  onClick={() =>
                    model.setVisibility({
                      ...model.visibility,
                      [VISIBILITY_KEY[key]]: !visible,
                    })
                  }
                >
                  <span className="capiro-dash-drawer__switch-knob" aria-hidden="true" />
                </button>
              </div>
            );
          })}

          <div className="capiro-dash-drawer__divider" />

          <div className="capiro-dash-drawer__section-head">
            <p className="capiro-dash-drawer__label">NEWS &amp; NARRATIVE</p>
            <p className="capiro-dash-drawer__hint">Subscriptions</p>
          </div>

          <div className="capiro-dash-drawer__grid">
            {TOPIC_ROWS.map((topic) => {
              const checked = preferences.policyTopics.includes(topic.value);
              return (
                <button
                  key={topic.value}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  className="capiro-dash-drawer__grid-row"
                  data-checked={checked || undefined}
                  onClick={() => toggleTopic(topic.value)}
                >
                  <span className="capiro-dash-drawer__check" aria-hidden="true">
                    {checked ? '✓' : null}
                  </span>
                  <span className="capiro-dash-drawer__grid-label">{topic.label}</span>
                  <span className="capiro-dash-drawer__grid-action" />
                </button>
              );
            })}

            <div
              className="capiro-dash-drawer__grid-row"
              data-checked={preferences.customTopics.length > 0 || undefined}
            >
              <span className="capiro-dash-drawer__check" aria-hidden="true">
                {preferences.customTopics.length > 0 ? '✓' : null}
              </span>
              <span className="capiro-dash-drawer__grid-label">
                {preferences.customTopics.length === 1
                  ? '1 custom source'
                  : `${preferences.customTopics.length} custom sources`}
              </span>
              <button
                type="button"
                className="capiro-dash-drawer__grid-action capiro-dash-drawer__grid-action--button"
                aria-expanded={editingSources}
                onClick={() => setEditingSources((open) => !open)}
              >
                {editingSources ? 'Done' : 'Edit →'}
              </button>
            </div>

            {editingSources ? (
              <div className="capiro-dash-drawer__sources">
                {preferences.customTopics.map((source) => (
                  <span key={source} className="capiro-dash-drawer__source">
                    {source}
                    <button
                      type="button"
                      aria-label={`Remove ${source}`}
                      onClick={() =>
                        model.news.setPreferences({
                          ...preferences,
                          customTopics: preferences.customTopics.filter((value) => value !== source),
                        })
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
                <div className="capiro-dash-drawer__source-add">
                  <input
                    value={customDraft}
                    onChange={(event) => setCustomDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        addCustomSource();
                      }
                    }}
                    placeholder="Add a custom source or topic"
                    aria-label="Add a custom source or topic"
                  />
                  <CapiroButton size="compact" variant="secondary" onClick={addCustomSource}>
                    Add
                  </CapiroButton>
                </div>
              </div>
            ) : null}
          </div>

          <div className="capiro-dash-drawer__divider" />

          <div className="capiro-dash-drawer__section-head">
            <p className="capiro-dash-drawer__label">INFORMATION DENSITY</p>
            <p className="capiro-dash-drawer__hint">Current: {densityLabel}</p>
          </div>

          <div className="capiro-dash-drawer__density" role="group" aria-label="Information density">
            {DENSITY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className="capiro-dash-drawer__density-option"
                aria-pressed={model.density === option.value}
                onClick={() => model.setDensity(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <footer className="capiro-dash-drawer__footer">
          <CapiroButton size="compact" variant="quiet" onClick={reset}>
            Reset
          </CapiroButton>
          <CapiroButton size="compact" variant="primary" onClick={onClose}>
            Done
          </CapiroButton>
        </footer>
      </section>
    </div>
  );
}
