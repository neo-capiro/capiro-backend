import { expect, test } from 'vitest';
import { VNEXT_ROUTE_MANIFEST } from './routeManifest.js';
import { navigationRouteMatches } from './navigation-match.js';
import { topbarSectionLabel } from '../../shell/AppShellUui/index.js';

test('bill dossiers and saved hearing rooms retain their LegiWatch navigation identity', () => {
  const legiwatch = VNEXT_ROUTE_MANIFEST.find((route) => route.id === 'intelligence')!.children!.find((child) => child.id === 'legiwatch')!;
  for (const path of ['/bills/HB1211', '/intelligence/hearing-watch/session-id', '/legiwatch/hearings/hearing-id']) {
    expect(navigationRouteMatches(legiwatch, path)).toBe(true);
    expect(topbarSectionLabel(path, VNEXT_ROUTE_MANIFEST)).toBe('Intelligence');
  }
  expect(navigationRouteMatches(legiwatch, '/bills-not-real')).toBe(false);
});
