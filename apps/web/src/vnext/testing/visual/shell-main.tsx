import React from 'react';
import ReactDOM from 'react-dom/client';
import '../../foundations/index.css';
import { VNextShellVisual, type VNextVisualScreen } from './VNextShellVisual.js';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root for vNext shell visual fixture');
const params = new URLSearchParams(window.location.search);
const collapsed = params.get('collapsed') === '1';

const SCREENS: readonly VNextVisualScreen[] = [
  'empty',
  'dashboard',
  'client-crm',
  'congressional-staff',
  'congressional-staff-empty',
  'strategies',
  'strategies-empty',
  'strategy-editor',
];

const requested = params.get('screen');
const screen: VNextVisualScreen = SCREENS.includes(requested as VNextVisualScreen)
  ? (requested as VNextVisualScreen)
  : 'empty';
const attnState = params.get('attnState') ?? undefined;
const crmTab = params.get('crmTab') ?? undefined;
const intelView = params.get('intelView') ?? undefined;
const relView = params.get('relView') ?? undefined;
const crmOverlay = params.get('crmOverlay') ?? undefined;
// Phase 4: e.g. `?openSections=timeline,advocacy` to force those record
// sections open in addition to whatever crmTab/relView/intelView already
// target — see VNextShellVisual's `openSections` prop doc.
const openSections = params.get('openSections')?.split(',') ?? undefined;

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <VNextShellVisual collapsed={collapsed} screen={screen} crmTab={crmTab as never} intelView={intelView as never} relView={relView as never} crmOverlay={crmOverlay as never} openSections={openSections as never} attnState={attnState as never} />
  </React.StrictMode>,
);
