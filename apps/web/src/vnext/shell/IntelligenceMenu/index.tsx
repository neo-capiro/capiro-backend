import { CapiroSubmenu, type CapiroNavItemModel } from '../Sidebar/index.js';

export function IntelligenceMenu({ items }: { items: CapiroNavItemModel[] }) {
  return <CapiroSubmenu label="Intelligence" items={items} />;
}
