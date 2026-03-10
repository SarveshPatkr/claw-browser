import { useEffect, useRef, useState } from 'react';
import { useNoVNC } from '../utils/novnc';
import './VNCViewer.css';

function getStatusLabel(status) {
  if (status === 'loading') return 'Loading VNC';
  if (status === 'connecting') return 'Connecting';
  if (status === 'connected') return 'Connected';
  if (status === 'disconnected') return 'Disconnected';
  return 'Error';
}

export default function VNCViewer({ wsUrl, viewOnly, onConnect, onDisconnect }) {
  const { RFB: RFBClass } = useNoVNC();
  const containerRef = useRef(null);
  const rfbRef = useRef(null);
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    onConnectRef.current = onConnect;
    onDisconnectRef.current = onDisconnect;
  }, [onConnect, onDisconnect]);

  useEffect(() => {
    let rfb = null;

    const initVNC = async () => {
      if (!RFBClass || !containerRef.current || !wsUrl) return;

      try {
        setStatus('connecting');
        rfb = new RFBClass(containerRef.current, wsUrl);

        rfb.viewOnly = viewOnly || false;
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.focusOnClick = true;
        rfb.clipViewport = false;
        rfb.qualityLevel = 9;
        rfb.compressionLevel = 2;
        rfb.showDotCursor = true;

        rfb.addEventListener('connect', () => {
          setStatus('connected');
          if (onConnectRef.current) onConnectRef.current(rfb);
        });

        rfb.addEventListener('disconnect', () => {
          setStatus('disconnected');
          if (onDisconnectRef.current) onDisconnectRef.current();
        });

        rfbRef.current = rfb;
      } catch (err) {
        console.error('VNC init error:', err);
        setStatus('error');
      }
    };

    if (RFBClass && wsUrl && containerRef.current) {
      initVNC();
    }

    return () => {
      if (rfb) {
        rfb.disconnect();
        rfbRef.current = null;
      }
    };
  }, [RFBClass, wsUrl]);

  useEffect(() => {
    if (rfbRef.current) {
      rfbRef.current.viewOnly = viewOnly || false;
    }
  }, [viewOnly]);

  return (
    <div className="vnc-viewer">
      <div ref={containerRef} className="vnc-container" />
      <div className={`vnc-status-badge vnc-status-${status}`}>{getStatusLabel(status)}</div>
    </div>
  );
}
