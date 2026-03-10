import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useNoVNC, press, tap } from '../utils/novnc';
import { useSettings } from '../context/SettingsContext';
import TabRail from '../components/TabRail';
import VNCViewer from '../components/VNCViewer';
import './BrowserPage.css';

const CTRL_KEYSYM = 0xffe3;
const ALT_KEYSYM = 0xffe9;
const ZERO_KEYSYM = 0x0030;

export default function BrowserPage() {
  const { loading: novncLoading } = useNoVNC();
  const { settings } = useSettings();

  const [tabs, setTabs] = useState([]);
  const [activeTab, setActiveTab] = useState(null);
  const [urlInput, setUrlInput] = useState('');
  const [status, setStatus] = useState('Connecting...');
  const [isOpeningTab, setIsOpeningTab] = useState(false);
  const [authError, setAuthError] = useState(false);

  const rfbRef = useRef(null);
  const cdpWsPool = useRef(new Map());
  const initialLoad = useRef(true);
  const seenBackendIds = useRef(new Set());
  const closingTabs = useRef(new Set());
  const latestRefreshRequest = useRef(0);
  const latestAppliedRefresh = useRef(0);

  const host = settings.remoteHost || window.location.hostname || 'localhost';
  const vncPort = settings.vncPort || '16080';
  const cdpPort = settings.cdpPort || '19222';
  const apiPort = settings.apiPort || '18080';

  const wsUrl = useMemo(() => {
    const path = (settings.path || 'websockify').replace(/^\/+|\/+$/g, '');
    return `ws://${host}:${vncPort}/${path}`;
  }, [host, vncPort, settings.path]);

  const apiUrl = useMemo(() => {
    return `http://${host}:${apiPort}`;
  }, [host, apiPort]);

  const authHeaders = useMemo(() => {
    const headers = {};
    if (settings.apiKey) {
      headers['Authorization'] = `Bearer ${settings.apiKey}`;
    }
    return headers;
  }, [settings.apiKey]);

  useEffect(() => {
    const timer = setTimeout(() => {
      initialLoad.current = false;
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  const getCdpWs = useCallback(
    async (rawWsUrl) => {
      if (!rawWsUrl) return null;

      const finalWsUrl = rawWsUrl.replace('HOST_PLACEHOLDER', `${host}:${cdpPort}`);
      const existing = cdpWsPool.current.get(finalWsUrl);
      if (existing && existing.readyState === WebSocket.OPEN) {
        return Promise.resolve(existing);
      }
      if (existing) cdpWsPool.current.delete(finalWsUrl);

      return new Promise((resolve, reject) => {
        const ws = new WebSocket(finalWsUrl);
        ws.onopen = () => {
          cdpWsPool.current.set(finalWsUrl, ws);
          resolve(ws);
        };
        ws.onclose = () => cdpWsPool.current.delete(finalWsUrl);
        ws.onerror = () => {
          cdpWsPool.current.delete(finalWsUrl);
          reject(new Error('CDP WS error'));
        };
      });
    },
    [host, cdpPort],
  );

  const sendCdpMessage = useCallback((ws, msg) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const refreshTabs = useCallback(async () => {
    const requestId = ++latestRefreshRequest.current;

    try {
      const tabsUrl = `${apiUrl}/tabs/state.json`;
      const response = await fetch(tabsUrl, {
        headers: authHeaders,
        cache: 'no-store',
      });

      if (response.status === 401) {
        setAuthError(true);
        setStatus('API authorization failed');
        return;
      }
      if (!response.ok) return;

      setAuthError(false);
      const payload = await response.json();
      if (requestId < latestAppliedRefresh.current) return;
      latestAppliedRefresh.current = requestId;

      const backendTabs = Array.isArray(payload.tabs) ? payload.tabs : [];
      const dedupedTabs = [];
      const dedupeIds = new Set();
      for (const tab of backendTabs) {
        if (!tab?.id || dedupeIds.has(tab.id)) continue;
        dedupeIds.add(tab.id);
        dedupedTabs.push(tab);
      }
      dedupedTabs.sort((a, b) => {
        const aIndex = Number.isFinite(a.index) ? a.index : Number.MAX_SAFE_INTEGER;
        const bIndex = Number.isFinite(b.index) ? b.index : Number.MAX_SAFE_INTEGER;
        if (aIndex !== bIndex) return aIndex - bIndex;
        return String(a.id).localeCompare(String(b.id));
      });

      const backendIds = new Set(dedupedTabs.map((t) => t.id));
      for (const id of closingTabs.current) {
        if (!backendIds.has(id)) closingTabs.current.delete(id);
      }

      const activeBackendTabs = dedupedTabs.filter((t) => !closingTabs.current.has(t.id));

      setTabs((prevTabs) => {
        let newTabsCount = 0;
        for (const tab of activeBackendTabs) {
          if (!seenBackendIds.current.has(tab.id)) {
            seenBackendIds.current.add(tab.id);
            newTabsCount++;
          }
        }

        const remainingSkeletons = prevTabs.filter((tab) => tab.isSkeleton);
        for (let i = 0; i < newTabsCount && remainingSkeletons.length > 0; i++) {
          remainingSkeletons.shift();
        }

        return [...activeBackendTabs, ...remainingSkeletons];
      });

      const active = activeBackendTabs.find((tab) => tab.active);
      if (active && document.activeElement?.tagName !== 'INPUT') {
        setUrlInput(active.url || '');
      }
    } catch (err) {
      console.error('Failed to refresh tabs:', err);
    }
  }, [apiUrl, authHeaders]);

  const navigateViaCDP = useCallback(
    async (url) => {
      const active = tabs.find((tab) => tab.active);
      if (!active || !active.wsUrl) return;

      try {
        const ws = await getCdpWs(active.wsUrl);
        sendCdpMessage(ws, {
          id: Date.now(),
          method: 'Page.navigate',
          params: { url },
        });
      } catch (err) {
        console.warn('navigate failed:', err);
      }
    },
    [tabs, getCdpWs, sendCdpMessage],
  );

  const sendJSCommand = useCallback(
    async (code) => {
      const active = tabs.find((tab) => tab.active);
      if (!active || !active.wsUrl) return;

      try {
        const ws = await getCdpWs(active.wsUrl);
        sendCdpMessage(ws, {
          id: Date.now(),
          method: 'Runtime.evaluate',
          params: { expression: code },
        });
      } catch (err) {
        console.warn('sendJSCommand failed:', err);
      }
    },
    [tabs, getCdpWs, sendCdpMessage],
  );

  const handleUrlSubmit = (event) => {
    event.preventDefault();
    let url = urlInput.trim();
    if (!url) return;

    if (!/^https?:\/\//i.test(url) && !url.startsWith('chrome://')) {
      url = `https://${url}`;
    }

    navigateViaCDP(url);
  };

  const handleTabSelect = async (tab) => {
    if (!tab || !tab.id) return;

    const focusUrl = `${apiUrl}/focus?id=${encodeURIComponent(tab.id)}`;
    await fetch(focusUrl, { headers: authHeaders, cache: 'no-store' }).catch(() => {});
    setTabs((prev) => prev.map((t) => ({ ...t, active: t.id === tab.id })));
    setActiveTab(tab);
  };

  const handleTabClose = async (tab) => {
    if (!tab) return;

    closingTabs.current.add(tab.id);
    setTabs((prev) => prev.filter((t) => t.id !== tab.id));

    if (tab.wsUrl) {
      try {
        const ws = await getCdpWs(tab.wsUrl);
        sendCdpMessage(ws, {
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression: 'window.close()' },
        });
        sendCdpMessage(ws, { id: 2, method: 'Page.close' });
      } catch {}
    }

    const closeUrl = `${apiUrl}/close?id=${encodeURIComponent(tab.id)}`;
    await fetch(closeUrl, { headers: authHeaders, cache: 'no-store' }).catch(() => {});
  };

  const handleNewTab = async () => {
    if (isOpeningTab || !rfbRef.current) return;

    setIsOpeningTab(true);
    setTimeout(() => setIsOpeningTab(false), 500);

    const tempId = `temp-${Date.now()}`;
    setTabs((prev) => [
      ...prev,
      {
        id: tempId,
        index: prev.length + 1,
        title: 'Opening app...',
        active: false,
        preview: '',
        isSkeleton: true,
      },
    ]);
    setStatus('Opening new app...');

    rfbRef.current.focus();
    press(rfbRef.current, CTRL_KEYSYM, 'ControlLeft', true);
    press(rfbRef.current, ALT_KEYSYM, 'AltLeft', true);
    tap(rfbRef.current, ZERO_KEYSYM, 'Digit0');
    press(rfbRef.current, ALT_KEYSYM, 'AltLeft', false);
    press(rfbRef.current, CTRL_KEYSYM, 'ControlLeft', false);

    setTimeout(() => {
      refreshTabs();
    }, 350);

    setTimeout(() => {
      setTabs((prev) => prev.filter((tab) => tab.id !== tempId));
    }, 8000);
  };

  const handleBack = () => sendJSCommand('history.back()');
  const handleForward = () => sendJSCommand('history.forward()');

  const handleConnect = (rfb) => {
    rfbRef.current = rfb;
    setStatus('Connected');
    refreshTabs();
  };

  const handleDisconnect = () => {
    rfbRef.current = null;
    setStatus('Disconnected');
  };

  useEffect(() => {
    if (novncLoading) return;

    refreshTabs();
    const interval = setInterval(refreshTabs, 1500);
    return () => clearInterval(interval);
  }, [novncLoading, refreshTabs]);

  useEffect(() => {
    const active = tabs.find((tab) => tab.active);
    setActiveTab(active || null);
  }, [tabs]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        setStatus('Clipboard is empty');
        return;
      }

      if (rfbRef.current) rfbRef.current.focus();
      for (const char of text) {
        tap(rfbRef.current, char.codePointAt(0), '');
      }
      setStatus(`Pasted ${text.length} chars`);
    } catch {
      const manual = window.prompt('Clipboard access blocked. Paste text here:', '') || '';
      if (!manual) {
        setStatus('Paste canceled');
        return;
      }

      if (rfbRef.current) rfbRef.current.focus();
      for (const char of manual) {
        tap(rfbRef.current, char.codePointAt(0), '');
      }
      setStatus(`Pasted ${manual.length} chars`);
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (event) => {
      const withPrimary = event.ctrlKey || event.metaKey;
      if (withPrimary && event.shiftKey && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        handlePaste();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handlePaste]);

  if (novncLoading) {
    return (
      <div className="browser-loading-wrap">
        <div className="browser-loading-card">Loading noVNC runtime...</div>
      </div>
    );
  }

  return (
    <div className="browser-page">
      <div className="browser-glow browser-glow-a" />
      <div className="browser-glow browser-glow-b" />

      <header className="browser-header">
        <div>
          <h1 className="browser-title">Claw Browser</h1>
          <p className="browser-subtitle">Remote desktop stream + tab controls</p>
        </div>
        <div className="browser-header-actions">
          <span className={`status-chip ${authError ? 'status-chip-error' : 'status-chip-ok'}`}>
            {authError ? 'Auth required' : status}
          </span>
          <Link to="/settings" className="settings-link" title="Open settings">
            Settings
          </Link>
        </div>
      </header>

      <main className="browser-layout">
        <aside className="browser-sidebar">
          <div className="sidebar-header">
            <h2>Tabs</h2>
            <p>{tabs.length} open</p>
          </div>
          <TabRail
            tabs={tabs}
            activeTab={activeTab}
            onTabSelect={handleTabSelect}
            onTabClose={handleTabClose}
            onNewTab={handleNewTab}
            initialLoad={initialLoad.current}
          />
        </aside>

        <section className="browser-main">
          <form className="url-bar-wrap" onSubmit={handleUrlSubmit}>
            <button type="button" className="nav-btn" onClick={handleBack} title="Back">
              Back
            </button>
            <button type="button" className="nav-btn" onClick={handleForward} title="Forward">
              Next
            </button>
            <input
              type="text"
              className="url-input"
              placeholder="Enter URL..."
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              autoComplete="off"
              spellCheck="false"
            />
            <button type="submit" className="go-btn">
              Open
            </button>
          </form>

          <VNCViewer wsUrl={wsUrl} viewOnly={settings.viewOnly} onConnect={handleConnect} onDisconnect={handleDisconnect} />
        </section>
      </main>
    </div>
  );
}
