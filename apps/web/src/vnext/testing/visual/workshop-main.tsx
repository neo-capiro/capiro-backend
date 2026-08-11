import React from 'react';
import ReactDOM from 'react-dom/client';
import '../../foundations/index.css';
import './workshop.css';
import { VNextComponentWorkshop } from './VNextComponentWorkshop.js';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root for vNext component workshop');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <VNextComponentWorkshop />
  </React.StrictMode>,
);
