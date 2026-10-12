import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import * as ts from 'typescript';

function apiRoot(): string {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, 'prisma/schema.prisma'))) return cwd;
  const candidate = resolve(cwd, 'apps/api');
  if (existsSync(resolve(candidate, 'prisma/schema.prisma'))) return candidate;
  throw new Error(`Could not resolve apps/api from ${cwd}.`);
}

const root = apiRoot();
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const readWeb = (path: string) => readFileSync(resolve(root, 'scripts/lib/__fixtures__/legacy-ui-contracts', `${path}.txt`), 'utf8');
const migration = read(
  'prisma/migrations/20260818050000_memory_admin_self_approval_policy/migration.sql',
);
const policy = read('src/memory/memory-review-admin-policy.ts');
const authorization = read('src/memory/memory-authorization.helpers.ts');
const authorizationService = read('src/memory/memory-authorization.service.ts');
const workflow = read('src/memory/memory-review-workflow.service.ts');
const candidate = read('src/memory/memory-candidate.service.ts');
const immutable = read('src/memory/immutable-memory-version.service.ts');
const adminInbox = read('src/memory/memory-review-admin-inbox.service.ts');
const dispatcher = read('src/memory/memory-review-notification-dispatcher.service.ts');
const notificationHelpers = read('src/memory/memory-review-notification.helpers.ts');
const moduleSource = read('src/memory/memory.module.ts');
const editor = readWeb('src/components/MemoryFileEditor.tsx');
const editorShared = readWeb('src/components/memory-file-editor-shared.ts');
const pendingPanel = readWeb('src/components/PendingMemoryReviewPanel.tsx');
const pendingShared = readWeb('src/components/pending-memory-review-shared.ts');
const reviewInbox = readWeb('src/components/MemoryReviewInbox.tsx');

describe('memory administrator self-approval policy contract', () => {
  it('permits only candidate- and actor-bound active tenant administrators at the database boundary', () => {
    expect(migration).toContain("tm.status = 'active'::membership_status");
    expect(migration).toContain("'user_admin'::tenant_role");
    expect(migration).toContain("'capiro_admin'::tenant_role");
    expect(migration).toContain(
      "current_setting('app.memory_admin_review_candidate_id', true)",
    );
    expect(migration).toContain(
      "current_setting('app.memory_admin_review_actor_id', true)",
    );
    expect(migration).toContain('capability_candidate_id = NEW.id::text');
    expect(migration).toContain('capability_actor_id = NEW.decided_by::text');
    expect(migration).toContain('actor_is_active_admin AND admin_decision_capability');
    expect(migration).toContain('MEMORY_REVIEW_SELF_DECISION_DENIED');
    expect(migration).toContain('MEMORY_REVIEW_ASSIGNED_REVIEWER_REQUIRED');
  });

  it('sets exact transaction-local capabilities only after canonical admin authorization', () => {
    expect(authorizationService).toContain('decision.allowed');
    expect(authorizationService).toContain('options.emitDenialMetrics !== false');
    expect(authorizationService).toContain('isMemoryReviewAdminRole(effectiveRole)');
    expect(authorizationService).toContain(
      "set_config('app.memory_admin_review_candidate_id', $1, true)",
    );
    expect(authorizationService).toContain(
      "set_config('app.memory_admin_review_actor_id', $1, true)",
    );
  });

  it('keeps walls and client status in canonical authorization while exempting admins from self-review denial', () => {
    expect(policy).toContain("role === 'user_admin' || role === 'capiro_admin'");
    expect(authorization).toContain('if (isMemoryReviewAdminRole(effectiveRole)) return false');
    expect(authorization).toContain("reason: 'ethical_wall'");
    expect(authorization).toContain("reason: 'archived_client'");
    expect(authorization).toContain("reason: 'self_review'");
  });

  it('makes assignment optional for admins but preserves it for standard reviewers', () => {
    expect(workflow).toContain('if (!isMemoryReviewAdminRole(ctx.role))');
    expect(workflow).toContain('workflow.assignedTo !== ctx.userId');
    expect(workflow).toContain('A non-admin proposer cannot decide');
    expect(candidate).toContain('isMemoryReviewAdminRole(actorContext?.role)');
    expect(immutable).toContain('!isMemoryReviewAdminRole(ctx.role)');
  });

  it('expands only the admin inbox path and batches current authorization checks', () => {
    expect(adminInbox).toContain('extends MemoryReviewInboxService');
    expect(adminInbox).toContain('if (!isMemoryReviewAdminRole(ctx.role)) return super.list');
    expect(adminInbox).toContain("requestedView === 'needs_my_review' ? 'all_pending'");
    expect(adminInbox).toContain('this.adminPrisma.withTenantUser');
    expect(adminInbox).toContain('this.adminAuthorization.loadCandidateInTx');
    expect(adminInbox).toContain("'approve'");
    expect(moduleSource).toContain(
      '{ provide: MemoryReviewInboxService, useExisting: MemoryReviewAdminInboxService }',
    );
  });

  it('removes the independent-approver claim from every active shared-memory UI surface', () => {
    const assertNoRebinding = (rootNode: ts.Node, name: string, allowedDefinition?: ts.Node): void => {
      const bindings: ts.Node[] = [];
      const visit = (node: ts.Node): void => {
        if (node !== allowedDefinition &&
          (ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isParameter(node) ||
            ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
          node.name && ts.isIdentifier(node.name) && node.name.text === name) bindings.push(node);
        if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && node.left.text === name &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) bindings.push(node);
        ts.forEachChild(node, visit);
      };
      visit(rootNode);
      expect(bindings).toHaveLength(0);
    };
    expect(editorShared).toContain('Submitted for approval');
    expect(editorShared).not.toContain('Submitted for independent review');
    // The editor delegates its success message to this existing UI-free owner.
    // Parse opaque source data so comments cannot stand in for the live definition
    // or renderer call. Neither fixture is imported or executed.
    const sharedTree = ts.createSourceFile('memory-file-editor-shared.ts', editorShared, ts.ScriptTarget.Latest, true);
    const successMessages = sharedTree.statements.filter(ts.isFunctionDeclaration)
      .filter((node) => node.name?.text === 'settingsMemorySuccessMessage');
    expect(successMessages).toHaveLength(1);
    expect(successMessages[0]!.getText(sharedTree)).toBe(
      "export function settingsMemorySuccessMessage(result: MemorySaveSectionsResp): string {\n" +
      "  return result.status === 'pending_review' ? 'Submitted for approval' : 'Saved';\n}",
    );
    assertNoRebinding(sharedTree, 'settingsMemorySuccessMessage', successMessages[0]);
    const editorTree = ts.createSourceFile('MemoryFileEditor.tsx', editor, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const successImports = editorTree.statements.filter(ts.isImportDeclaration)
      .filter((node) => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === './memory-file-editor-shared.js')
      .filter((node) => node.importClause && !node.importClause.isTypeOnly && node.importClause.phaseModifier === undefined && node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings) &&
        node.importClause.namedBindings.elements.some((entry) => !entry.isTypeOnly && entry.name.text === 'settingsMemorySuccessMessage' &&
          (entry.propertyName ?? entry.name).text === 'settingsMemorySuccessMessage'));
    expect(successImports).toHaveLength(1);
    const editorFunctions = editorTree.statements.filter(ts.isFunctionDeclaration)
      .filter((node) => node.name?.text === 'MemoryFileEditor');
    expect(editorFunctions).toHaveLength(1);
    expect(ts.getModifiers(editorFunctions[0]!)?.some((node) => node.kind === ts.SyntaxKind.ExportKeyword)).toBe(true);
    assertNoRebinding(editorTree, 'settingsMemorySuccessMessage');
    assertNoRebinding(editorTree, 'useMutation');
    const mutationImports = editorTree.statements.filter(ts.isImportDeclaration)
      .filter((node) => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === '@tanstack/react-query')
      .filter((node) => node.importClause && !node.importClause.isTypeOnly && node.importClause.phaseModifier === undefined && node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings) &&
        node.importClause.namedBindings.elements.some((entry) => !entry.isTypeOnly && entry.name.text === 'useMutation' &&
          (entry.propertyName ?? entry.name).text === 'useMutation'));
    expect(mutationImports).toHaveLength(1);
    const mutations = editorFunctions[0]!.body!.statements.filter(ts.isVariableStatement)
      .flatMap((node) => [...node.declarationList.declarations])
      .filter((node) => ts.isIdentifier(node.name) && node.name.text === 'saveMutation');
    expect(mutations).toHaveLength(1);
    const mutation = mutations[0]!.initializer!;
    expect(ts.isCallExpression(mutation)).toBe(true);
    const mutationCall = mutation as ts.CallExpression;
    expect(mutationCall.expression.getText(editorTree)).toBe('useMutation');
    expect(mutationCall.arguments).toHaveLength(1);
    expect(ts.isObjectLiteralExpression(mutationCall.arguments[0]!)).toBe(true);
    const mutationProperties = (mutationCall.arguments[0]! as ts.ObjectLiteralExpression).properties;
    expect(mutationProperties.every((node) => ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)))).toBe(true);
    const mutationNames = mutationProperties.map((node) =>
      ((node as ts.PropertyAssignment).name as ts.Identifier | ts.StringLiteral).text);
    expect(new Set(mutationNames).size).toBe(mutationProperties.length);
    const callbacks = mutationProperties.filter(ts.isPropertyAssignment)
      .filter((node) => (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === 'onSuccess');
    expect(callbacks).toHaveLength(1);
    expect(ts.isArrowFunction(callbacks[0]!.initializer)).toBe(true);
    const onSuccess = callbacks[0]!.initializer as ts.ArrowFunction;
    expect(onSuccess.parameters.map((node) => node.name.getText(editorTree))).toEqual(['result']);
    expect(ts.isBlock(onSuccess.body)).toBe(true);
    expect((onSuccess.body as ts.Block).statements[0]?.getText(editorTree)).toBe(
      'message.success(settingsMemorySuccessMessage(result));',
    );
    expect(editor).not.toContain('Submitted for independent review');
    expect(pendingShared).toContain('Waiting for approval');
    expect(pendingShared).not.toContain('independent reviewer');
    const pendingSharedTree = ts.createSourceFile('pending-memory-review-shared.ts', pendingShared, ts.ScriptTarget.Latest, true);
    const headlines = pendingSharedTree.statements.filter(ts.isFunctionDeclaration)
      .filter((node) => node.name?.text === 'pendingReviewHeadline');
    expect(headlines).toHaveLength(1);
    expect(headlines[0]!.getText(pendingSharedTree)).toBe(
      "export function pendingReviewHeadline(pending: PendingMemoryReviewState): string {\n" +
      "  return pending.blocked ? 'Review blocked' : 'Waiting for approval';\n}",
    );
    assertNoRebinding(pendingSharedTree, 'pendingReviewHeadline', headlines[0]);
    const panelTree = ts.createSourceFile('PendingMemoryReviewPanel.tsx', pendingPanel, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const headlineImports = panelTree.statements.filter(ts.isImportDeclaration)
      .filter((node) => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === './pending-memory-review-shared.js')
      .filter((node) => node.importClause && !node.importClause.isTypeOnly && node.importClause.phaseModifier === undefined && node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings) &&
        node.importClause.namedBindings.elements.some((entry) => !entry.isTypeOnly && entry.name.text === 'pendingReviewHeadline' &&
          (entry.propertyName ?? entry.name).text === 'pendingReviewHeadline'));
    expect(headlineImports).toHaveLength(1);
    const panels = panelTree.statements.filter(ts.isFunctionDeclaration)
      .filter((node) => node.name?.text === 'PendingMemoryReviewPanel');
    expect(panels).toHaveLength(1);
    expect(ts.getModifiers(panels[0]!)?.some((node) => node.kind === ts.SyntaxKind.ExportKeyword)).toBe(true);
    assertNoRebinding(panelTree, 'pendingReviewHeadline');
    expect(panels[0]!.body!.statements.every((node) => ts.isVariableStatement(node) || ts.isReturnStatement(node))).toBe(true);
    const returns = panels[0]!.body!.statements.filter(ts.isReturnStatement);
    expect(returns).toHaveLength(1);
    const alerts: ts.JsxSelfClosingElement[] = [];
    const collectAlerts = (node: ts.Node): void => {
      if (ts.isParenthesizedExpression(node)) collectAlerts(node.expression);
      else if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(panelTree) === 'Alert') alerts.push(node);
      else if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
        // This canonical Alert is an unconditional JSX child. Do not descend
        // into inert functions, conditional expressions, props or spreads.
        for (const child of node.children) {
          if (ts.isJsxElement(child) || ts.isJsxFragment(child) || ts.isJsxSelfClosingElement(child)) collectAlerts(child);
        }
      }
    };
    expect(returns[0]!.expression).toBeDefined();
    collectAlerts(returns[0]!.expression!);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.attributes.properties.filter(ts.isJsxSpreadAttribute)).toHaveLength(0);
    const messages = alerts[0]!.attributes.properties.filter(ts.isJsxAttribute)
      .filter((node) => node.name.getText(panelTree) === 'message');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.getText(panelTree)).toBe('message={pendingReviewHeadline(pending)}');
    expect(pendingPanel).not.toContain('independent reviewer');
    expect(reviewInbox).toContain('authorized administrator or reviewer approves it');
    expect(reviewInbox).not.toContain('independent reviewer approves it');
  });

  it('keeps Memory Review notifications in-app only', () => {
    expect(dispatcher).toContain('in-app notification table only');
    expect(dispatcher).not.toContain('MemoryReviewNotificationEmailService');
    expect(dispatcher).not.toContain('MEMORY_REVIEW_EMAIL_DELIVERY');
    expect(notificationHelpers).not.toContain('renderMemoryReviewNotificationEmail');
    expect(notificationHelpers).not.toContain('memoryReviewEmailDeliveryEnabled');
    expect(moduleSource).not.toContain('MemoryReviewNotificationEmailService');
  });
});
