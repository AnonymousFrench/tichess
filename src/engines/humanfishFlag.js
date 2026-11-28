/**
 * HumanFish is off by default: it models 2400–2900 FIDE over-the-board play and
 * sends positions to a third-party server. Build with VITE_HUMANFISH_ENABLED=true
 * (and set HUMANFISH_ENABLED=true for the API) to bring it back.
 */
export function isHumanfishEnabled(env = import.meta.env) {
  return String(env?.VITE_HUMANFISH_ENABLED || '').trim().toLowerCase() === 'true';
}

export const HUMANFISH_ENABLED = isHumanfishEnabled();
