import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useSettings } from '../context/SettingsContext';
import VNCViewer from '../components/VNCViewer';
import TabRail from '../components/TabRail';
import './Browser.css';

export default function Browser() {
  const { settings } = useSettings();
  const [tabs, setTabs] = useState([]);
  const [activeTab, setActiveTab] = useState(null);
  const [urlInput, setUrlInput] = useState('');
  const [isOpeningTab, setIsOpeningTab] = useState(false);
  const [status, setStatus] = useState('idle');
  const rfbRef = useRef(null);
  const cdpWsPool = useRef(new Map());
  const browserWsUrl = useRef('');

  const vncPort = settings.vncPort;
  const cdpPort = settings.cdpPort;
  const focusPort = settings.focusPort;

  const getCdpWs = useCallback(async (rawWsUrl) => {
    const raw = String(rawWsUrl || '').trim();
    if (!raw) {
      throw new Error('Missing CDP WebSocket URL');
    }

    let wsUrl = raw;
    if (!(raw.startsWith('ws://') || raw.startsWith('wss://'))) {
      if (raw.startsWith('/')) {
        wsUrl = `ws://${window.location.hostname}:${cdpPort}${raw}`;
      } else {
        wsUrl = `ws://${window.location.hostname}:${cdpPort}/${raw}`;
      }
    }
    const existing = cdpWsPool.current.get(wsUrl);
    if (existing && existing.readyState === WebSocket.OPEN) {
      return Promise.resolve(existing);
    }
    if (existing) cdpWsPool.current.delete(wsUrl);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        cdpWsPool.current.set(wsUrl, ws);
        resolve(ws);
      };
      ws.onclose = () => cdpWsPool.current.delete(wsUrl);
      ws.onerror = () => {
        cdpWsPool.current.delete(wsUrl);
        reject(new Error('CDP WS error'));
      };
    });
  }, [cdpPort]);

  const sendCdpMessage = useCallback((ws, msg) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const refreshTabs = useCallback(async () => {
    try {
      const response = await fetch(`/tabs/state.json`, {
        cache: 'no-store'
      });
      if (!response.ok) return;
      const payload = await response.json();

      if (payload.browserWsUrl) {
        browserWsUrl.current = payload.browserWsUrl;
      }

      setTabs(payload.tabs || []);
      
      const active = payload.tabs?.find(t => t.active);
      if (active && document.activeElement?.tagName !== 'INPUT') {
        setUrlInput(active.url || '');
      }
    } catch (err) {
      console.error('Failed to refresh tabs:', err);
    }
  }, []);

  const navigateViaCDP = useCallback(async (url) => {
    const active = tabs.find(t => t.active);
    if (!active || !active.wsUrl) return;
    try {
      const ws = await getCdpWs(active.wsUrl);
      sendCdpMessage(ws, {
        id: Date.now(),
        method: 'Page.navigate',
        params: { url }
      });
    } catch (e) {
      console.warn('navigate failed:', e);
    }
  }, [tabs, getCdpWs, sendCdpMessage]);

  const sendJSCommand = useCallback(async (code) => {
    const active = tabs.find(t => t.active);
    if (!active || !active.wsUrl) return;
    try {
      const ws = await getCdpWs(active.wsUrl);
      sendCdpMessage(ws, {
        id: Date.now(),
        method: 'Runtime.evaluate',
        params: { expression: code }
      });
    } catch (e) {
      console.warn('sendJSCommand failed:', e);
    }
  }, [tabs, getCdpWs, sendCdpMessage]);

  const handleUrlSubmit = (e) => {
    e.preventDefault();
    let url = urlInput.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url) && !url.startsWith('chrome://')) {
      url = 'https://' + url;
    }
    navigateViaCDP(url);
  };

  const handleTabSelect = async (tab) => {
    try {
      await fetch(`/focus?id=${encodeURIComponent(tab.id)}`, {
        cache: 'no-store'
      });
    } catch (e) {
      console.error('Failed to focus tab:', e);
    }
    setActiveTab(tab);
  };

  const handleTabClose = async (tab) => {
    try {
      await fetch(`/close?id=${encodeURIComponent(tab.id)}`, {
        cache: 'no-store'
      });
    } catch (e) {
      console.error('Failed to close tab:', e);
    }
  };

  const handleNewTab = async () => {
    if (isOpeningTab || !rfbRef.current) return;
    setIsOpeningTab(true);
    setTimeout(() => setIsOpeningTab(false), 500);

    setStatus('Opening new tab...');

    const tempId = 'temp-' + Date.now();
    const newTab = {
      id: tempId,
      index: tabs.length + 1,
      title: 'Loading...',
      active: false,
      preview: '',
      isSkeleton: true
    };
    setTabs(prev => [...prev, newTab]);

    setTimeout(() => {
      setTabs(prev => prev.filter(t => t.id !== tempId));
      refreshTabs();
    }, 3000);
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
    refreshTabs();
    const interval = setInterval(refreshTabs, 1500);
    return () => clearInterval(interval);
  }, [refreshTabs]);

  useEffect(() => {
    const active = tabs.find(t => t.active);
    setActiveTab(active);
  }, [tabs]);

  return (
    <div className="browser-page">
      <Link to="/settings" className="settings-btn" title="Settings">
        ⚙
      </Link>

      <TabRail
        tabs={tabs}
        activeTab={activeTab}
        onTabSelect={handleTabSelect}
        onTabClose={handleTabClose}
        onNewTab={handleNewTab}
      />

      <div className="main-view">
        <form className="url-bar-wrap" onSubmit={handleUrlSubmit}>
          <button type="button" className="nav-btn" onClick={handleBack} title="Back">❮</button>
          <button type="button" className="nav-btn" onClick={handleForward} title="Forward">❯</button>
          <input
            type="text"
            className="url-input"
            placeholder="Enter URL..."
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            autoComplete="off"
            spellCheck="false"
          />
        </form>

        <VNCViewer
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
        />
      </div>
    </div>
  );
}
