/** Register the PWA service worker on supported origins without blocking startup. */
export function registerPwa() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  const isSecure =
    window.location.protocol === 'https:' ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1';
  if (!isSecure) return;
  window.addEventListener(
    'load',
    () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    },
    { once: true }
  );
}
