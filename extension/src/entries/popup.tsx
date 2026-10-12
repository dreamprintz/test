import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../ui/styles.css';
import { ConfirmProvider, ToastProvider } from '../ui/components';
import { SettingsProvider } from '../ui/settingsContext';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import Popup from '../popup/Popup';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SettingsProvider>
      <ToastProvider>
        <ConfirmProvider>
          <ErrorBoundary>
            <Popup />
          </ErrorBoundary>
        </ConfirmProvider>
      </ToastProvider>
    </SettingsProvider>
  </StrictMode>,
);
