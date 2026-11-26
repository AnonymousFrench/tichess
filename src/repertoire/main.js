import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
import './repertoire.css';

import { parseRepertoireFile, mergeProgress, buildExportFile } from './model.js';
import { buildRepertoireFromPgn, mergeRepertoires } from './pgnImport.js';
import { loadRepertoire, saveRepertoire, loadProgress, saveProgress } from './storage.js';
import { startTrainer } from './app.js';
import {
  initCloudSync,
  onCloudSyncState,
  onCloudDataPulled,
  getLoginUrl,
  pushRepertoireToCloud,
  scheduleProgressSync,
  signOutCloudSync,
} from '../sync/cloudSync.js';

const $ = (id) => document.getElementById(id);

function showImporter(error) {
  $('v-import').hidden = false;
  document.querySelector('.tabs-top').hidden = true;
  document.querySelector('.tabbar').hidden = true;
  const err = $('imp-err');
  err.hidden = !error;
  err.textContent = error || '';
}

function renderSyncHeader(snap) {
  const syncEl = $('sync');
  const authBtn = $('b-sync-auth');
  const cloudRow = $('imp-cloud-row');

  if (snap.authenticated && snap.user) {
    if (syncEl) {
      syncEl.textContent =
        snap.status === 'syncing'
          ? '☁ Syncing…'
          : snap.status === 'error'
            ? '☁ Sync error'
            : snap.status === 'offline'
              ? '☁ Offline'
              : `☁ ${snap.user.username}`;
      syncEl.title = snap.error || 'Synced automatically across devices';
    }
    if (authBtn) {
      authBtn.hidden = false;
      authBtn.textContent = 'Sign out';
      authBtn.onclick = async () => {
        await signOutCloudSync();
      };
    }
    if (cloudRow) cloudRow.hidden = true;
  } else if (snap.configured) {
    if (syncEl) syncEl.textContent = 'Local';
    if (authBtn) {
      authBtn.hidden = false;
      authBtn.textContent = 'Sign in';
      authBtn.onclick = () => {
        window.location.href = getLoginUrl('/repertoire.html');
      };
    }
    if (cloudRow) cloudRow.hidden = false;
  } else {
    if (authBtn) authBtn.hidden = true;
    if (cloudRow) cloudRow.hidden = true;
  }
}

async function importFile(file) {
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch (_) {
    showImporter('Could not read that file.');
    return;
  }

  const trimmed = text.trim();
  const looksJson = file.name?.toLowerCase().endsWith('.json') || trimmed.startsWith('{');
  const updatedAt = Date.now();

  if (looksJson) {
    const parsed = parseRepertoireFile(text);
    if (!parsed.ok) {
      showImporter(parsed.error);
      return;
    }
    const merged = mergeProgress(loadProgress(), parsed.progress);
    if (!saveProgress(merged)) {
      showImporter('This browser would not save your progress (storage is full or blocked).');
      return;
    }
    try {
      await saveRepertoire(parsed.repertoire, parsed.name, updatedAt);
    } catch (_) {
      showImporter('This browser would not save the repertoire (storage is full or blocked, or this is a private window).');
      return;
    }
    await pushRepertoireToCloud(parsed.repertoire, parsed.name, updatedAt, merged);
    location.reload();
    return;
  }

  const color = $('imp-pgn-color')?.value === 'b' ? 'b' : 'w';
  const built = buildRepertoireFromPgn(text, {
    color,
    name: file.name ? file.name.replace(/\.pgn$/i, '') : '',
  });
  if (!built.ok) {
    showImporter(built.error);
    return;
  }
  const existing = await loadRepertoire();
  const nextRep = existing?.repertoire
    ? mergeRepertoires(existing.repertoire, built.repertoire)
    : built.repertoire;
  const nextName = existing?.name || built.name;
  try {
    await saveRepertoire(nextRep, nextName, updatedAt);
  } catch (_) {
    showImporter('This browser would not save the repertoire (storage is full or blocked, or this is a private window).');
    return;
  }
  await pushRepertoireToCloud(nextRep, nextName, updatedAt, loadProgress());
  location.reload();
}

function exportBackup(rep) {
  const now = Date.now();
  const blob = new Blob([buildExportFile(rep.repertoire, loadProgress(), rep.name, now)], { type: 'application/json' });
  const d = new Date(now);
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tichess-repertoire-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function bindImportControls() {
  const drop = $('imp-drop');
  $('imp-file').onchange = (e) => importFile(e.target.files[0]);
  $('imp-file2').onchange = (e) => importFile(e.target.files[0]);
  const cloudSignIn = $('imp-cloud-signin');
  if (cloudSignIn) {
    cloudSignIn.onclick = () => {
      window.location.href = getLoginUrl('/repertoire.html');
    };
  }
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      $('imp-file').click();
    }
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    importFile(e.dataTransfer.files[0]);
  });
}

async function boot() {
  bindImportControls();
  onCloudSyncState(renderSyncHeader);

  let trainerStarted = false;

  // Check cloud auth + pull before deciding whether to show the empty import screen
  const syncSnap = await initCloudSync();
  renderSyncHeader(syncSnap);

  const rep = await loadRepertoire();
  if (!rep) {
    showImporter(syncSnap?.error || null);
    onCloudDataPulled((changes) => {
      if (changes.repertoireUpdated && !trainerStarted) location.reload();
    });
    return;
  }

  $('whoami').textContent = rep.name || '';
  $('b-export').hidden = false;
  $('b-export').onclick = () => exportBackup(rep);
  $('b-import').hidden = false;
  $('b-import').title = 'Load an updated repertoire file. Progress is merged, keeping the most recent result per move.';
  $('b-import').onclick = () => $('imp-file2').click();

  const syncedSaveProgress = (p) => {
    const ok = saveProgress(p);
    if (ok) scheduleProgressSync(p);
    return ok;
  };

  onCloudDataPulled((changes) => {
    if (changes.repertoireUpdated) {
      location.reload();
    }
  });

  try {
    trainerStarted = true;
    startTrainer({ data: rep.repertoire, progress: loadProgress(), saveProgress: syncedSaveProgress });
    renderSyncHeader(syncSnap);
  } catch (err) {
    console.error(err);
    showImporter('The saved repertoire could not be opened. Import the file again.');
  }
}

boot();
