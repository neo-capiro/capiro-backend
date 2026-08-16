import { openVNextMeriWorkspaceWindow } from '../../../components/chat/meri-window.js';
import { CapiroButton } from '../../components/actions/index.js';
import { DashboardIcon } from '../../components/untitledui/dashboard-icons.js';
import { MERI_LOGO_SRC } from '../../meri/meri-presentation.js';

export interface MeriLauncherProps {
  label?: string;
  onLaunch?: () => void;
}

/**
 * Top-bar Meri entry. Clicking opens the undocked Meri v3 workspace window
 * directly (`/meri` in the reusable popup shell) — there is no intermediate
 * prompt menu.
 */
export function MeriLauncher({ label = 'Meri', onLaunch }: MeriLauncherProps) {
  const launch = () => {
    if (onLaunch) onLaunch();
    else openVNextMeriWorkspaceWindow();
  };

  return (
    <CapiroButton
      variant="primary"
      size="standard"
      className="capiro-meri-launcher"
      leadingIcon={<DashboardIcon name="Stars02" size={18} />}
      aria-label={`Open ${label} workspace`}
      onClick={launch}
    >
      {/* The real wordmark asset, not a text label — alt="" since the
          button's aria-label above already carries the accessible name. */}
      <img src={MERI_LOGO_SRC} alt="" className="capiro-meri-launcher__wordmark" />
    </CapiroButton>
  );
}
