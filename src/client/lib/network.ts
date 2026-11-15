/**
 * Offline feedback. `requestJson` reports network failures here, keyed by the
 * endpoint it failed on, and clears them one by one as each succeeds. A toast
 * for an unrelated success must not hide the state of a request that is still
 * unreachable, and Retry must re-run the request that actually failed.
 */

import { hideRetryToast, showRetryToast } from "./dom";

const failures = new Map<string, () => void>();
let lastKey: string | null = null;

export function reportNetworkFailure(key: string, retry: (() => void) | null): void {
  if (retry) failures.set(key, retry);
  else if (!failures.has(key)) failures.set(key, () => window.location.reload());
  lastKey = key;
  showRetryToast("Network unavailable", () => {
    const action = lastKey ? failures.get(lastKey) : null;
    if (action) action();
    else window.location.reload();
  });
}

export function reportNetworkSuccess(key: string): void {
  if (!failures.delete(key)) return;
  if (failures.size === 0) {
    lastKey = null;
    hideRetryToast();
    return;
  }
  if (key === lastKey) {
    const remaining = [...failures.keys()];
    lastKey = remaining.length > 0 ? remaining[remaining.length - 1]! : null;
  }
}

/** Test seam: forget every recorded failure. */
export function resetNetworkState(): void {
  failures.clear();
  lastKey = null;
  hideRetryToast();
}
