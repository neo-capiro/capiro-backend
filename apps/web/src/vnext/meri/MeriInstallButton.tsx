import { MeriIcon } from './meri-icons.js';
import { meriInstallStore, useMeriInstall } from './meri-install.js';

export function MeriInstallButton() {
  const install = useMeriInstall();

  if (
    (!install.canInstall && !install.isInstalling) ||
    install.isStandalone ||
    install.isInstalled
  ) {
    return null;
  }

  return (
    <button
      type="button"
      className="vnext-meri__install-trigger"
      aria-label="Install Meri"
      aria-busy={install.isInstalling}
      title="Install Meri on this device"
      disabled={install.isInstalling}
      onClick={() => void meriInstallStore.requestInstall()}
    >
      <MeriIcon name="DownloadCloud01" size={15} />
      <span className="vnext-meri__install-label">
        {install.isInstalling ? 'INSTALLING…' : 'INSTALL MERI'}
      </span>
    </button>
  );
}
