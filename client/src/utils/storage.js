const STORAGE_PREFIX = 'browser_tool_';

export const StorageKeys = {
  REMOTE_LINKS: `${STORAGE_PREFIX}remote_links`,
  SETTINGS: `${STORAGE_PREFIX}settings`,
};

export function getRemoteLinks() {
  try {
    const stored = localStorage.getItem(StorageKeys.REMOTE_LINKS);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

export function saveRemoteLinks(links) {
  try {
    localStorage.setItem(StorageKeys.REMOTE_LINKS, JSON.stringify(links));
  } catch {}
}

export function getSettings() {
  try {
    const stored = localStorage.getItem(StorageKeys.SETTINGS);
    return stored ? JSON.parse(stored) : getDefaultSettings();
  } catch {
    return getDefaultSettings();
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(StorageKeys.SETTINGS, JSON.stringify(settings));
  } catch {}
}

export function getDefaultSettings() {
  return {
    remoteHost: 'localhost',
    vncPort: '16080',
    cdpPort: '19222',
    apiPort: '18080',
    apiKey: '',
    path: 'websockify',
    viewOnly: false,
    resizeMode: 'remote',
  };
}
