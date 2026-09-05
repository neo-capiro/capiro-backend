import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const meriDir = resolve(process.cwd(), 'src/vnext/meri');

function readMeri(name: string): string {
  return readFileSync(resolve(meriDir, name), 'utf8');
}

describe('context rail panel head — CSS actually exists for what the JSX renders', () => {
  test('every class VNextMeriContextRail renders on the panel head has a real CSS rule', () => {
    const css = readMeri('vnext-meri.css');
    // Button-carried classes are addressed as `button.<class>` to beat the
    // `.vnext-meri button { font: inherit }` reset — accept either form.
    for (const cls of [
      ['.vnext-meri__rail-panel-head', '.capiro-vnext-root .vnext-meri__rail-panel-head {'],
      ['.vnext-meri__rail-panel-title', '.capiro-vnext-root .vnext-meri__rail-panel-title {'],
      ['.vnext-meri__rail-panel-tabs', '.capiro-vnext-root .vnext-meri__rail-panel-tabs {'],
      ['.vnext-meri__rail-panel-tab', '.capiro-vnext-root .vnext-meri button.vnext-meri__rail-panel-tab {'],
      ['.vnext-meri__rail-panel-tab-badge', '.capiro-vnext-root .vnext-meri__rail-panel-tab-badge {'],
      ['.vnext-meri__rail-panel-collapse', '.capiro-vnext-root .vnext-meri__rail-panel-collapse {'],
    ] as const) {
      expect(css, `missing CSS rule for ${cls[0]}`).toContain(cls[1]);
    }
  });

  test('the tab strip is a flex row, not a bare block div that wraps title/tabs/collapse onto separate lines', () => {
    const css = readMeri('vnext-meri.css');
    const headBlock = css.slice(css.indexOf('.vnext-meri__rail-panel-head {'), css.indexOf('.vnext-meri__rail-panel-head {') + 200);
    expect(headBlock).toMatch(/display:\s*flex/);
    const tabsBlock = css.slice(css.indexOf('.vnext-meri__rail-panel-tabs {'), css.indexOf('.vnext-meri__rail-panel-tabs {') + 120);
    expect(tabsBlock).toMatch(/display:\s*flex/);
  });
});

describe('context rail — exclusive Context/Memory switcher, not a 4-way accordion', () => {
  test('the tab strip is Context and Memory only — Sources and Skills are sections inside Context, not their own tabs', () => {
    const source = readMeri('VNextMeriContextRail.tsx');
    expect(source).toMatch(/key:\s*'context'/);
    expect(source).toMatch(/key:\s*'memory'/);
    expect(source).not.toMatch(/key:\s*'sources'/);
    expect(source).not.toMatch(/key:\s*'actions'/);
  });

  test('panel title matches the prototype exactly: Behind the answer / SOURCE DETAIL / ARTIFACT CANVAS', () => {
    const source = readMeri('VNextMeriContextRail.tsx');
    expect(source).toContain('Behind the answer');
    expect(source).not.toContain('CONVERSATION CONTEXT');
    expect(source).not.toContain('WHAT MERI REMEMBERS');
    expect(source).toContain('SOURCE DETAIL');
    expect(source).toContain('ARTIFACT CANVAS');
  });

  test('Connected Sources and Skills are gone from the rail — they live in the composer + menu', () => {
    const source = readMeri('VNextMeriContextRail.tsx');
    expect(source).not.toContain('CONNECTED SOURCES');
    expect(source).not.toContain('>SKILLS<');
    expect(source).not.toContain('Manage connections');
    expect(source).not.toContain('vnext-meri__rail-section-toggle');
    expect(source).not.toContain('setCtxOpen');
    expect(source).not.toContain('setSrcOpen');
    expect(source).not.toContain('setActOpen');
    expect(source).not.toContain('setMemOpen');
  });
});

describe('top-bar scope pill — divider and meta text use the tokens that actually resolve to the spec hex values', () => {
  test('the divider uses the #E8E5DF-resolving token, not one that resolves to a different gray', () => {
    const css = readMeri('vnext-meri.css');
    const block = css.slice(css.indexOf('.vnext-meri__scope-divider {'), css.indexOf('.vnext-meri__scope-divider {') + 150);
    expect(block).toContain('var(--m-gray-200)');
  });
});
