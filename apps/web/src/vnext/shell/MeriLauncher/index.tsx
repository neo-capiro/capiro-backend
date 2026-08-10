import { openMeriWorkspaceWindow } from '../../../components/chat/meri-window.js';

export interface MeriLauncherProps {
  label?: string;
  onLaunch?: () => void;
}

export function MeriLauncher({ label = 'Meri', onLaunch }: MeriLauncherProps) {
  return (
    <button
      type="button"
      className="capiro-meri-launcher capiro-elevation-meri"
      onClick={() => {
        if (onLaunch) {
          onLaunch();
          return;
        }
        openMeriWorkspaceWindow();
      }}
    >
      <span className="capiro-meri-launcher__dot" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
