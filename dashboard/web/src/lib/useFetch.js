import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from './api.js';

// Loads `path` on mount and exposes a reload(). Optionally polls every
// `pollMs`. Returns { data, error, loading, reload }.
export function useFetch(path, { pollMs = 0, enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const pathRef = useRef(path);
  pathRef.current = path;

  const reload = useCallback(async () => {
    try {
      const d = await api.get(pathRef.current);
      setData(d);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    setLoading(true);
    reload();
    if (pollMs > 0) {
      const t = setInterval(reload, pollMs);
      return () => clearInterval(t);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, pollMs, enabled, reload]);

  return { data, error, loading, reload };
}
