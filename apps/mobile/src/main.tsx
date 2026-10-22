import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { configureVoiceServices } from './audio';
import { localService } from './platform/local-service';

configureVoiceServices(localService);

// Android WebView 83 supports grid gap but not flex gap, so CSS @supports
// cannot distinguish it. Measure a hidden two-child flex layout once.
const flexGapProbe = document.createElement('div');
flexGapProbe.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden;pointer-events:none;';
for (let index = 0; index < 2; index++) {
  const child = document.createElement('div');
  child.style.cssText = 'height:1px;flex-shrink:0;';
  flexGapProbe.appendChild(child);
}
document.body.appendChild(flexGapProbe);
if (flexGapProbe.scrollHeight !== 3) document.documentElement.classList.add('no-flex-gap');
document.body.removeChild(flexGapProbe);

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
