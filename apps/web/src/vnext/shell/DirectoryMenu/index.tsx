import { CapiroSubmenu, type CapiroNavItemModel } from '../Sidebar/index.js';

export function DirectoryMenu({ items }: { items: CapiroNavItemModel[] }) {
  return <CapiroSubmenu label="Directory" items={items} />;
}
