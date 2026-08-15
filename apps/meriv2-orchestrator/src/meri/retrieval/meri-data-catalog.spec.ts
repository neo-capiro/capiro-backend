import {
  MERI_DATASET_CATALOG,
  meriDatasetsForTool,
  meriRecipeCatalogEntry,
} from './meri-data-catalog.js';
import { meriToolCoverageCatalogEntry } from './meri-tool-catalog.js';

describe('Meri retrieval data catalog', () => {
  test('catalogs the Meri-critical structured and public domains', () => {
    const ids = MERI_DATASET_CATALOG.map((dataset) => dataset.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        'client_portfolio',
        'client_documents',
        'mail_messages',
        'meetings_and_debriefs',
        'engagement_tasks',
        'action_items',
        'outreach',
        'institutional_memory',
        'tracked_legislation',
        'committee_hearings',
        'government_directory',
        'regulatory_dockets',
        'federal_intelligence_sources',
        'economic_data',
        'defense_budget',
        'federal_opportunities',
        'client_funding_pipeline',
        'federal_awards',
        'federal_grants',
        'public_registries',
        'public_web',
      ]),
    );
  });

  test('records authoritative time semantics and query capabilities', () => {
    const mail = MERI_DATASET_CATALOG.find((dataset) => dataset.id === 'mail_messages');
    const tasks = MERI_DATASET_CATALOG.find((dataset) => dataset.id === 'engagement_tasks');

    expect(mail).toEqual(
      expect.objectContaining({
        timeSemantics: expect.objectContaining({ occurredAt: ['sentAt', 'receivedAt'] }),
      }),
    );
    expect(tasks).toEqual(
      expect.objectContaining({
        timeSemantics: expect.objectContaining({
          changedAt: ['updatedAt', 'completedAt'],
          deadlineAt: ['dueDate'],
        }),
        authority: expect.arrayContaining(['task status', 'task deadline']),
      }),
    );
  });

  test('does not call a bounded profile or top-k research result exhaustive', () => {
    expect(meriToolCoverageCatalogEntry('get_client_context')).toEqual(
      expect.objectContaining({
        domains: expect.arrayContaining(['clients', 'internal_research']),
        exhaustive: false,
      }),
    );
    expect(meriToolCoverageCatalogEntry('search_research_sources')).toEqual(
      expect.objectContaining({
        domains: ['internal_research'],
        exhaustive: false,
      }),
    );
    expect(meriToolCoverageCatalogEntry('query_tasks').exhaustive).toBe(false);
    expect(meriToolCoverageCatalogEntry('search_tracked_bills').exhaustive).toBe(false);
  });

  test('keeps count-backed email search distinct from bounded newest-thread listing', () => {
    expect(meriToolCoverageCatalogEntry('search_emails')).toEqual(
      expect.objectContaining({ domains: ['mail'], exhaustive: true }),
    );
    expect(meriToolCoverageCatalogEntry('list_emails')).toEqual(
      expect.objectContaining({ domains: ['mail'], exhaustive: false }),
    );
  });

  test('links tools back to their catalog datasets', () => {
    expect(meriDatasetsForTool('search_emails').map((dataset) => dataset.id)).toEqual([
      'mail_messages',
    ]);
    expect(meriDatasetsForTool('get_program_element').map((dataset) => dataset.id)).toEqual([
      'defense_budget',
    ]);
    expect(meriDatasetsForTool('read_client_documents').map((dataset) => dataset.id)).toEqual([
      'client_documents',
    ]);
    expect(meriDatasetsForTool('get_opportunity_client_context').map((dataset) => dataset.id)).toEqual([
      'client_funding_pipeline',
    ]);
  });

  test('keeps recipe domain requirements in one catalog contract', () => {
    const recipe = meriRecipeCatalogEntry('query_portfolio_changes');

    expect(recipe.requiredDomains).toEqual(
      expect.arrayContaining(['clients', 'mail', 'meetings', 'tasks', 'legislation']),
    );
    expect(recipe.optionalDomains).toEqual(
      expect.arrayContaining(['opportunities', 'hearings', 'regulatory', 'intelligence']),
    );
    expect(recipe.recommendedTools[0]).toBe('query_portfolio_changes');
  });
});
