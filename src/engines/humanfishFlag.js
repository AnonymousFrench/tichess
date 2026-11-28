/**
 * HumanFish is on by default. Its API proxy only serves signed-in users of this
 * site (see api/humanfish/evaluate.js). To hide it, build with
 * VITE_HUMANFISH_ENABLED=false and set HUMANFISH_ENABLED=false for the API.
 */
export function isHumanfishEnabled(env = import.meta.env) {
  return String(env?.VITE_HUMANFISH_ENABLED ?? '').trim().toLowerCase() !== 'false';
}

export const HUMANFISH_ENABLED = isHumanfishEnabled();
