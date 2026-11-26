/**
 * One Lichess account control for every tichess page. Signing in once (Lichess
 * OAuth, zero scopes) sets a site-wide session cookie, so every page sees the
 * same account: Studio explorers and "My Games", Repertoire sync, and Insights.
 *
 * Pages call initCloudSync() as before; this module only renders the button
 * and its menu from the shared sync state.
 */
import './account.css';
import { onCloudSyncState, getCloudSyncState, getLoginUrl, syncNow, signOutCloudSync } from '../sync/cloudSync.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function relTime(t) {
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const LICHESS_ICON = '<span class="ta-knight" aria-hidden="true">♞</span>';

let menuOpen = false;

function render(host, snap) {
  if (!snap.configured) {
    host.innerHTML = '';
    host.hidden = true;
    return;
  }
  host.hidden = false;
  if (!(snap.authenticated && snap.user)) {
    host.innerHTML = `<a class="ta-signin" href="${esc(getLoginUrl())}" title="Sign in once with Lichess to use your account on every page">${LICHESS_ICON}<span>Sign in</span></a>`;
    return;
  }
  const name = snap.user.username || 'Lichess';
  const dotCls = snap.status === 'syncing' ? 'is-syncing' : snap.status === 'error' || snap.status === 'offline' ? 'is-warn' : 'is-ok';
  const status =
    snap.status === 'syncing'
      ? 'Syncing…'
      : snap.status === 'error'
        ? snap.error || 'Sync error'
        : snap.status === 'offline'
          ? 'Offline: changes sync when you reconnect'
          : `Synced ${relTime(snap.lastSyncedAt)}`;
  host.innerHTML = `<button class="ta-chip" type="button" aria-haspopup="menu" aria-expanded="${menuOpen}" title="Signed in with Lichess as ${esc(name)}">
      <span class="ta-avatar">${esc(name.slice(0, 1).toUpperCase())}<i class="ta-dot ${dotCls}"></i></span><span class="ta-name">${esc(name)}</span>
    </button>
    <div class="ta-menu" role="menu" ${menuOpen ? '' : 'hidden'}>
      <div class="ta-head">${LICHESS_ICON}<div><div class="ta-title">${esc(name)}</div><div class="ta-sub">${esc(status)}</div></div></div>
      <p class="ta-note">Signed in on every tichess page: your games in Insights, your explorer in the Studio, and your repertoire and progress on all your devices.</p>
      <button type="button" role="menuitem" data-ta="sync">Sync repertoire and progress</button>
      <button type="button" role="menuitem" data-ta="signout">Sign out</button>
    </div>`;
}

/** Render the account control into every `[data-account]` element on the page. */
export function mountAccount() {
  const hosts = [...document.querySelectorAll('[data-account]')];
  if (!hosts.length) return;
  for (const host of hosts) {
    host.classList.add('ta');
    host.hidden = true;
    host.addEventListener('click', async (e) => {
      const chip = e.target.closest('.ta-chip');
      const item = e.target.closest('[data-ta]');
      if (chip) {
        menuOpen = !menuOpen;
        render(host, getCloudSyncState());
      } else if (item?.dataset.ta === 'sync') {
        menuOpen = false;
        await syncNow();
      } else if (item?.dataset.ta === 'signout') {
        menuOpen = false;
        await signOutCloudSync();
      }
    });
  }
  document.addEventListener('click', (e) => {
    // composedPath() still lists the host when the clicked node was re-rendered away.
    if (!menuOpen || hosts.some((h) => e.composedPath().includes(h))) return;
    menuOpen = false;
    hosts.forEach((h) => render(h, getCloudSyncState()));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !menuOpen) return;
    menuOpen = false;
    hosts.forEach((h) => render(h, getCloudSyncState()));
  });
  onCloudSyncState((snap) => hosts.forEach((h) => render(h, snap)));
  hosts.forEach((h) => render(h, getCloudSyncState()));
}
