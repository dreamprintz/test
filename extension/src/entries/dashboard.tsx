import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Route, Routes } from 'react-router-dom';
import '../ui/styles.css';
import { AppShell } from '../ui/layout/AppShell';
import { ConfirmProvider, ToastProvider } from '../ui/components';
import { SettingsProvider } from '../ui/settingsContext';
import Dashboard from '../pages/Dashboard';
import ImportContacts from '../pages/ImportContacts';
import Contacts from '../pages/Contacts';
import Lists from '../pages/Lists';
import Templates from '../pages/Templates';
import NewCampaign from '../pages/NewCampaign';
import CampaignDetails from '../pages/CampaignDetails';
import CampaignHistory from '../pages/CampaignHistory';
import Settings from '../pages/Settings';
import { ErrorBoundary } from '../ui/ErrorBoundary';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SettingsProvider>
      <ToastProvider>
        <ConfirmProvider>
          <HashRouter>
            <AppShell>
              <ErrorBoundary>
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/import" element={<ImportContacts />} />
                  <Route path="/contacts" element={<Contacts />} />
                  <Route path="/lists" element={<Lists />} />
                  <Route path="/templates" element={<Templates />} />
                  <Route path="/campaigns" element={<CampaignHistory />} />
                  <Route path="/campaigns/new" element={<NewCampaign />} />
                  <Route path="/campaigns/:id/edit" element={<NewCampaign />} />
                  <Route path="/campaigns/:id" element={<CampaignDetails />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="*" element={<Dashboard />} />
                </Routes>
              </ErrorBoundary>
            </AppShell>
          </HashRouter>
        </ConfirmProvider>
      </ToastProvider>
    </SettingsProvider>
  </StrictMode>,
);
