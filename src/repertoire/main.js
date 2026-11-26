import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
import './repertoire.css';

import { parseRepertoireFile, mergeProgress, buildExportFile } from './model.js';
import { loadRepertoire, saveRepertoire, loadProgress, saveProgress } from './storage.js';
import { startTrainer } from './app.js';

const $ = (id) => document.getElementById(id);

function showImporter(error) {
  $('v-import').hidden = false;
  document.querySelector('.tabs-top').hidden = true;
  document.querySelector('.tabbar').hidden = true;
  $('sync').textContent = '';
  const err = $('imp-err');
  err.hidden = !error;
  err.textContent = error || '';
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
    await saveRepertoire(parsed.repertoire, parsed.name);
  } catch (_) {
    showImporter('This browser would not save the repertoire (storage is full or blocked, or this is a private window).');
    return;
  }
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
  const rep = await loadRepertoire();
  if (!rep) {
    showImporter(null);
    return;
  }
  $('whoami').textContent = rep.name || '';
  $('b-export').hidden = false;
  $('b-export').onclick = () => exportBackup(rep);
  $('b-import').hidden = false;
  $('b-import').title = 'Load an updated repertoire file. Progress is merged, keeping the most recent result per move.';
  $('b-import').onclick = () => $('imp-file2').click();
  try {
    startTrainer({ data: rep.repertoire, progress: loadProgress(), saveProgress });
  } catch (err) {
    console.error(err);
    showImporter('The saved repertoire could not be opened. Import the file again.');
  }
}

boot();
