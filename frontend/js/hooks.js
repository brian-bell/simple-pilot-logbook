/** Shared Preact hooks. */

import { useEffect, useRef } from "preact/hooks";

/**
 * Call fn now and then every intervalMs while enabled is true.
 * Always calls the latest fn, so callers need not memoize it.
 */
export function usePolling(fn, intervalMs, enabled) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;
    fnRef.current();
    const timer = setInterval(() => fnRef.current(), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
}
