import { createContext, useContext, useState, useCallback } from 'react';
import {
  getSettings,
  saveSettings,
  getDefaultSettings,
} from '../utils/storage';

const SettingsContext = createContext(null);

export function SettingsProvider({ children }) {
  const [settings, setSettingsState] = useState(() => {
    return { ...getDefaultSettings(), ...getSettings() };
  });

  const updateSettings = useCallback((updates) => {
    setSettingsState((prev) => {
      const newSettings = { ...prev, ...updates };
      saveSettings(newSettings);
      return newSettings;
    });
  }, []);

  const path = (settings.path || 'websockify').replace(/^\/+|\/+$/g, '');
  const host = settings.remoteHost || window.location.hostname || 'localhost';
  const wsUrl = `ws://${host}:${settings.vncPort}/${path}`;

  return (
    <SettingsContext.Provider
      value={{
        settings,
        updateSettings,
        wsUrl,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
}
