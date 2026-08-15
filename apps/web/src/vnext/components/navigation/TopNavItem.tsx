import { NavLink } from 'react-router-dom';

/**
 * Navigation/TopItem (`432:133`) — the forward-standard *horizontal* navigation
 * item. Distinct from `CapiroNavItem`, which is the left-rail item: this one has
 * its own geometry (34px tall, 12px horizontal padding, shell-control radius)
 * and no icon slot, so it is a separate canonical component rather than a
 * restyle of the rail item.
 *
 * Rendered as a `NavLink` because Directory's tabs are real routes. That gives
 * keyboard focus, middle-click, and the current-destination state for free —
 * "State=Current" is `aria-current="page"`, not a private boolean.
 */
export interface CapiroTopNavItemProps {
  label: string;
  to: string;
  /** Renders the documented disabled state and stops navigation. */
  disabled?: boolean;
  /** Marks the item current for reasons routing can't see (e.g. a nested path). */
  current?: boolean;
}

export function CapiroTopNavItem({ label, to, disabled = false, current }: CapiroTopNavItemProps) {
  if (disabled) {
    return (
      <span
        className="capiro-top-nav-item capiro-top-nav-item--disabled"
        aria-disabled="true"
      >
        {label}
      </span>
    );
  }

  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        `capiro-top-nav-item${isActive || current ? ' capiro-top-nav-item--current' : ''}`
      }
      aria-current={current ? 'page' : undefined}
    >
      {label}
    </NavLink>
  );
}
