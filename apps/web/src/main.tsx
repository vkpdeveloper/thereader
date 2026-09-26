import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import './index.css';
import { router } from './router';
import { applyTheme, rememberedThemeId } from './lib/themes';
import { createServices } from './lib/services';
import { ServicesProvider } from './lib/services/react';
import { registerServiceWorker } from './lib/services/registerSw';

// Paint the last preset before the stores load, so a reload never flashes Default.
applyTheme(rememberedThemeId());

const services = createServices();
registerServiceWorker();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ServicesProvider services={services}>
      <RouterProvider router={router} />
    </ServicesProvider>
  </React.StrictMode>,
);
