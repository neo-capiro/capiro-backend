import { openVNextMeriWorkspaceWindow } from '../../../components/chat/meri-window.js';
import { CapiroButton } from '../../components/actions/index.js';

export interface MeriLauncherProps {
  label?: string;
  onLaunch?: () => void;
}

/**
 * Meri launcher.
 *
 * `Pattern/Shell/TopBar vNext` (`1124:2682`) composes this from `Button/Main`
 * as Compact + Primary + Default with **both icon slots off**, so it is the
 * design system's button rather than a bespoke shell control. Reusing
 * `CapiroButton` also satisfies the Dashboard handoff spec's explicit
 * instruction not to redraw design-system components.
 *
 * That resolves a four-way disagreement in the Figma file, which had already
 * produced one shipped bug:
 *  - `Shell/MeriLauncher`'s bound radius variable reads 10px
 *  - that component's own reference screenshot reads as a full pill
 *  - the canonical app frames (`722:2502`, `843:2502`, `869:2502`) show a
 *    cobalt pill with a leading dot
 *  - `Pattern/Shell/TopBar vNext` renders a dark-ink 8px button, no dot
 *
 * Neo ruled the top-bar pattern normative, so the `border-radius: 999px` pill
 * shipped in `a3dbce1d` was a regression and is reverted here. Compact+Primary
 * resolves to `#131a24` at 32px with an 8px radius and Elevation/Control —
 * matching the pattern exactly.
 *
 * Do not re-add the leading dot; the pattern sets `showLeadingIcon={false}`.
 *
 * This component belongs exclusively to the vNext shell, so its default launch
 * target is the canonical addressable `/meri` workspace. The legacy app keeps
 * using the shared `?meriWindow=1` helper independently.
 */
export function MeriLauncher({ label = 'Meri', onLaunch }: MeriLauncherProps) {
  return (
    <CapiroButton
      variant="primary"
      size="compact"
      className="capiro-meri-launcher"
      onClick={() => {
        if (onLaunch) {
          onLaunch();
          return;
        }
        openVNextMeriWorkspaceWindow();
      }}
    >
      {label}
    </CapiroButton>
  );
}
