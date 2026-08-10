import React from 'react';
import ReactDOM from 'react-dom/client';
import '../../foundations/index.css';
import { VNextShellVisual } from './VNextShellVisual.js';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root for vNext shell visual fixture');
const collapsed = new URLSearchParams(window.location.search).get('collapsed') === '1';

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <VNextShellVisual collapsed={collapsed} />
  </React.StrictMode>,
);
