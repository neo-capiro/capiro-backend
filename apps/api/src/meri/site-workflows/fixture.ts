import type { SiteWorkflowManifest } from '@capiro/shared/site-workflows';
export function workflowFixture(version = 1): SiteWorkflowManifest {
  return { schema: 'meri-site-workflow-manifest/0', siteId: 'public-records', workflowId: 'find-record',
    version, taskSummary: 'Find a public record', origins: ['https://records.example.com'],
    idpOrigins: ['https://login.example.com'], signInUrl: 'https://login.example.com/sign-in',
    signedInProbe: { kind: 'selector', value: '[data-signed-in]' }, sensitiveSelectors: ['input[type=password]'],
    tools: ['browser_navigate', 'browser_snapshot', 'browser_click'], approvalRequired: ['browser_click'],
    downloads: { formats: ['pdf'], maxBytes: 1000000, maxFiles: 1 }, sessionTtlMs: 3600000,
    logoutUrl: 'https://records.example.com/logout', tosReviewRef: 'terms:fixture', qualificationEvidenceRef: 'qualification:fixture' };
}

