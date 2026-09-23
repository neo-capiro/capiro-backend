import { describe, expect, it } from 'vitest';
import { VNEXT_ROUTE_MANIFEST, visibleVNextRoutes } from './routeManifest.js';

function intelligenceProgramElementsEntry(routes: ReturnType<typeof visibleVNextRoutes>) {
  const intelligence = routes.find((r) => r.id === 'intelligence');
  return intelligence?.children?.find((c) => c.id === 'program-elements');
}

describe('routeManifest — all-tenant Defense Budget navigation', () => {
  it('shows "Defense Budget" for the capiro-internal tenant', () => {
    const visible = visibleVNextRoutes(VNEXT_ROUTE_MANIFEST, { tenantSlug: 'capiro-internal' });
    expect(intelligenceProgramElementsEntry(visible)?.label).toBe('Defense Budget');
  });

  it('shows "Defense Budget" for every other tenant', () => {
    const visible = visibleVNextRoutes(VNEXT_ROUTE_MANIFEST, { tenantSlug: 'acme-federal' });
    expect(intelligenceProgramElementsEntry(visible)?.label).toBe('Defense Budget');
  });

  it('shows "Defense Budget" when no tenant slug is known yet', () => {
    const visible = visibleVNextRoutes(VNEXT_ROUTE_MANIFEST, {});
    expect(intelligenceProgramElementsEntry(visible)?.label).toBe('Defense Budget');
  });

  it('never changes the route id or path for either tenant', () => {
    const internal = intelligenceProgramElementsEntry(
      visibleVNextRoutes(VNEXT_ROUTE_MANIFEST, { tenantSlug: 'capiro-internal' }),
    );
    const other = intelligenceProgramElementsEntry(
      visibleVNextRoutes(VNEXT_ROUTE_MANIFEST, { tenantSlug: 'acme-federal' }),
    );
    expect(internal?.path).toBe('/program-elements');
    expect(other?.path).toBe('/program-elements');
    expect(internal?.id).toBe('program-elements');
    expect(other?.id).toBe('program-elements');
  });

  it('does not relabel unrelated routes for capiro-internal', () => {
    const visible = visibleVNextRoutes(VNEXT_ROUTE_MANIFEST, { tenantSlug: 'capiro-internal' });
    const intelligence = visible.find((r) => r.id === 'intelligence');
    expect(intelligence?.children?.find((c) => c.id === 'legiwatch')?.label).toBe('LegiWatch');
    expect(intelligence?.children?.find((c) => c.id === 'data-explorer')?.label).toBe('Data Explorer');
  });
});

describe('routeManifest — Portfolio inline navigation', () => {
  it('exposes the prototype children in order without inventing a Coalitions route', () => {
    const portfolio = VNEXT_ROUTE_MANIFEST.find((route) => route.id === 'portfolio');
    expect(portfolio?.children?.map((child) => child.label)).toEqual([
      'Clients',
      'Defense Budget',
      'Coalitions',
    ]);
    expect(portfolio?.children?.map((child) => child.path)).toEqual([
      '/clients',
      '/program-elements',
      null,
    ]);
    expect(portfolio?.children?.[2]?.availability).toBe('gap');
  });
});
