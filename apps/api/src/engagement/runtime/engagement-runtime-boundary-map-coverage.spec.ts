import { describe, expect, it } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { guardedEngagementAiMethods } from './engagement-ai-runtime.boundary.js';
import {
  GMAIL_SEND_RUNTIME_METHODS,
  GOOGLE_OAUTH_RUNTIME_METHODS,
  GOOGLE_SYNC_RUNTIME_METHODS,
  GOOGLE_TOKEN_RUNTIME_METHODS,
  MICROSOFT_GRAPH_RUNTIME_METHODS,
  MICROSOFT_OAUTH_RUNTIME_METHODS,
} from './engagement-integration-runtime.boundary.js';
import {
  MEETING_BOT_EXTERNAL_METHODS,
  NOTETAKER_BACKGROUND_METHODS,
  NOTETAKER_EXTERNAL_METHODS,
} from './engagement-notetaker-runtime.boundary.js';
import { guardedEngagementServiceMethods } from '../governed-engagement.factory.js';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');

interface BoundaryTarget {
  className: string;
  sourceFile: string;
  methods: Iterable<string>;
}

const TARGETS: BoundaryTarget[] = [
  {
    className: 'EngagementAiService',
    sourceFile: 'apps/api/src/engagement/engagement-ai.service.ts',
    methods: Object.keys(guardedEngagementAiMethods()),
  },
  {
    className: 'EngagementService',
    sourceFile: 'apps/api/src/engagement/engagement.service.ts',
    methods: Object.keys(guardedEngagementServiceMethods()),
  },
  {
    className: 'MicrosoftGraphSyncService',
    sourceFile: 'apps/api/src/engagement/microsoft/microsoft-graph-sync.service.ts',
    methods: Object.keys(MICROSOFT_GRAPH_RUNTIME_METHODS),
  },
  {
    className: 'MicrosoftOAuthService',
    sourceFile: 'apps/api/src/engagement/microsoft/microsoft-oauth.service.ts',
    methods: Object.keys(MICROSOFT_OAUTH_RUNTIME_METHODS),
  },
  {
    className: 'GoogleTokenService',
    sourceFile: 'apps/api/src/engagement/google/google-token.service.ts',
    methods: Object.keys(GOOGLE_TOKEN_RUNTIME_METHODS),
  },
  {
    className: 'GoogleSyncService',
    sourceFile: 'apps/api/src/engagement/google/google-sync.service.ts',
    methods: Object.keys(GOOGLE_SYNC_RUNTIME_METHODS),
  },
  {
    className: 'GoogleOAuthService',
    sourceFile: 'apps/api/src/engagement/google/google-oauth.service.ts',
    methods: Object.keys(GOOGLE_OAUTH_RUNTIME_METHODS),
  },
  {
    className: 'GmailSendService',
    sourceFile: 'apps/api/src/engagement/google/gmail-send.service.ts',
    methods: Object.keys(GMAIL_SEND_RUNTIME_METHODS),
  },
  {
    className: 'NotetakerService',
    sourceFile: 'apps/api/src/engagement/notetaker/notetaker.service.ts',
    methods: [
      ...Object.keys(NOTETAKER_EXTERNAL_METHODS),
      ...NOTETAKER_BACKGROUND_METHODS,
    ],
  },
  {
    className: 'RecallProvider',
    sourceFile: 'apps/api/src/engagement/notetaker/recall.provider.ts',
    methods: Object.keys(MEETING_BOT_EXTERNAL_METHODS),
  },
];

const RAW_TOKEN_ALLOWED_FILES: Readonly<Record<string, ReadonlySet<string>>> = {
  RAW_MEETING_BOT_PROVIDER: new Set([
    'apps/api/src/engagement/notetaker/notetaker.module.ts',
    'apps/api/src/engagement/engagement.module.ts',
  ]),
  RAW_GOOGLE_TOKEN_SERVICE: new Set([
    'apps/api/src/engagement/runtime/engagement-integration-runtime.boundary.ts',
    'apps/api/src/engagement/engagement.module.ts',
  ]),
  RAW_MICROSOFT_GRAPH_SYNC_SERVICE: new Set([
    'apps/api/src/engagement/runtime/engagement-integration-runtime.boundary.ts',
    'apps/api/src/engagement/engagement.module.ts',
  ]),
  RAW_MICROSOFT_OAUTH_SERVICE: new Set([
    'apps/api/src/engagement/runtime/engagement-integration-runtime.boundary.ts',
    'apps/api/src/engagement/engagement.module.ts',
  ]),
  RAW_GOOGLE_SYNC_SERVICE: new Set([
    'apps/api/src/engagement/runtime/engagement-integration-runtime.boundary.ts',
    'apps/api/src/engagement/engagement.module.ts',
  ]),
  RAW_GOOGLE_OAUTH_SERVICE: new Set([
    'apps/api/src/engagement/runtime/engagement-integration-runtime.boundary.ts',
    'apps/api/src/engagement/engagement.module.ts',
  ]),
  RAW_GMAIL_SEND_SERVICE: new Set([
    'apps/api/src/engagement/runtime/engagement-integration-runtime.boundary.ts',
    'apps/api/src/engagement/engagement.module.ts',
  ]),
  RAW_ENGAGEMENT_SERVICE: new Set([
    'apps/api/src/engagement/governed-engagement.factory.ts',
    'apps/api/src/engagement/engagement.module.ts',
  ]),
};

function publicMethodNames(target: BoundaryTarget): Set<string> {
  const absolute = path.join(REPO_ROOT, target.sourceFile);
  const source = readFileSync(absolute, 'utf8');
  const file = ts.createSourceFile(
    absolute,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const names = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === target.className) {
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
        const modifiers = ts.getModifiers(member) ?? [];
        const privateMethod = modifiers.some(
          (modifier) =>
            modifier.kind === ts.SyntaxKind.PrivateKeyword ||
            modifier.kind === ts.SyntaxKind.ProtectedKeyword ||
            modifier.kind === ts.SyntaxKind.StaticKeyword,
        );
        if (!privateMethod) names.add(member.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

function productionTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...productionTypeScriptFiles(absolute));
    else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts')
    ) {
      files.push(absolute);
    }
  }
  return files;
}

describe('Engagement runtime boundary map coverage', () => {
  it.each(TARGETS.map((target) => [target.className, target] as const))(
    '%s map references only real public methods',
    (_className, target) => {
      const publicMethods = publicMethodNames(target);
      const missing = [...target.methods].filter((method) => !publicMethods.has(method));
      expect(missing).toEqual([]);
    },
  );

  it('wires every raw provider token to a guarded public provider in EngagementModule', () => {
    const moduleFile = path.join(REPO_ROOT, 'apps/api/src/engagement/engagement.module.ts');
    const source = readFileSync(moduleFile, 'utf8');
    for (const token of Object.keys(RAW_TOKEN_ALLOWED_FILES)) {
      expect(source).toContain(token);
    }
    for (const factory of [
      'guardMeetingBotProvider',
      'guardGoogleTokenService',
      'guardMicrosoftGraphSyncService',
      'guardMicrosoftOAuthService',
      'guardGoogleSyncService',
      'guardGoogleOAuthService',
      'guardGmailSendService',
      'guardEngagementAiService',
      'guardNotetakerService',
      'createGovernedEngagementService',
    ]) {
      expect(source).toContain(factory);
    }
  });

  it('allows no production raw-token injection outside the approved factories', () => {
    const files = productionTypeScriptFiles(path.join(REPO_ROOT, 'apps/api/src'));
    const violations: string[] = [];
    for (const filename of files) {
      const relative = path.relative(REPO_ROOT, filename).replace(/\\/g, '/');
      const source = readFileSync(filename, 'utf8');
      for (const [token, allowedFiles] of Object.entries(RAW_TOKEN_ALLOWED_FILES)) {
        if (source.includes(token) && !allowedFiles.has(relative)) {
          violations.push(`${token} used by ${relative}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
