import { useEffect, useState, useCallback } from "react";

/**
 * Read/write a single key in the global settings store (`/api/settings`).
 *
 * Intentionally toast-free: callers own the UX. A toggle wants optimistic
 * update with rollback on failure; a text field wants an explicit Save. Both
 * compose from the same primitives — `update` (local, marks dirty), `setValue`
 * (local, for rollback) and `persist` (network, returns whether it stuck).
 */
export function useSetting(key: string, fallback: string) {
  const [value, setValue] = useState(fallback);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Abort on unmount/key change: without it a slow response for the PREVIOUS key
    // could land after the new one and overwrite it, showing a value that belongs to
    // a setting the component is no longer reading.
    const ac = new AbortController();
    fetch(`/api/settings?key=${key}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.value != null) setValue(data.value);
        setLoading(false);
      })
      .catch(() => {
        // An abort is not a load failure — leave `loading` alone so the replacing
        // effect owns the state, and never surface it as an error.
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [key]);

  const update = useCallback((v: string) => {
    setValue(v);
    setDirty(true);
  }, []);

  const persist = useCallback(
    async (v: string) => {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: v }),
      });
      if (res.ok) setDirty(false);
      return res.ok;
    },
    [key],
  );

  return { value, update, setValue, persist, dirty, loading };
}
