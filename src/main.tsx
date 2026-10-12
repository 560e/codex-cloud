import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { ThemeProvider } from './theme';
import { MobileViewport } from './MobileViewport';
import './styles.css';
import './interactions.css';
import './settings/settings.css';
import './continuity.css';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <MobileViewport />
        <App />
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
