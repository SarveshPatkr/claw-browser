import { useState, useEffect } from 'react';

export function useNoVNC() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [RFB, setRFB] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        if (window.RFB) {
          const RFBModule = window.RFB;
          setRFB(() => RFBModule.default || RFBModule);
          setLoading(false);
          return;
        }

        const baseUrl = import.meta.env.BASE_URL || './';
        const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

        const script = document.createElement('script');
        script.src = `${normalizedBase}core/rfb-bundle.js`;
        script.onload = () => {
          const RFBModule = window.RFB;
          setRFB(() => RFBModule.default || RFBModule);
          setLoading(false);
        };
        script.onerror = () => {
          setError(new Error('Failed to load noVNC'));
          setLoading(false);
        };
        document.head.appendChild(script);
      } catch (err) {
        console.error('Failed to load noVNC:', err);
        setError(err.message);
        setLoading(false);
      }
    }

    load();
  }, []);

  return { RFB, KeyTable: null, loading, error };
}

export function press(rfb, keysym, code, down) {
  if (rfb) {
    rfb.sendKey(keysym, code, down);
  }
}

export function tap(rfb, keysym, code) {
  if (rfb) {
    rfb.sendKey(keysym, code, true);
    rfb.sendKey(keysym, code, false);
  }
}
