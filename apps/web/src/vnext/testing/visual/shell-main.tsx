import React from 'react';
import ReactDOM from 'react-dom/client';
import '../../foundations/index.css';
import { VNextShellVisual } from './VNextShellVisual.js';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root for vNext shell visual fixture');
const params = new URLSearchParams(window.location.search);
const collapsed = params.get('collapsed') === '1';
const screen = params.get('screen') === 'dashboard' ? 'dashboard' : 'empty';

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <VNextShellVisual collapsed={collapsed} screen={screen} />
  </React.StrictMode>,
);
