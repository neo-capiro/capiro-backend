/*
 * Phase 1 §4.1–4.5 — the compact editor header contract.
 *
 * Every geometry literal here is measured from the locked prototype
 * (`Capiro - Strategy Planner (PPBE) - standalone (2).html`, StrategyView) in
 * Chrome at a 1440px viewport. Sizes expressed as design tokens are asserted as
 * the token reference AND pinned to their px value in strategy-ds.css by the
 * last describe block, so "exact style values" is verified end to end without a
 * layout engine.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { StrategyHeader, type StrategyHeaderProps } from './StrategyHeader.js';

const GOAL =
  'Secure a $10M FY27 plus-up by justifying the program early, engaging HAC-D and SAC-D through markup, and tracking conference to enactment.';

function props(over: Partial<StrategyHeaderProps> = {}): StrategyHeaderProps {
  return {
    onBack: vi.fn(),
    clientLabel: 'Brightdefense',
    typeLabel: 'Appropriations ask',
    title: 'FY27 Compliance Program Funding & Authorization',
    goal: GOAL,
    layers: { ppbe: true, congress: true },
    onToggleLayer: vi.fn(),
    watch: { on: true, pending: 5 },
    onOpenWatch: vi.fn(),
    onExport: vi.fn(),
    onHistory: vi.fn(),
    onAskMeri: vi.fn(),
    meriPanelOpen: false,
    meriEnabled: true,
    ...over,
  };
}

const el = (id: string) => screen.getByTestId(id);

describe('StrategyHeader — measured geometry (§4.1)', () => {
  test('outer padding, border and surface match the prototype', () => {
    render(<StrategyHeader {...props()} />);
    const header = el('sp-header');
    expect(header.style.padding).toBe('12px 26px 14px');
    expect(header.style.borderBottom).toBe('1px solid var(--border-1)');
    expect(header.style.background).toBe('var(--bg-surface)');
    expect(header.style.flexShrink).toBe('0');
  });

  test('row 1 is a 12px-gap flex row with a 30x30 back button', () => {
    render(<StrategyHeader {...props()} />);
    const row1 = el('sp-header-row1');
    expect(row1.style.display).toBe('flex');
    expect(row1.style.alignItems).toBe('center');
    expect(row1.style.gap).toBe('12px');

    const back = screen.getByRole('button', { name: 'Back to strategies' });
    expect(back.style.width).toBe('30px');
    expect(back.style.height).toBe('30px');
    expect(back.style.flexShrink).toBe('0');
  });

  test('the eyebrow is 10px uppercase bold at 0.06em', () => {
    render(<StrategyHeader {...props()} />);
    const eyebrow = el('sp-header-eyebrow');
    expect(eyebrow).toHaveTextContent('Brightdefense · Appropriations ask');
    expect(eyebrow.style.fontSize).toBe('var(--text-2xs)');
    expect(eyebrow.style.fontWeight).toBe('700');
    expect(eyebrow.style.textTransform).toBe('uppercase');
    expect(eyebrow.style.letterSpacing).toBe('0.06em');
  });

  test('the title is 22px at line-height 1.2', () => {
    render(<StrategyHeader {...props()} />);
    const title = el('sp-header-title');
    expect(title.style.fontSize).toBe('22px');
    expect(title.style.lineHeight).toBe('1.2');
    expect(title.style.fontWeight).toBe('700');
    expect(title.style.letterSpacing).toBe('-0.02em');
  });

  test('the goal sits 2px under the title at 11.5px', () => {
    render(<StrategyHeader {...props()} />);
    const goal = el('sp-header-goal');
    expect(goal.style.marginTop).toBe('2px');
    expect(goal.style.fontSize).toBe('var(--text-xs)');
    expect(goal.style.lineHeight).toBe('1.35');
  });

  test('row 2 is 10px below row 1 with an 8px gap', () => {
    render(<StrategyHeader {...props()} />);
    const row2 = el('sp-header-row2');
    expect(row2.style.marginTop).toBe('10px');
    expect(row2.style.gap).toBe('8px');
    expect(row2.style.alignItems).toBe('center');
    expect(row2.style.flexWrap).toBe('wrap');
    expect(row2.style.rowGap).toBe('8px');
  });

  test('row 1 content order is back → eyebrow → title → goal', () => {
    render(<StrategyHeader {...props()} />);
    const row1 = el('sp-header-row1');
    expect(row1.children[0]!.tagName).toBe('BUTTON');
    const textCol = row1.children[1] as HTMLElement;
    expect(textCol.style.flex).toBe('1 1 0%'); // jsdom expands the `flex: 1` shorthand
    expect(textCol.style.minWidth).toBe('0px');
    expect([...textCol.children].map((c) => c.getAttribute('data-testid'))).toEqual([
      'sp-header-eyebrow',
      'sp-header-title',
      'sp-header-goal',
    ]);
  });

  test('row 2 content order ends Watch → Export → History → Ask Meri', () => {
    render(<StrategyHeader {...props()} />);
    const labels = [...el('sp-header-row2').children].map((c) => (c.textContent || '').trim());
    expect(labels).toEqual(['Layers', 'PPBE', 'Congress', '', 'Watching5', 'Export', 'History', 'Ask Meri']);
    // the flexible spacer is the element between the chips and the Watch chip
    const spacer = el('sp-header-row2').children[3] as HTMLElement;
    expect(spacer.style.flex).toBe('1 1 0%');
  });
});

describe('StrategyHeader — one-line truncation (§4.2, §4.3)', () => {
  test('title and goal both truncate instead of wrapping', () => {
    render(<StrategyHeader {...props()} />);
    for (const id of ['sp-header-title', 'sp-header-goal']) {
      const node = el(id);
      expect(node.style.whiteSpace).toBe('nowrap');
      expect(node.style.overflow).toBe('hidden');
      expect(node.style.textOverflow).toBe('ellipsis');
    }
  });

  test('the goal exposes the COMPLETE goal as its tooltip', () => {
    render(<StrategyHeader {...props()} />);
    const goal = el('sp-header-goal');
    // the tooltip is the goal itself — not the rendered "Goal · …" prefix
    expect(goal).toHaveAttribute('title', GOAL);
    expect(goal.getAttribute('title')).not.toContain('Goal · ');
    // …while the visible line keeps the label
    expect(goal).toHaveTextContent(`Goal · ${GOAL}`);
  });

  test('a strategy with no goal renders no goal line at all', () => {
    render(<StrategyHeader {...props({ goal: null })} />);
    expect(screen.queryByTestId('sp-header-goal')).toBeNull();
  });
});

describe('StrategyHeader — Add step gating (§4.4, §4.5)', () => {
  test('Meri-enabled: no Add step, and Ask Meri is the CTA', () => {
    render(<StrategyHeader {...props({ meriEnabled: true, onAddStep: undefined })} />);
    expect(screen.queryByRole('button', { name: /add step/i })).toBeNull();
    expect(screen.getByRole('button', { name: /ask meri/i })).toBeInTheDocument();
  });

  test('Meri-enabled: an Add step callback is still not rendered', () => {
    render(<StrategyHeader {...props({ meriEnabled: true, onAddStep: vi.fn() })} />);
    expect(screen.queryByRole('button', { name: /add step/i })).toBeNull();
  });

  test('Meri-disabled: the manual Add step fallback is present and wired', () => {
    const onAddStep = vi.fn();
    render(<StrategyHeader {...props({ meriEnabled: false, onAddStep })} />);
    fireEvent.click(screen.getByRole('button', { name: /add step/i }));
    expect(onAddStep).toHaveBeenCalledTimes(1);
    // …and the accent CTA is replaced by the manual panel opener
    expect(screen.queryByRole('button', { name: /ask meri/i })).toBeNull();
    expect(screen.getByRole('button', { name: /edit panel/i })).toBeInTheDocument();
  });

  /*
   * Phase 7 (Lia) accepted the full-width header over the prototype's shrinking
   * one, on two conditions. These are those conditions.
   */
  test('with the panel open the CTA becomes the collapse control, not nothing', () => {
    const onClosePanel = vi.fn();
    const onAskMeri = vi.fn();
    render(<StrategyHeader {...props({ meriPanelOpen: true, onClosePanel, onAskMeri })} />);

    // It is still there, and it now collapses rather than re-opening.
    const toggle = el('sp-header-meri-toggle');
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveTextContent(/collapse/i);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(onClosePanel).toHaveBeenCalledTimes(1);
    expect(onAskMeri).not.toHaveBeenCalled();
  });

  test('with the panel closed it is the Ask Meri CTA again', () => {
    const onClosePanel = vi.fn();
    const onAskMeri = vi.fn();
    render(<StrategyHeader {...props({ meriPanelOpen: false, onClosePanel, onAskMeri })} />);
    const toggle = el('sp-header-meri-toggle');
    expect(toggle).toHaveTextContent(/ask meri/i);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(onAskMeri).toHaveBeenCalledTimes(1);
    expect(onClosePanel).not.toHaveBeenCalled();
  });

  test('the Meri-off fallback toggles the same way', () => {
    const onClosePanel = vi.fn();
    render(
      <StrategyHeader {...props({ meriEnabled: false, meriPanelOpen: true, onClosePanel })} />,
    );
    const toggle = el('sp-header-meri-toggle');
    expect(toggle).toHaveTextContent(/collapse/i);
    fireEvent.click(toggle);
    expect(onClosePanel).toHaveBeenCalledTimes(1);
  });

  test('the Watch chip stays visible AND clickable while the panel is open', () => {
    const onOpenWatch = vi.fn();
    render(
      <StrategyHeader
        {...props({ meriPanelOpen: true, watch: { on: true, pending: 5 }, onOpenWatch })}
      />,
    );
    const chip = el('sp-header-watch');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent('Watching');
    expect(chip).not.toBeDisabled();
    fireEvent.click(chip);
    expect(onOpenWatch).toHaveBeenCalledTimes(1);
  });
});

describe('StrategyHeader — Watch chip (§3 Step 3)', () => {
  test('shows Watching plus the pending count and opens the panel', () => {
    const onOpenWatch = vi.fn();
    render(<StrategyHeader {...props({ watch: { on: true, pending: 3 }, onOpenWatch })} />);
    const chip = el('sp-header-watch');
    expect(chip).toHaveTextContent('Watching');
    expect(chip).toHaveTextContent('3');
    fireEvent.click(chip);
    expect(onOpenWatch).toHaveBeenCalledTimes(1);
  });

  test('shows Watch off when the mission is not active', () => {
    render(<StrategyHeader {...props({ watch: { on: false, pending: 0 } })} />);
    expect(el('sp-header-watch')).toHaveTextContent('Watch off');
  });

  test('is absent entirely for a tenant without Watch', () => {
    render(<StrategyHeader {...props({ watch: null })} />);
    expect(screen.queryByTestId('sp-header-watch')).toBeNull();
  });

  test('never says "rail" in user-visible copy or labels', () => {
    const { container } = render(<StrategyHeader {...props()} />);
    expect(container.textContent?.toLowerCase()).not.toContain('rail');
    for (const node of container.querySelectorAll('[title], [aria-label]')) {
      expect((node.getAttribute('title') ?? '').toLowerCase()).not.toContain('rail');
      expect((node.getAttribute('aria-label') ?? '').toLowerCase()).not.toContain('rail');
    }
  });
});

describe('type-scale tokens resolve to the prototype px values', () => {
  test('strategy-ds.css pins --text-2xs and --text-xs', () => {
    // vitest runs with apps/web as the cwd.
    const css = readFileSync(resolve('src/pages/strategy/strategy-ds.css'), 'utf8');
    // the eyebrow (--text-2xs) and goal (--text-xs) sizes the prototype renders
    expect(css).toMatch(/--text-2xs:\s*10px/);
    expect(css).toMatch(/--text-xs:\s*11\.5px/);
  });
});
