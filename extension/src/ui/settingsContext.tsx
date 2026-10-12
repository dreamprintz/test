import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, saveSettings, type Settings } from '../settings/settings';

const Ctx = createContext<{ settings: Settings; loaded: boolean; update: (s: Settings) => Promise<void> }>({ settings: DEFAULT_SETTINGS, loaded: false, update: async () => {} });

function applyTheme(theme: Settings['theme']) {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void loadSettings().then((s) => { setSettings(s); setLoaded(true); });
    return onSettingsChanged(setSettings);
  }, []);
  useEffect(() => {
    applyTheme(settings.theme);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const l = () => applyTheme(settings.theme);
    mq.addEventListener('change', l);
    return () => mq.removeEventListener('change', l);
  }, [settings.theme]);
  const update = useCallback(async (s: Settings) => {
    setSettings(s);
    await saveSettings(s);
  }, []);
  return <Ctx.Provider value={{ settings, loaded, update }}>{children}</Ctx.Provider>;
}

export const useSettings = () => useContext(Ctx);
