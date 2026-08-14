import { openVNextMeriWorkspaceWindow } from '../../../components/chat/meri-window.js';
import { CapiroButton } from '../../components/actions/index.js';
import { DashboardIcon } from '../../components/untitledui/dashboard-icons.js';
import { useShellOverlay } from '../overlay-manager.js';

export interface MeriLauncherProps {
  label?: string;
  onLaunch?: () => void;
}

const MERI_PROMPTS = [
  'Summarize overnight signals',
  'Draft a client update',
  'Prepare me for my next hearing',
] as const;

export function MeriLauncher({ label = 'Meri', onLaunch }: MeriLauncherProps) {
  const { isOpen, containerRef, toggle, close } = useShellOverlay('meri');
  const launch = () => {
    close();
    if (onLaunch) onLaunch();
    else openVNextMeriWorkspaceWindow();
  };

  return (
    <div className="capiro-meri-launcher-wrap" ref={containerRef}>
      <CapiroButton
        variant="primary"
        size="standard"
        className="capiro-meri-launcher"
        leadingIcon={<DashboardIcon name="Stars02" size={18} />}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        onClick={(event) => toggle(event.currentTarget)}
      >
        {label}
      </CapiroButton>
      {isOpen ? (
        <div className="capiro-meri-menu" role="menu" aria-label="Ask Meri">
          <div className="capiro-meri-menu__label">Ask Meri</div>
          {MERI_PROMPTS.map((prompt) => (
            <button key={prompt} type="button" role="menuitem" onClick={launch}>{prompt}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
