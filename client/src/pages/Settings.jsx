import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSettings } from '../context/SettingsContext';
import './Settings.css';

function normalizePath(value) {
  const cleaned = (value || '').replace(/^\/+|\/+$/g, '');
  return cleaned || 'websockify';
}

function resolveApiKey(explicitKey) {
  return String(explicitKey || '').trim();
}

function buildConnectionLine(settings) {
  const host = settings.remoteHost || 'localhost';
  const api = settings.apiPort || '18080';
  const vnc = settings.vncPort || '16080';
  const cdp = settings.cdpPort || '19222';
  const path = normalizePath(settings.path || 'websockify');
  const key = settings.apiKey || '';
  if (key) {
    return `bt://${host}?api=${api}&vnc=${vnc}&cdp=${cdp}&path=${path}&key=${key}`;
  }
  return `bt://${host}?api=${api}&vnc=${vnc}&cdp=${cdp}&path=${path}`;
}

function parseEngineInput(input, currentSettings) {
  const raw = (input || '').trim();
  if (!raw) return null;

  const base = {
    remoteHost: currentSettings.remoteHost || 'localhost',
    apiPort: currentSettings.apiPort || '18080',
    vncPort: currentSettings.vncPort || '16080',
    cdpPort: currentSettings.cdpPort || '19222',
    path: normalizePath(currentSettings.path || 'websockify'),
    apiKey: currentSettings.apiKey || '',
  };

  if (raw.startsWith('bt://')) {
    const parsed = new URL(raw);
    if (parsed.hostname) base.remoteHost = parsed.hostname;
    if (parsed.searchParams.get('api')) base.apiPort = parsed.searchParams.get('api');
    if (parsed.searchParams.get('vnc')) base.vncPort = parsed.searchParams.get('vnc');
    if (parsed.searchParams.get('cdp')) base.cdpPort = parsed.searchParams.get('cdp');
    if (parsed.searchParams.get('path')) base.path = normalizePath(parsed.searchParams.get('path'));
    if (parsed.searchParams.get('key')) base.apiKey = parsed.searchParams.get('key');
    return base;
  }

  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('ws://') || raw.startsWith('wss://')) {
    const parsed = new URL(raw);
    if (parsed.hostname) base.remoteHost = parsed.hostname;
    if (parsed.port) base.apiPort = parsed.port;
    return base;
  }

  const [host, maybePort] = raw.split(':');
  if (host) base.remoteHost = host;
  if (!maybePort) return base;

  if (maybePort === '6080') {
    base.vncPort = '6080';
    base.apiPort = '8080';
    base.cdpPort = '9222';
    return base;
  }
  if (maybePort === '16080') {
    base.vncPort = '16080';
    base.apiPort = '18080';
    base.cdpPort = '19222';
    return base;
  }
  if (maybePort === '8080' || maybePort === '18080') {
    base.apiPort = maybePort;
    return base;
  }
  if (maybePort === '9222' || maybePort === '19222') {
    base.cdpPort = maybePort;
    return base;
  }

  base.apiPort = maybePort;
  return base;
}

function testWebSocket(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error('WebSocket timeout'));
    }, timeoutMs);

    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve(true);
    };

    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('WebSocket failed'));
    };
  });
}

export default function Settings() {
  const { settings, updateSettings } = useSettings();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [testStatus, setTestStatus] = useState('');
  const [engineInput, setEngineInput] = useState(() => buildConnectionLine(settings));

  useEffect(() => {
    setEngineInput(buildConnectionLine(settings));
  }, [settings.remoteHost, settings.apiPort, settings.vncPort, settings.cdpPort, settings.path]);

  const wsPath = normalizePath(settings.path || 'websockify');
  const wsUrl = useMemo(() => {
    return `ws://${settings.remoteHost || 'localhost'}:${settings.vncPort || '16080'}/${wsPath}`;
  }, [settings.remoteHost, settings.vncPort, wsPath]);
  const apiUrl = useMemo(() => {
    return `http://${settings.remoteHost || 'localhost'}:${settings.apiPort || '18080'}`;
  }, [settings.remoteHost, settings.apiPort]);

  const applyEngineInput = async () => {
    try {
      const parsed = parseEngineInput(engineInput, settings);
      if (!parsed) {
        setTestStatus('Enter a host or bt:// connection line first.');
        return;
      }
      updateSettings(parsed);
      setEngineInput(buildConnectionLine(parsed));
      
      // Test connection immediately with parsed values
      const host = parsed.remoteHost || 'localhost';
      const apiPort = parsed.apiPort || '18080';
      const vncPort = parsed.vncPort || '16080';
      const path = normalizePath(parsed.path || 'websockify');
      const apiKey = resolveApiKey(parsed.apiKey);

      setTestStatus(`Testing API + stream for ${host}...`);
      const authHeaders = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};

      try {
        const healthRes = await fetch(`http://${host}:${apiPort}/health`, { 
          cache: 'no-store',
          headers: authHeaders 
        });
        if (!healthRes.ok) {
          setTestStatus(`API health failed (${healthRes.status}).`);
          return;
        }

        const tabsRes = await fetch(`http://${host}:${apiPort}/tabs/state.json`, { 
          cache: 'no-store',
          headers: authHeaders 
        });
        if (!tabsRes.ok) {
          setTestStatus(`Tabs API failed (${tabsRes.status}).`);
          return;
        }

        await testWebSocket(`ws://${host}:${vncPort}/${path}`);
        setTestStatus('Connected: API and WebSocket stream are reachable.');
      } catch (err) {
        setTestStatus(`Failed: ${err.message}`);
      }
    } catch (err) {
      setTestStatus(`Invalid connection line: ${err.message}`);
    }
  };

  const applyLocalPreset = () => {
    const local = {
      remoteHost: 'localhost',
      apiPort: '18080',
      vncPort: '16080',
      cdpPort: '19222',
      path: 'websockify',
      apiKey: '',
    };
    updateSettings(local);
    setEngineInput(buildConnectionLine(local));
    setTestStatus('Local preset applied.');
  };

  const testConnection = async () => {
    const host = settings.remoteHost || 'localhost';
    const apiPort = settings.apiPort || '18080';
    const vncPort = settings.vncPort || '16080';
    const path = normalizePath(settings.path || 'websockify');
    const apiKey = resolveApiKey(settings.apiKey);

    setTestStatus(`Testing API + stream for ${host}...`);

    const authHeaders = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};

    try {
      const healthRes = await fetch(`http://${host}:${apiPort}/health`, { 
        cache: 'no-store',
        headers: authHeaders 
      });
      if (!healthRes.ok) {
        setTestStatus(`API health failed (${healthRes.status}).`);
        return;
      }

      const tabsRes = await fetch(`http://${host}:${apiPort}/tabs/state.json`, { 
        cache: 'no-store',
        headers: authHeaders 
      });
      if (!tabsRes.ok) {
        setTestStatus(`Tabs API failed (${tabsRes.status}).`);
        return;
      }

      await testWebSocket(`ws://${host}:${vncPort}/${path}`);
      setTestStatus('Connected: API and WebSocket stream are reachable.');
    } catch (err) {
      setTestStatus(`Failed: ${err.message}`);
    }
  };

  return (
    <div className="settings-page">
      <div className="settings-glow settings-glow-a" />
      <div className="settings-glow settings-glow-b" />

      <div className="settings-shell">
        <header className="settings-header">
          <div>
            <p className="settings-kicker">Connection</p>
            <h1>Engine Settings</h1>
            <p className="settings-subtitle">Paste engine connection line from `browser-start` or set host/ports manually.</p>
          </div>
          <Link to="/" className="back-link">
            Back to Browser
          </Link>
        </header>

        <section className="settings-card">
          <label className="field-label" htmlFor="engine-url">
            Engine URL / Connection Line
          </label>
          <input
            id="engine-url"
            type="text"
            value={engineInput}
            onChange={(event) => setEngineInput(event.target.value)}
            className="field-input"
            placeholder="bt://192.168.1.20?api=18080&vnc=16080&cdp=19222&path=websockify"
          />
          <p className="field-help">Accepted: `bt://...`, plain host, or host:port.</p>

          <div className="actions-row">
            <button type="button" className="primary-btn" onClick={applyEngineInput}>
              Apply
            </button>
            <button type="button" className="secondary-btn" onClick={applyLocalPreset}>
              Use Local Preset
            </button>
            <button type="button" className="secondary-btn" onClick={() => setShowAdvanced((prev) => !prev)}>
              {showAdvanced ? 'Hide Advanced' : 'Show Advanced'}
            </button>
            <button type="button" className="secondary-btn" onClick={testConnection}>
              Test Connection
            </button>
          </div>

          {testStatus && <p className="test-status">{testStatus}</p>}

          <div className="url-preview">
            <p>
              <strong>VNC:</strong> {wsUrl}
            </p>
            <p>
              <strong>API:</strong> {apiUrl}
            </p>
            <p>
              <strong>Client line:</strong> {buildConnectionLine(settings)}
            </p>
          </div>
        </section>

        {showAdvanced && (
          <section className="settings-card advanced-card">
            <div className="advanced-grid">
              <label className="field-label" htmlFor="host-name">
                Host
              </label>
              <input
                id="host-name"
                type="text"
                value={settings.remoteHost || 'localhost'}
                onChange={(event) => updateSettings({ remoteHost: event.target.value })}
                className="field-input"
              />

              <label className="field-label" htmlFor="vnc-port">
                VNC WS Port
              </label>
              <input
                id="vnc-port"
                type="text"
                value={settings.vncPort || '16080'}
                onChange={(event) => updateSettings({ vncPort: event.target.value })}
                className="field-input"
              />

              <label className="field-label" htmlFor="api-port">
                API Port
              </label>
              <input
                id="api-port"
                type="text"
                value={settings.apiPort || '18080'}
                onChange={(event) => updateSettings({ apiPort: event.target.value })}
                className="field-input"
              />

              <label className="field-label" htmlFor="cdp-port">
                CDP Port
              </label>
              <input
                id="cdp-port"
                type="text"
                value={settings.cdpPort || '19222'}
                onChange={(event) => updateSettings({ cdpPort: event.target.value })}
                className="field-input"
              />

              <label className="field-label" htmlFor="ws-path">
                WS Path
              </label>
              <input
                id="ws-path"
                type="text"
                value={settings.path || 'websockify'}
                onChange={(event) => updateSettings({ path: normalizePath(event.target.value) })}
                className="field-input"
              />

              <label className="field-label" htmlFor="api-key">
                API Key
              </label>
              <input
                id="api-key"
                type="password"
                value={settings.apiKey || ''}
                onChange={(event) => updateSettings({ apiKey: event.target.value })}
                className="field-input"
                placeholder="Enter API key"
              />
            </div>

            <label className="checkbox-row" htmlFor="view-only-mode">
              <input
                id="view-only-mode"
                type="checkbox"
                checked={settings.viewOnly || false}
                onChange={(event) => updateSettings({ viewOnly: event.target.checked })}
              />
              <span>View-only mode</span>
            </label>
          </section>
        )}
      </div>
    </div>
  );
}
