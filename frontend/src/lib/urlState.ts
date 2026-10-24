import { useCallback, useEffect, useState } from "react";

/** Keep a few query-string parameters in sync with React state (deep-linkable views). */
export function useQueryParams(): [URLSearchParams, (updates: Record<string, string | null>) => void] {
  const [params, setParams] = useState(() => new URLSearchParams(window.location.search));

  useEffect(() => {
    const onPop = () => setParams(new URLSearchParams(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const update = useCallback((updates: Record<string, string | null>) => {
    const next = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    setParams(next);
  }, []);

  return [params, update];
}

export const isIsoDate = (value: string | null): value is string => !!value && /^\d{4}-\d{2}-\d{2}$/.test(value);

export function clampDate(value: string | null, min: string, max: string, fallback: string): string {
  if (!isIsoDate(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
