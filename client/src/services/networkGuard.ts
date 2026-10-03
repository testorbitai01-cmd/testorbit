/**
 * Privacy guard: the app only ever talks to its own origin (`/api`, static
 * assets). Third-party libraries running in the page — notably the MediaPipe
 * face detector, which tries to POST usage metrics to Google — must not be
 * able to send anything elsewhere. The production CSP (`connect-src 'self'`)
 * already blocks this in the browser; this guard additionally stops it in code,
 * including in development where no CSP is applied.
 */
let installed = false;
export const blockedRequests: string[] = [];

export function isSameOrigin(input: RequestInfo | URL, origin = window.location.origin): boolean {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(raw, origin).origin === origin;
  } catch {
    return false;
  }
}

export function installNetworkGuard(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isSameOrigin(input)) {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      blockedRequests.push(new URL(target).origin);
      return Promise.reject(new TypeError('Blocked by Test Orbit privacy guard: third-party network request'));
    }
    return original(input, init);
  };
  // sendBeacon is another channel some libraries use for telemetry.
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => (isSameOrigin(url) ? beacon(url, data) : false);
  }
}
