/**
 * The tichess section switcher shared by all pages: Insights (your own
 * performance), Studio (analysis and prep) and Repertoire (drill your
 * openings). Plain CSS, so it looks the same on Tailwind and non-Tailwind pages.
 */
import './appNav.css';

export const SECTIONS = [
  {
    id: 'insights',
    label: 'Insights',
    href: 'insights.html',
    title: 'Your games, openings, opponents and habits',
    icon: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  },
  {
    id: 'studio',
    label: 'Studio',
    href: './',
    title: 'Analysis board, explorers, engines and live events',
    icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  },
  {
    id: 'repertoire',
    label: 'Repertoire',
    href: 'repertoire.html',
    title: 'Build and drill your opening repertoire',
    icon: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5M8 7h7"/>',
  },
];

/** HTML for the brand and section links. `active` is a section id. */
export function appNavHtml(active) {
  const links = SECTIONS.map(
    (s) =>
      `<a class="tn-link${s.id === active ? ' is-active' : ''}" href="${s.href}" title="${s.title}"${
        s.id === active ? ' aria-current="page"' : ''
      }><svg viewBox="0 0 24 24" aria-hidden="true">${s.icon}</svg><span>${s.label}</span></a>`
  ).join('');
  return `<a class="tn-brand" href="./" aria-label="tichess home"><span class="tn-logo" aria-hidden="true">♞</span><span class="tn-word">tichess</span></a><nav class="tn-nav" aria-label="Sections">${links}</nav>`;
}

/** Fill every `[data-app-nav]` element on the page. */
export function mountAppNav(active) {
  document.querySelectorAll('[data-app-nav]').forEach((el) => {
    el.classList.add('tn');
    el.innerHTML = appNavHtml(active);
  });
}
