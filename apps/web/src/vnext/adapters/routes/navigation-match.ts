import type { VNextRouteDefinition } from './routeManifest.js';

/** Detail routes keep the navigation identity of their parent workspace. */
export function navigationRouteMatches(route: VNextRouteDefinition, pathname: string): boolean {
  if (route.id === 'legiwatch' && (/^\/bills(?:\/|$)/.test(pathname) || /^\/intelligence\/hearing-watch(?:\/|$)/.test(pathname))) return true;
  return Boolean(route.path && (pathname === route.path || pathname.startsWith(`${route.path}/`)));
}
