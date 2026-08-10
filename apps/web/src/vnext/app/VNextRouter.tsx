import { Outlet } from 'react-router-dom';

/**
 * The canonical App.tsx route tree remains authoritative. vNext owns only the
 * presentation boundary, so route registration, deep links, feature gates and
 * page business logic are not duplicated here.
 */
export function VNextRouter() {
  return <Outlet />;
}
