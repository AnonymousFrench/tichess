import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@fontsource/ibm-plex-mono/700.css';
import './styles.css';
import {
  state,
  START_FEN,
  getActiveTab,
  getCurrentFen,
  showToast,
  copyText,
  debounce,
  onPositionChange,
  emitPositionChanged,
} from './state.js';
import { createNode, exportTreeToPgn } from './chess/tree.js';
import { encodeShareHash, decodeShareHash } from './chess/shareUrl.js';
import { dbWipeAll } from './db/indexedDb.js';
import { renderBoard, renderArrows, initBoardInteractions } from './board/board.js';
import {
  renderBoardTabs,
  addBoardTab,
  addPrebuiltBoardTab,
  renderVariationTree,
  promoteVar,
  deleteVar,
} from './board/tabs.js';
import { updateEvalBarFromState } from './engines/uci.js';
import {
  initStockfish,
  stopLocalSf,
  triggerSfAnalysis,
  connectSfWs,
  disconnectSfWs,
  updateBridgeStatusBadge,
} from './engines/stockfish.js';
import {
  initLc0,
  triggerLc0Analysis,
  connectLc0Ws,
  disconnectLc0Ws,
  setLc0SettingsHandler,
} from './engines/lc0.js';
import {
  startActiveTabReview,
  cancelGameReview,
  renderGameReviewPanel,
} from './engines/gameReview.js';
import {
  discoverAndSyncLiveBroadcasts,
  renderTournamentRoundsTable,
  renderAllBroadcastsList,
  loadCustomBroadcastFromInput,
  openFeaturedLiveGame,
  startLivePollTimer,
} from './live/liveEvents.js';
import { refreshReferenceExplorer, renderMasterGamesTable } from './explorer/explorer.js';
import {
  refreshPlayerScout,
  renderScoutedGamesTable,
  reloadCollections,
  renderSyncedScoutTargets,
  runLichessSync,
  runChessComSync,
  handlePgnFileImport,
} from './scout/scout.js';
import {
  initStudioRepertoire,
  bindStudioRepertoireSync,
  renderStudioRepertoirePanel,
} from './repertoire/studioPanel.js';
import {
  initCloudSync,
  getCloudSyncState,
  onCloudSyncState,
  onCloudDataPulled,
  getLoginUrl,
  syncNow,
  signOutCloudSync,
} from './sync/cloudSync.js';
import { mountModals } from './ui/modals.js';

function switchHub(hubName) {
  state.activeHub = hubName;
  document.querySelectorAll('.hub-tab').forEach((b) => {
    const act = b.dataset.hub === hubName;
    b.setAttribute('aria-selected', String(act));
    b.className = act
      ? 'hub-tab flex items-center gap-1.5 px-2.5 py-1 rounded-t text-[11.5px] font-semibold bg-panel text-txt border-t border-x border-borderSubtle whitespace-nowrap'
      : 'hub-tab flex items-center gap-1.5 px-2.5 py-1 rounded-t text-[11.5px] font-medium text-txtMuted hover:text-txt whitespace-nowrap';
  });
  ['live', 'masters', 'scouted', 'repertoire'].forEach((k) =>
    document.getElementById(`hub-${k}`).classList.toggle('hidden', k !== hubName)
  );
  document.getElementById('livePollBar').classList.toggle('hidden', hubName !== 'live');
  if (hubName === 'masters') renderMasterGamesTable();
  if (hubName === 'scouted') renderScoutedGamesTable();
  if (hubName === 'repertoire') renderStudioRepertoirePanel();
}

function openModal(id) {
  document.querySelectorAll('.menu-dropdown').forEach((d) => d.classList.add('hidden'));
  if (id === 'settingsModal') {
    document.getElementById('inputLichessToken').value = state.lichessToken;
    document.getElementById('inputLc0WsUrl').value = state.lc0.wsUrl;
    document.getElementById('inputSfWsUrl').value = state.sf.wsUrl;
    updateBridgeStatusBadge();
    renderCloudSyncUI(getCloudSyncState());
  }
  if (id === 'scoutModal') {
    renderSyncedScoutTargets();
  }
  document.getElementById(id).classList.remove('hidden');
}

function renderCloudSyncUI(snap) {
  const dot = document.getElementById('cloudSyncDot');
  const lbl = document.getElementById('cloudSyncLabel');
  const badge = document.getElementById('settingsSyncStatusBadge');
  const desc = document.getElementById('settingsSyncDesc');
  const btnSignIn = document.getElementById('btnSettingsSignIn');
  const btnSyncNow = document.getElementById('btnSettingsSyncNow');
  const btnSignOut = document.getElementById('btnSettingsSignOut');

  if (snap.authenticated && snap.user) {
    if (dot) {
      dot.className = `w-2 h-2 rounded-full ${
        snap.status === 'syncing'
          ? 'bg-cy live-dot'
          : snap.status === 'error' || snap.status === 'offline'
            ? 'bg-am'
            : 'bg-em'
      }`;
    }
    if (lbl) lbl.textContent = snap.status === 'syncing' ? 'Syncing…' : snap.user.username;
    if (badge) {
      badge.textContent =
        snap.status === 'syncing'
          ? 'Syncing...'
          : snap.status === 'error'
            ? 'Sync Error'
            : snap.status === 'offline'
              ? 'Offline'
              : `Synced · ${snap.user.username}`;
      badge.className = `font-mono text-[10px] px-1.5 py-0.5 rounded bg-panel ${
        snap.status === 'error' ? 'text-ro' : 'text-em'
      }`;
    }
    if (desc) {
      desc.textContent = snap.error
        ? snap.error
        : `Signed in as ${snap.user.username}. Your repertoire, drill progress, and scouted player list sync automatically between phone and computer.`;
    }
    if (btnSignIn) btnSignIn.classList.add('hidden');
    if (btnSyncNow) btnSyncNow.classList.remove('hidden');
    if (btnSignOut) btnSignOut.classList.remove('hidden');
  } else if (snap.configured) {
    if (dot) dot.className = 'w-2 h-2 rounded-full bg-cy';
    if (lbl) lbl.textContent = 'Sign in';
    if (badge) {
      badge.textContent = 'Ready';
      badge.className = 'font-mono text-[10px] px-1.5 py-0.5 rounded bg-panel text-cy';
    }
    if (desc) {
      desc.textContent =
        snap.error ||
        'Sign in with Lichess (zero scopes needed) to automatically sync your opening repertoire, spaced-repetition progress, and scouted player list between phone and desktop.';
    }
    if (btnSignIn) {
      btnSignIn.classList.remove('hidden');
      btnSignIn.disabled = false;
    }
    if (btnSyncNow) btnSyncNow.classList.add('hidden');
    if (btnSignOut) btnSignOut.classList.add('hidden');
  } else {
    if (dot) dot.className = 'w-2 h-2 rounded-full bg-txtMuted/50';
    if (lbl) lbl.textContent = 'Sync';
    if (badge) {
      badge.textContent = 'Local Only';
      badge.className = 'font-mono text-[10px] px-1.5 py-0.5 rounded bg-panel text-txtMuted';
    }
    if (desc) {
      desc.textContent =
        snap.error ||
        'Cloud sync requires Neon Postgres connected in your Vercel project Storage tab (DATABASE_URL). Once connected, Sign in with Lichess syncs phone and desktop automatically.';
    }
    if (btnSignIn) btnSignIn.classList.remove('hidden');
    if (btnSyncNow) btnSyncNow.classList.add('hidden');
    if (btnSignOut) btnSignOut.classList.add('hidden');
  }
}

function flipBoard() {
  state.flipped = !state.flipped;
  renderBoard();
  updateEvalBarFromState();
}

function toggleBothEngines() {
  const next = !(state.sf.running || (state.lc0.mode === 'ws' && state.lc0.running));
  state.sf.running = next;
  state.lc0.running = next;
  document.getElementById('btnSfToggle').textContent = next ? '⏸' : '▶';
  document.getElementById('btnLc0Toggle').textContent = next ? '⏸' : '▶';
  triggerSfAnalysis();
  triggerLc0Analysis();
}

function toggleSfCloud() {
  state.sf.cloudEnabled = !state.sf.cloudEnabled;
  document.getElementById('btnSfCloud').className = state.sf.cloudEnabled
    ? 'px-1.5 py-0.5 rounded bg-cy/20 text-cy border border-cy/40 text-[10px] font-medium'
    : 'px-1.5 py-0.5 rounded bg-surface text-txtMuted border border-borderSubtle text-[10px] font-medium';
  document.getElementById('chkCloudMenu').textContent = state.sf.cloudEnabled ? '✓' : '';
  triggerSfAnalysis();
}

function updateTokenDot() {
  const d = document.getElementById('tokenDot');
  if (!d) return;
  d.classList.toggle('bg-em', !!state.lichessToken);
  d.classList.toggle('bg-am', !state.lichessToken);
}

function bindEvents() {
  // Dropdowns
  document.querySelectorAll('.menu-trigger').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const m = document.getElementById(`menu-${btn.dataset.menu}`);
      const hid = m.classList.contains('hidden');
      document.querySelectorAll('.menu-dropdown').forEach((d) => d.classList.add('hidden'));
      if (hid) m.classList.remove('hidden');
    };
  });
  document.addEventListener('click', () =>
    document.querySelectorAll('.menu-dropdown').forEach((d) => d.classList.add('hidden'))
  );

  const copyShareLink = () => {
    const tab = getActiveTab();
    if (!tab) return;
    const hash = encodeShareHash(tab, { flipped: state.flipped });
    if (!hash) return;
    const url = `${window.location.origin}${window.location.pathname}${hash}`;
    copyText(url, 'Shareable link copied');
  };

  // Menu Actions
  document.getElementById('actNewTab').onclick = () => addBoardTab(`Analysis ${state.tabs.length + 1}`);
  document.getElementById('actLoadModal').onclick = () => openModal('loadModal');
  document.getElementById('actImportPgnMenu').onclick = () => document.getElementById('globalPgnInput').click();
  document.getElementById('actExportPgn').onclick = () => copyText(exportTreeToPgn(getActiveTab()), 'Exported PGN');
  document.getElementById('actShareLink').onclick = copyShareLink;
  document.getElementById('actResetTab').onclick = () => {
    const t = getActiveTab();
    cancelGameReview();
    t.root = createNode({ fen: START_FEN });
    t.current = t.root;
    t.review = null;
    emitPositionChanged();
  };
  document.getElementById('actFlipBoard').onclick = flipBoard;
  document.getElementById('actPromoteVar').onclick = promoteVar;
  document.getElementById('actDeleteVar').onclick = deleteVar;
  document.getElementById('actClearDrawings').onclick = () => {
    state.userHighlights.clear();
    state.userArrows = [];
    renderBoard();
  };
  document.getElementById('actToggleCoords').onclick = () => {
    state.showCoords = !state.showCoords;
    document.getElementById('chkCoords').textContent = state.showCoords ? '✓' : '';
    renderBoard();
  };
  document.getElementById('actToggleArrows').onclick = () => {
    state.showEngineArrows = !state.showEngineArrows;
    document.getElementById('chkArrows').textContent = state.showEngineArrows ? '✓' : '';
    renderArrows();
  };
  document.getElementById('actToggleEvalBar').onclick = () => {
    state.showEvalBar = !state.showEvalBar;
    document.getElementById('evalBarContainer').classList.toggle('hidden', !state.showEvalBar);
    document.getElementById('chkEvalBar').textContent = state.showEvalBar ? '✓' : '';
  };
  document.getElementById('actToggleBothEngines').onclick = toggleBothEngines;
  document.getElementById('actToggleCloudMenu').onclick = toggleSfCloud;
  document.getElementById('actOpenBridgeSettings').onclick = () => openModal('settingsModal');
  document.getElementById('btnMenuSettings').onclick = () => openModal('settingsModal');
  document.getElementById('btnTokenPill').onclick = () => openModal('settingsModal');
  document.getElementById('btnCloudSyncPill').onclick = () => {
    const snap = getCloudSyncState();
    if (snap.configured && !snap.authenticated) {
      window.location.href = getLoginUrl('/');
    } else {
      openModal('settingsModal');
    }
  };
  document.getElementById('btnSettingsSignIn').onclick = () => {
    const snap = getCloudSyncState();
    if (!snap.configured) {
      showToast('Connect Neon Postgres in Vercel Storage to enable cloud sync', true);
      return;
    }
    window.location.href = getLoginUrl('/');
  };
  document.getElementById('btnSettingsSyncNow').onclick = async () => {
    const r = await syncNow();
    showToast(r.ok ? 'Cloud sync up to date' : r.error || 'Sync failed', !r.ok);
  };
  document.getElementById('btnSettingsSignOut').onclick = async () => {
    await signOutCloudSync();
    showToast('Signed out (local data kept in this browser)');
  };

  // Quick-Jump & Left Rail
  document.getElementById('btnLiveQuickJump').onclick = () => {
    switchHub('live');
    if (state.liveRoundGames.length) openFeaturedLiveGame();
  };
  document.getElementById('railBoard').onclick = () =>
    document.getElementById('chessboard').scrollIntoView({ behavior: 'smooth' });
  document.getElementById('railLive').onclick = () => switchHub('live');
  document.getElementById('railScout').onclick = () => openModal('scoutModal');
  document.getElementById('railRepertoire').onclick = () => switchHub('repertoire');
  document.getElementById('railImportPgn').onclick = () => document.getElementById('globalPgnInput').click();
  document.getElementById('railSettings').onclick = () => openModal('settingsModal');
  document.getElementById('globalPgnInput').onchange = (e) => {
    if (e.target.files?.[0]) {
      handlePgnFileImport(e.target.files[0]);
      e.target.value = '';
    }
  };

  // Board & Navigation
  document.getElementById('btnAddBoardTab').onclick = () => addBoardTab(`Analysis ${state.tabs.length + 1}`);
  document.getElementById('evalBarContainer').onclick = () => {
    if (state.lc0.mode !== 'ws') {
      showToast('Connect Local Lc0 Bridge in Settings to switch Eval Bar to Lc0');
      return;
    }
    state.evalBarSource = state.evalBarSource === 'sf' ? 'lc0' : 'sf';
    updateEvalBarFromState();
  };
  document.getElementById('btnFirst').onclick = () => {
    const t = getActiveTab();
    t.current = t.root;
    emitPositionChanged();
  };
  document.getElementById('btnPrev').onclick = () => {
    const t = getActiveTab();
    if (t.current.parent) {
      t.current = t.current.parent;
      emitPositionChanged();
    }
  };
  document.getElementById('btnNext').onclick = () => {
    const t = getActiveTab();
    if (t.current.children.length) {
      t.current = t.current.children[0];
      emitPositionChanged();
    }
  };
  document.getElementById('btnLast').onclick = () => {
    const t = getActiveTab();
    while (t.current.children.length) t.current = t.current.children[0];
    emitPositionChanged();
  };
  document.getElementById('btnFlip').onclick = flipBoard;
  document.getElementById('btnCopyFen').onclick = () => copyText(getCurrentFen(), 'FEN copied');
  document.getElementById('btnCopyPgn').onclick = () => copyText(exportTreeToPgn(getActiveTab()), 'PGN copied');
  document.getElementById('btnShareLink').onclick = copyShareLink;
  document.getElementById('btnLiveFollow').onclick = () => {
    const t = getActiveTab();
    if (!t.liveMeta) return;
    t.autoFollow = !t.autoFollow;
    if (t.autoFollow) {
      while (t.current.children.length) t.current = t.current.children[0];
      emitPositionChanged();
    } else {
      renderBoardTabs();
    }
  };

  // NAGs & Comments
  document.querySelectorAll('.nag-btn').forEach((b) => {
    b.onclick = () => {
      const t = getActiveTab();
      if (t.current === t.root) return;
      const nag = b.dataset.nag;
      t.current.nags = t.current.nags.includes(nag) ? [] : [nag];
      renderVariationTree();
    };
  });
  document.getElementById('btnToggleComment').onclick = () => {
    const w = document.getElementById('commentEditorWrap');
    w.classList.toggle('hidden');
    if (!w.classList.contains('hidden')) {
      const inp = document.getElementById('commentInput');
      inp.value = getActiveTab().current.comment || '';
      inp.focus();
    }
  };
  document.getElementById('btnSaveComment').onclick = () => {
    getActiveTab().current.comment = document.getElementById('commentInput').value.trim();
    document.getElementById('commentEditorWrap').classList.add('hidden');
    renderVariationTree();
  };
  document.getElementById('btnPromoteVar').onclick = promoteVar;
  document.getElementById('btnDeleteVar').onclick = deleteVar;
  document.getElementById('btnGameReview').onclick = () => {
    const depth = parseInt(document.getElementById('reviewDepthSelect')?.value || '12', 10) || 12;
    startActiveTabReview({ depth });
  };

  // Top-Right Hub
  document.querySelectorAll('.hub-tab').forEach((b) => (b.onclick = () => switchHub(b.dataset.hub)));
  document.getElementById('btnWatchFeatured').onclick = openFeaturedLiveGame;
  document.getElementById('btnSyncLiveNow').onclick = () => {
    state.liveCountdown = 15;
    discoverAndSyncLiveBroadcasts();
  };
  document.getElementById('chkLiveAutoPoll').onchange = (e) => {
    state.liveAutoPoll = e.target.checked;
  };
  document.getElementById('btnLiveSubRounds').onclick = () => {
    document.getElementById('btnLiveSubRounds').className = 'px-2 py-0.5 rounded bg-em/20 text-em font-semibold';
    document.getElementById('btnLiveSubAll').className = 'px-2 py-0.5 rounded text-txtMuted hover:text-txt font-medium';
    document.getElementById('liveScheduleWrap').classList.remove('hidden');
    document.getElementById('liveAllBroadcastsWrap').classList.add('hidden');
  };
  document.getElementById('btnLiveSubAll').onclick = () => {
    document.getElementById('btnLiveSubAll').className = 'px-2 py-0.5 rounded bg-cy/20 text-cy font-semibold';
    document.getElementById('btnLiveSubRounds').className = 'px-2 py-0.5 rounded text-txtMuted hover:text-txt font-medium';
    document.getElementById('liveAllBroadcastsWrap').classList.remove('hidden');
    document.getElementById('liveScheduleWrap').classList.add('hidden');
    renderAllBroadcastsList();
  };
  document.getElementById('broadcastSearchInput').oninput = renderAllBroadcastsList;
  document.getElementById('btnLoadCustomBroadcast').onclick = loadCustomBroadcastFromInput;

  // Explorers
  document.getElementById('refSrcMasters').onclick = () => {
    state.refSource = 'masters';
    document.getElementById('refSrcMasters').className =
      'px-2 py-0.5 rounded text-[11px] font-semibold bg-em/20 text-em border border-em/35';
    document.getElementById('refSrcLichess').className =
      'px-2 py-0.5 rounded text-[11px] font-semibold text-txtMuted hover:text-txt';
    refreshReferenceExplorer();
  };
  document.getElementById('refSrcLichess').onclick = () => {
    state.refSource = 'lichess';
    document.getElementById('refSrcLichess').className =
      'px-2 py-0.5 rounded text-[11px] font-semibold bg-cy/20 text-cy border border-cy/35';
    document.getElementById('refSrcMasters').className =
      'px-2 py-0.5 rounded text-[11px] font-semibold text-txtMuted hover:text-txt';
    refreshReferenceExplorer();
  };
  document.getElementById('refAuthNote').onclick = () => openModal('settingsModal');
  document.getElementById('scoutCollectionSelect').onchange = (e) => {
    state.activeScoutId = e.target.value;
    refreshPlayerScout();
    if (state.activeHub === 'scouted') renderScoutedGamesTable();
  };
  document.querySelectorAll('.scout-col-btn').forEach((b) => {
    b.onclick = () => {
      state.scoutColor = b.dataset.col;
      document.querySelectorAll('.scout-col-btn').forEach(
        (x) =>
          (x.className =
            x === b
              ? 'scout-col-btn px-1.5 rounded bg-em/20 text-em font-bold'
              : 'scout-col-btn px-1.5 rounded text-txtMuted hover:text-txt')
      );
      refreshPlayerScout();
    };
  });
  document.getElementById('btnOpenScoutModal').onclick = () => openModal('scoutModal');

  // Engines
  document.getElementById('btnLc0Toggle').onclick = () => {
    state.lc0.running = !state.lc0.running;
    document.getElementById('btnLc0Toggle').textContent = state.lc0.running ? '⏸' : '▶';
    triggerLc0Analysis();
  };
  document.getElementById('btnLc0ContemptDec').onclick = () => {
    state.lc0.contempt = Math.max(-100, state.lc0.contempt - 20);
    document.getElementById('lc0ContemptVal').textContent = state.lc0.contempt;
    triggerLc0Analysis();
  };
  document.getElementById('btnLc0ContemptInc').onclick = () => {
    state.lc0.contempt = Math.min(100, state.lc0.contempt + 20);
    document.getElementById('lc0ContemptVal').textContent = state.lc0.contempt;
    triggerLc0Analysis();
  };
  document.getElementById('btnLc0Bridge').onclick = () => openModal('settingsModal');
  document.getElementById('btnSfToggle').onclick = () => {
    state.sf.running = !state.sf.running;
    document.getElementById('btnSfToggle').textContent = state.sf.running ? '⏸' : '▶';
    triggerSfAnalysis();
  };
  document.getElementById('btnSfCloud').onclick = toggleSfCloud;

  // Modals
  document.querySelectorAll('.modal-close').forEach(
    (b) => (b.onclick = () => b.closest('.fixed').classList.add('hidden'))
  );
  ['loadModal', 'scoutModal', 'settingsModal'].forEach((id) =>
    document.getElementById(id).addEventListener('click', (e) => {
      if (e.target.id === id) e.target.classList.add('hidden');
    })
  );
  document.getElementById('btnConfirmLoad').onclick = () => {
    const txt = document.getElementById('loadPgnTextarea').value.trim();
    if (!txt) return;
    addBoardTab(document.getElementById('loadTabTitle').value.trim(), txt);
    document.getElementById('loadPgnTextarea').value = '';
    document.getElementById('loadTabTitle').value = '';
    document.getElementById('loadModal').classList.add('hidden');
  };
  document.getElementById('btnRunLichessSync').onclick = runLichessSync;
  document.getElementById('btnRunChesscomSync').onclick = runChessComSync;
  document.getElementById('scPgnFileInput').onchange = (e) => {
    if (e.target.files?.[0]) {
      handlePgnFileImport(e.target.files[0], document.getElementById('scPgnPlayerFilter').value.trim());
      e.target.value = '';
    }
  };
  document.getElementById('btnSaveToken').onclick = () => {
    state.lichessToken = document.getElementById('inputLichessToken').value.trim();
    localStorage.setItem('cms_lichess_token', state.lichessToken);
    updateTokenDot();
    showToast('Lichess token saved');
    refreshReferenceExplorer();
  };
  document.getElementById('btnClearToken').onclick = () => {
    state.lichessToken = '';
    localStorage.removeItem('cms_lichess_token');
    document.getElementById('inputLichessToken').value = '';
    updateTokenDot();
    showToast('Token cleared');
    refreshReferenceExplorer();
  };
  document.getElementById('btnConnectLc0Ws').onclick = () =>
    connectLc0Ws(document.getElementById('inputLc0WsUrl').value.trim());
  document.getElementById('btnDisconnectLc0Ws').onclick = disconnectLc0Ws;
  document.getElementById('btnConnectSfWs').onclick = () =>
    connectSfWs(document.getElementById('inputSfWsUrl').value.trim());
  document.getElementById('btnDisconnectSfWs').onclick = disconnectSfWs;
  document.getElementById('btnCopyBridgeScript').onclick = () =>
    copyText(document.getElementById('bridgeScriptCode').textContent, 'Copied bridge.js');
  document.getElementById('btnWipeDb').onclick = async () => {
    await dbWipeAll();
    await reloadCollections();
    showToast('Cleared local databases');
  };

  // Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
    const target = e.target;
    const tag = target?.tagName || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
      return;
    }
    if (e.altKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      addBoardTab(`Analysis ${state.tabs.length + 1}`);
      return;
    }
    const t = getActiveTab();
    if (!t) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (t.current.parent) {
        t.current = t.current.parent;
        emitPositionChanged();
      }
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (t.current.children.length) {
        t.current = t.current.children[0];
        emitPositionChanged();
      }
    } else if (e.key === 'Home') {
      e.preventDefault();
      t.current = t.root;
      emitPositionChanged();
    } else if (e.key === 'End') {
      e.preventDefault();
      while (t.current.children.length) t.current = t.current.children[0];
      emitPositionChanged();
    } else if (e.key === 'f' || e.key === 'F') {
      flipBoard();
    } else if (e.key === ' ') {
      if (tag === 'BUTTON' || tag === 'A') return;
      e.preventDefault();
      toggleBothEngines();
    }
  });
}

const debouncedPositionLookups = debounce(() => {
  refreshReferenceExplorer();
  refreshPlayerScout();
  if (state.activeHub === 'scouted') renderScoutedGamesTable();
  triggerLc0Analysis();
  triggerSfAnalysis();
}, 250);

// Subscribe all views to position changes
onPositionChange(() => {
  renderBoardTabs();
  renderBoard();
  renderVariationTree();
  renderGameReviewPanel();
  if (state.activeHub === 'repertoire') renderStudioRepertoirePanel();
  stopLocalSf();
  debouncedPositionLookups();
});

/** Open the analysis encoded in the URL hash, if any, in a new tab. */
function openSharedFromHash() {
  const shared = decodeShareHash(window.location.hash);
  if (!shared) {
    if (window.location.hash.startsWith('#a=')) {
      showToast('This share link is invalid or too large to open.', true);
    }
    return false;
  }
  state.flipped = shared.flipped;
  addPrebuiltBoardTab({
    title: shared.title,
    root: shared.root,
    current: shared.current,
  });
  showToast(`Loaded shared analysis: ${shared.title}`);
  return true;
}

async function bootstrap() {
  mountModals();
  setLc0SettingsHandler(() => openModal('settingsModal'));
  updateTokenDot();
  initBoardInteractions();
  bindEvents();
  renderTournamentRoundsTable();

  await reloadCollections();
  await initStudioRepertoire();
  bindStudioRepertoireSync();

  onCloudSyncState((snap) => {
    renderCloudSyncUI(snap);
    renderSyncedScoutTargets();
  });
  onCloudDataPulled(async (changes) => {
    if (changes.repertoireUpdated || changes.progressUpdated) {
      await initStudioRepertoire();
      refreshPlayerScout();
    }
    if (changes.scoutTargetsUpdated) {
      renderSyncedScoutTargets();
    }
  });
  initCloudSync().then((snap) => {
    if (snap?.error) showToast(snap.error, true);
  });

  if (!openSharedFromHash()) {
    addBoardTab('Analysis 1');
  }
  window.addEventListener('hashchange', () => {
    openSharedFromHash();
  });

  initLc0();
  initStockfish();
  discoverAndSyncLiveBroadcasts();
  startLivePollTimer();
}

bootstrap();
