import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, test } from 'vitest';

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

interface MeriManifest {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  prefer_related_applications: boolean;
  icons: ManifestIcon[];
}

const webRoot = process.cwd();
const manifestPath = resolve(webRoot, 'public/meri-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as MeriManifest;

function pngDimensions(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function findVariableInitializer(sourceFile: ts.SourceFile, name: string): ts.Expression {
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      initializer = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!initializer) throw new Error(`Missing initializer for ${name}`);
  return initializer;
}

function findJsxAttributeExpression(
  sourceFile: ts.SourceFile,
  tagName: string,
  attributeName: string,
): ts.Expression {
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxOpeningLikeElement(node) &&
      node.tagName.getText(sourceFile) === tagName
    ) {
      const attribute = node.attributes.properties.find(
        (property): property is ts.JsxAttribute =>
          ts.isJsxAttribute(property) && property.name.getText(sourceFile) === attributeName,
      );
      if (attribute?.initializer && ts.isJsxExpression(attribute.initializer)) {
        expression = attribute.initializer.expression;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!expression) throw new Error(`Missing ${tagName}.${attributeName} JSX expression`);
  return expression;
}

describe('Meri installable-app contract', () => {
  test('launches the authenticated Meri route as a standalone app', () => {
    expect(manifest).toMatchObject({
      id: '/meri',
      name: 'Meri',
      short_name: 'Meri',
      start_url: '/meri',
      // Root scope keeps the Clerk sign-in route in the installed window.
      scope: '/',
      display: 'standalone',
      background_color: '#F2F4F7',
      theme_color: '#FFFFFF',
      prefer_related_applications: false,
    });
  });

  test.each([
    ['192x192', 192],
    ['512x512', 512],
  ] as const)('ships a real %s maskable PNG', (declaredSize, pixels) => {
    const icon = manifest.icons.find((candidate) => candidate.sizes === declaredSize);
    expect(icon).toBeDefined();
    expect(icon).toMatchObject({ type: 'image/png' });
    expect(icon?.purpose.split(/\s+/)).toContain('any');
    expect(icon?.purpose.split(/\s+/)).toContain('maskable');

    const iconPath = resolve(webRoot, 'public', icon!.src.replace(/^\//, ''));
    expect(existsSync(iconPath)).toBe(true);
    expect(pngDimensions(iconPath)).toEqual({ width: pixels, height: pixels });
  });

  test('keeps the shared legacy HTML free of an unconditional Meri manifest', () => {
    const html = readFileSync(resolve(webRoot, 'index.html'), 'utf8');
    const main = readFileSync(resolve(webRoot, 'src/main.tsx'), 'utf8');

    expect(html).not.toContain('meri-manifest.json');
    expect(main).toContain('initializeMeriInstallExperience();');
    expect(main.indexOf('initializeMeriInstallExperience();')).toBeGreaterThan(
      main.indexOf('} else {'),
    );
  });

  test('forces installed launches edge-to-edge and removes redundant internal window controls', () => {
    const shell = readFileSync(resolve(webRoot, 'src/vnext/meri/VNextMeriShell.tsx'), 'utf8');
    const topBar = readFileSync(resolve(webRoot, 'src/vnext/meri/VNextMeriTopBar.tsx'), 'utf8');
    const button = readFileSync(resolve(webRoot, 'src/vnext/meri/MeriInstallButton.tsx'), 'utf8');
    const sourceFile = ts.createSourceFile(
      'VNextMeriShell.tsx',
      shell,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    const effectiveChrome = findVariableInitializer(sourceFile, 'effectiveWindowChrome');
    expect(ts.isConditionalExpression(effectiveChrome)).toBe(true);
    if (!ts.isConditionalExpression(effectiveChrome)) return;
    expect(effectiveChrome.condition.getText(sourceFile)).toBe('install.isStandalone');
    expect(ts.isStringLiteral(effectiveChrome.whenTrue)).toBe(true);
    expect(ts.isStringLiteral(effectiveChrome.whenTrue) && effectiveChrome.whenTrue.text).toBe(
      'maximized',
    );
    expect(ts.isIdentifier(effectiveChrome.whenFalse)).toBe(true);
    expect(ts.isIdentifier(effectiveChrome.whenFalse) && effectiveChrome.whenFalse.text).toBe(
      'windowChrome',
    );

    const topBarChrome = findJsxAttributeExpression(
      sourceFile,
      'VNextMeriTopBar',
      'windowChrome',
    );
    expect(ts.isIdentifier(topBarChrome) && topBarChrome.text).toBe('effectiveWindowChrome');

    const controls = findJsxAttributeExpression(
      sourceFile,
      'VNextMeriTopBar',
      'showWindowControls',
    );
    expect(ts.isPrefixUnaryExpression(controls)).toBe(true);
    expect(
      ts.isPrefixUnaryExpression(controls) &&
        controls.operator === ts.SyntaxKind.ExclamationToken &&
        controls.operand.getText(sourceFile),
    ).toBe('install.isStandalone');

    expect(shell).toContain("install.isStandalone ? 'Meri' : 'Meri — Capiro'");
    expect(topBar).toContain('<MeriInstallButton />');
    expect(button).toContain('aria-label="Install Meri"');
  });
});
