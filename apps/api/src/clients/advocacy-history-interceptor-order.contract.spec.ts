import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Advocacy History read-presentation interceptor order', () => {
  const moduleSource = readFileSync(resolve(process.cwd(), 'src/clients/clients.module.ts'), 'utf8');

  test('runs semantic LDA presentation before the final Matter/Timeline hierarchy on responses', () => {
    const hierarchyProvider = moduleSource.indexOf('useClass: AdvocacyHistoryHierarchyInterceptor');
    const presentationProvider = moduleSource.indexOf('useClass: AdvocacyHistoryPresentationInterceptor');

    expect(hierarchyProvider).toBeGreaterThan(-1);
    expect(presentationProvider).toBeGreaterThan(-1);
    // Nest interceptors receive requests in provider order and unwind responses
    // in reverse. Registering hierarchy first therefore means the existing LDA
    // semantic presentation transforms the handler response before hierarchy
    // applies the final Matter-vs-event labels.
    expect(hierarchyProvider).toBeLessThan(presentationProvider);
  });
});
