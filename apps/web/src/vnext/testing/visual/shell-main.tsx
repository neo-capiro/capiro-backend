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
];

const requested = params.get('screen');
const screen: VNextVisualScreen = SCREENS.includes(requested as VNextVisualScreen)
  ? (requested as VNextVisualScreen)
  : 'empty';
const attnState = params.get('attnState') ?? undefined;

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <VNextShellVisual collapsed={collapsed} screen={screen} attnState={attnState as never} />
  </React.StrictMode>,
);
