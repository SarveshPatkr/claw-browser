import { useState } from 'react';
import './TabRail.css';

function getFaviconUrl(url) {
  if (!url || url.startsWith('about:') || url.startsWith('chrome://')) {
    return '';
  }

  try {
    const origin = new URL(url).origin;
    return `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(origin)}&sz=64`;
  } catch {
    return '';
  }
}

function getDomain(url) {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export default function TabRail({ tabs, activeTab, onTabSelect, onTabClose, onNewTab, initialLoad }) {
  const [closingTabs, setClosingTabs] = useState(new Set());

  const handleClose = (event, tab) => {
    event.stopPropagation();
    setClosingTabs((prev) => new Set([...prev, tab.id]));

    setTimeout(() => {
      setClosingTabs((prev) => {
        const next = new Set(prev);
        next.delete(tab.id);
        return next;
      });
      if (onTabClose) onTabClose(tab);
    }, 180);
  };

  return (
    <div className="tab-rail">
      {tabs.length === 0 && <div className="tab-empty">No tabs open</div>}

      {tabs.map((tab) => {
        const isActive = activeTab?.id === tab.id;
        const isClosing = closingTabs.has(tab.id);

        return (
          <div
            key={tab.id}
            role="button"
            tabIndex={0}
            className={`tab-card ${isActive ? 'active' : ''} ${isClosing ? 'closing' : ''} ${!tab.isSkeleton && !initialLoad ? 'opening' : ''}`}
            onClick={() => onTabSelect && onTabSelect(tab)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                onTabSelect && onTabSelect(tab);
              }
            }}
          >
            <div className={`tab-favicon-wrap ${tab.isSkeleton ? 'skeleton-thumb' : ''}`}>
              {!tab.isSkeleton && (
                <img
                  className="tab-favicon"
                  src={getFaviconUrl(tab.url)}
                  alt=""
                  onError={(event) => {
                    event.target.style.display = 'none';
                  }}
                />
              )}
            </div>

            <div className="tab-label">
              <span className="tab-label-title">{tab.isSkeleton ? 'Opening...' : tab.title || 'New Tab'}</span>
              {!tab.isSkeleton && <span className="tab-label-domain">{getDomain(tab.url)}</span>}
            </div>

            {!tab.isSkeleton && (
              <button type="button" className="tab-close" onClick={(event) => handleClose(event, tab)}>
                ×
              </button>
            )}
          </div>
        );
      })}

      <button type="button" className="new-tab-btn" onClick={onNewTab}>
        <span>+</span>
        <small>New App</small>
      </button>
    </div>
  );
}
