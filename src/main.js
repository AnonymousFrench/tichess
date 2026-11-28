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
  setSfOptions,
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
  initHumanfish,
  setEngineTab,
  triggerHumanfishAnalysis,
  stopHumanfish,
  setHumanfishUseClocks,
  toggleHumanfishArrows,
  toggleHumanfishWhatIf,
  setHumanfishServerUrl,
  updateHumanfishServerBadge,
  setHumanfishSettingsHandler,
} from './engines/humanfish.js';
import { HUMANFISH_ENABLED } from './engines/humanfishFlag.js';
import {
  triggerMaia2Analysis,
  stopMaia2,
  toggleMaiaArrows,
} from './engines/maia2.js';
import {
  startActiveTabReview,
  cancelGameReview,
  renderGameReviewPanel,
} from './engines/gameReview.js';
import {
  discoverAndSyncLiveBroadcasts,
  renderLiveHub,
  loadCustomBroadcastFromInput,
  onLiveSearchInput,
  openLiveFromHeader,
  refreshLiveNow,
  startLivePollTimer,
} from './live/liveEvents.js';
import { refreshReferenceExplorer, renderMasterGamesTable } from './explorer/explorer.js';
import { countMyGames, invalidateMyGamesCache } from './explorer/mineSource.js';
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
  syncRepertoireBoardArrows,
} from './repertoire/studioPanel.js';
import {
  initCloudSync,
  getCloudSyncState,
  onCloudSyncState,
  onCloudDataPulled,
  getLoginUrl,
  syncNow,
  signInWithLichessToken,
  signOutCloudSync,
} from './sync/cloudSync.js';
import { mountModals } from './ui/modals.js';
import { mountAppNav } from './shared/appNav.js';
import { mountAccount } from './shared/account.js';
import { registerPwa } from './shared/pwa.js';
import {
  initLayout,
  applyDockLayout,
  applyPreset,
  resetLayout,
  setBoardTheme,
  nudgeBoard,
  fitBoardToScreen,
  layout,
  PRESETS,
  BOARD_THEMES,
} from './ui/layout.js';

function persistPanels() {
  try {
    localStorage.setItem('tichess_panels_v1', JSON.stringify(state.panels));
  } catch (_) {}
}

function applyPanelLayout() {
  applyDockLayout();
  persistPanels();
}

function renderLayoutMenus() {
  const presetsEl = document.getElementById('layoutPresetItems');
  if (presetsEl) {
    presetsEl.innerHTML = Object.entries(PRESETS)
      .map(
        ([id, p]) =>
          `<button class="menu-item" data-preset="${id}"><span>${p.label}</span><span class="text-[10px] text-txtMuted">${p.hint}</span></button>`
      )
      .join('');
    presetsEl.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        applyPreset(btn.dataset.preset);
        applyPanelLayout();
        document.querySelectorAll('.menu-dropdown').forEach((d) => d.classList.add('hidden'));
        showToast(`${PRESETS[btn.dataset.preset].label} layout`);
      };
    });
  }
  const themesEl = document.getElementById('boardThemeItems');
  if (themesEl) {
    const paint = () =>
      themesEl.querySelectorAll('[data-theme]').forEach((b) => b.classList.toggle('is-active', b.dataset.theme === layout.boardTheme));
    themesEl.innerHTML = Object.entries(BOARD_THEMES)
      .map(
        ([id, t]) =>
          `<button class="menu-swatch" data-theme="${id}" title="${t.label}" aria-label="${t.label} board"><i style="background:${t.light}"></i><i style="background:${t.dark}"></i></button>`
      )
      .join('');
    themesEl.querySelectorAll('[data-theme]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        setBoardTheme(btn.dataset.theme);
        paint();
      };
    });
    paint();
  }
}

/** Start the current board over from the initial position (menu item and the `n` key). */
function resetCurrentBoard() {
  const t = getActiveTab();
  cancelGameReview();
  if (t.meta || t.liveMeta) t.title = `Analysis ${state.tabs.indexOf(t) + 1}`;
  t.root = createNode({ fen: START_FEN });
  t.current = t.root;
  t.review = null;
  t.meta = null;
  t.liveMeta = null;
  t.autoFollow = false;
  state.selectedSq = null;
  state.legalTargets = [];
  emitPositionChanged();
  showToast('New board');
}

function switchHub(hubName) {
  if (!state.panels.hub) {
    state.panels.hub = true;
    applyPanelLayout();
  }
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
  if (hubName === 'live') renderLiveHub();
  else document.getElementById('livePollBar').classList.add('hidden');
  if (hubName === 'masters') renderMasterGamesTable();
  if (hubName === 'scouted') renderScoutedGamesTable();
  if (hubName === 'repertoire') renderStudioRepertoirePanel();
  syncRepertoireBoardArrows();
}

function openModal(id) {
  document.querySelectorAll('.menu-dropdown').forEach((d) => d.classList.add('hidden'));
  if (id === 'settingsModal') {
    document.getElementById('inputLichessToken').value = state.lichessToken;
    document.getElementById('inputLc0WsUrl').value = state.lc0.wsUrl;
    document.getElementById('inputSfWsUrl').value = state.sf.wsUrl;
    const hfInput = document.getElementById('inputHfServerUrl');
    if (hfInput) hfInput.value = state.hf.serverUrl;
    updateBridgeStatusBadge();
    updateHumanfishServerBadge();
    renderCloudSyncUI(getCloudSyncState());
  }
  if (id === 'scoutModal') {
    renderSyncedScoutTargets();
  }
  document.getElementById(id).classList.remove('hidden');
}

function renderCloudSyncUI(snap) {
  const badge = document.getElementById('settingsSyncStatusBadge');
  const desc = document.getElementById('settingsSyncDesc');
  const btnSignIn = document.getElementById('btnSettingsSignIn');
  const btnSyncNow = document.getElementById('btnSettingsSyncNow');
  const btnSignOut = document.getElementById('btnSettingsSignOut');

  if (snap.authenticated && snap.user) {
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
        : `Signed in as ${snap.user.username} on every tichess page. Your repertoire, drill progress and scouted players sync across your devices.`;
    }
    if (btnSignIn) btnSignIn.classList.add('hidden');
    if (btnSyncNow) btnSyncNow.classList.remove('hidden');
    if (btnSignOut) btnSignOut.classList.remove('hidden');
  } else if (snap.configured) {
    if (badge) {
      badge.textContent = 'Ready';
      badge.className = 'font-mono text-[10px] px-1.5 py-0.5 rounded bg-panel text-cy';
    }
    if (desc) {
      desc.textContent =
        snap.error ||
        'One sign-in for the whole site (no permissions requested): your games in Insights, your explorer here in the Studio, and your repertoire and drill progress on every device.';
    }
    if (btnSignIn) {
      btnSignIn.classList.remove('hidden');
      btnSignIn.disabled = false;
    }
    if (btnSyncNow) btnSyncNow.classList.add('hidden');
    if (btnSignOut) btnSignOut.classList.add('hidden');
  } else {
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
  if (state.engineTab === 'hf') {
    state.hf.running = !state.hf.running;
    document.getElementById('btnSfToggle').textContent = state.hf.running ? '⏸' : '▶';
    triggerHumanfishAnalysis();
    return;
  }
  if (state.engineTab === 'maia') {
    state.maia.running = !state.maia.running;
    document.getElementById('btnSfToggle').textContent = state.maia.running ? '⏸' : '▶';
    triggerMaia2Analysis();
    return;
  }
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
  triggerSfAnalysis();
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.menu-dropdown').forEach((d) => d.classList.add('hidden'));
  });

  const copyShareLink = () => {
    const tab = getActiveTab();
    if (!tab) return;
    const hash = encodeShareHash(tab, { flipped: state.flipped });
    if (!hash) return;
    const url = `${window.location.origin}${window.location.pathname}${hash}`;
    copyText(url, 'Shareable link copied');
  };

  // Settings menu
  document.getElementById('actLoadModal').onclick = () => openModal('loadModal');
  document.getElementById('actImportPgnMenu').onclick = () => document.getElementById('globalPgnInput').click();
  document.getElementById('actExportPgn').onclick = () => copyText(exportTreeToPgn(getActiveTab()), 'PGN copied');
  document.getElementById('actResetTab').onclick = resetCurrentBoard;
  document.getElementById('actToggleCoords').onclick = (e) => {
    e.stopPropagation();
    state.showCoords = !state.showCoords;
    document.getElementById('chkCoords').textContent = state.showCoords ? '✓' : '';
    renderBoard();
  };
  document.getElementById('actToggleArrows').onclick = (e) => {
    e.stopPropagation();
    state.showEngineArrows = !state.showEngineArrows;
    document.getElementById('chkArrows').textContent = state.showEngineArrows ? '✓' : '';
    renderArrows();
  };
  document.getElementById('actToggleEvalBar').onclick = (e) => {
    e.stopPropagation();
    state.showEvalBar = !state.showEvalBar;
    document.getElementById('evalBarContainer').classList.toggle('hidden', !state.showEvalBar);
    document.getElementById('chkEvalBar').textContent = state.showEvalBar ? '✓' : '';
  };
  document.getElementById('actOpenSettings').onclick = () => openModal('settingsModal');
  document.getElementById('btnSettingsSignIn').onclick = () => {
    const snap = getCloudSyncState();
    if (!snap.configured) {
      showToast('Connect Neon Postgres in Vercel Storage to enable cloud sync', true);
      return;
    }
    window.location.href = getLoginUrl();
  };
  document.getElementById('btnSettingsSyncNow').onclick = async () => {
    const r = await syncNow();
    showToast(r.ok ? 'Cloud sync up to date' : r.error || 'Sync failed', !r.ok);
  };
  document.getElementById('btnSettingsSignOut').onclick = async () => {
    await signOutCloudSync();
    showToast('Signed out (local data kept in this browser)');
  };

  // Live quick jump: opens the live events list (or the event you are following)
  document.getElementById('btnLiveQuickJump').onclick = () => {
    switchHub('live');
    openLiveFromHeader();
  };
  document.getElementById('globalPgnInput').onchange = (e) => {
    if (e.target.files?.[0]) {
      handlePgnFileImport(e.target.files[0]);
      e.target.value = '';
    }
  };

  // Board & Navigation
  document.getElementById('btnAddBoardTab').onclick = () => addBoardTab(`Analysis ${state.tabs.length + 1}`);
  document.getElementById('evalBarContainer').onclick = () => {
    const sources = HUMANFISH_ENABLED ? ['maia', 'sf', 'hf'] : ['maia', 'sf'];
    if (state.lc0.mode === 'ws') sources.push('lc0');
    const idx = sources.indexOf(state.evalBarSource);
    const next = sources[(idx + 1) % sources.length];
    state.evalBarSource = next;
    if (next === 'maia' && !state.maia.enabled) {
      state.maia.enabled = true;
      triggerMaia2Analysis();
      showToast(`Eval Bar: Maia 2 (${state.maia.eloWhite} Elo)`);
    } else if (next === 'hf' && !state.hf.enabled) {
      state.hf.enabled = true;
      triggerHumanfishAnalysis();
      showToast('Eval Bar: HumanFish W/D/L');
    } else {
      showToast(
        next === 'maia'
          ? `Eval Bar: Maia 2 (${state.maia.eloWhite} Elo)`
          : next === 'hf'
            ? 'Eval Bar: HumanFish W/D/L'
            : next === 'lc0'
              ? 'Eval Bar: Lc0'
              : 'Eval Bar: Stockfish'
      );
    }
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
  document.getElementById('btnSyncLiveNow').onclick = refreshLiveNow;
  document.getElementById('chkLiveAutoPoll').onchange = (e) => {
    state.liveAutoPoll = e.target.checked;
  };
  document.getElementById('customBroadcastInput').oninput = onLiveSearchInput;
  document.getElementById('liveSearchForm').onsubmit = (e) => {
    e.preventDefault();
    loadCustomBroadcastFromInput();
  };

  // Workspace Panels Configurator (close X buttons & Panels menu)
  const resetPanels = () => {
    resetLayout();
    applyPanelLayout();
    showToast('Workspace layout reset');
  };
  document.querySelectorAll('.panel-close-btn').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const key = btn.dataset.panelClose;
      if (!key || !(key in state.panels)) return;
      state.panels[key] = false;
      applyPanelLayout();
      showToast('Panel hidden — restore anytime via ⊞ Panels');
    };
  });
  document.querySelectorAll('.panel-toggle-item').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const key = btn.dataset.panel;
      if (!key || !(key in state.panels)) return;
      state.panels[key] = !state.panels[key];
      applyPanelLayout();
    };
  });
  const actResetPanels = document.getElementById('actResetPanels');
  if (actResetPanels) actResetPanels.onclick = resetPanels;
  const btnEmptyResetPanels = document.getElementById('btnEmptyResetPanels');
  if (btnEmptyResetPanels) btnEmptyResetPanels.onclick = resetPanels;
  const largerBoard = () => {
    if (!nudgeBoard(48)) {
      showToast('The board is as big as the screen allows. Hide or move the panel under it to go bigger.');
    }
  };
  // Size buttons keep the menu open so you can click a few times and watch the board.
  const keepOpen = (fn) => (e) => {
    e.stopPropagation();
    fn();
  };
  document.getElementById('actBoardLarger').onclick = keepOpen(largerBoard);
  document.getElementById('actBoardSmaller').onclick = keepOpen(() => nudgeBoard(-48));
  document.getElementById('actBoardFit').onclick = keepOpen(fitBoardToScreen);
  document.getElementById('actShortcuts').onclick = () => openModal('shortcutsModal');
  const sfLines = document.getElementById('sfLinesSelect');
  const sfDepth = document.getElementById('sfDepthSelect');
  sfLines.value = String(state.sf.multiPv);
  sfDepth.value = String(state.sf.depth);
  if (sfDepth.value !== String(state.sf.depth)) sfDepth.value = '18';
  sfLines.onchange = () => setSfOptions({ multiPv: Number(sfLines.value) });
  sfDepth.onchange = () => setSfOptions({ depth: Number(sfDepth.value) });

  // Explorers
  const setRefSource = (src) => {
    state.refSource = src;
    const base = 'px-2 py-0.5 rounded text-[11px] font-semibold whitespace-nowrap shrink-0';
    const inactive = `${base} text-txtMuted hover:text-txt`;
    const mBtn = document.getElementById('refSrcMasters');
    const lBtn = document.getElementById('refSrcLichess');
    const pBtn = document.getElementById('refSrcPlayer');
    const meBtn = document.getElementById('refSrcMine');
    const personal = src === 'player' || src === 'mine';
    const pColWrap = document.getElementById('refPlayerColorWrap');
    const pFilterBar = document.getElementById('refPlayerFilterBar');
    if (mBtn) mBtn.className = src === 'masters' ? `${base} bg-em/20 text-em border border-em/35` : inactive;
    if (lBtn) lBtn.className = src === 'lichess' ? `${base} bg-cy/20 text-cy border border-cy/35` : inactive;
    if (pBtn) {
      const hidden = pBtn.classList.contains('hidden');
      pBtn.className = `${hidden ? 'hidden ' : ''}${src === 'player' ? `${base} bg-vi/20 text-vi border border-vi/35` : inactive}`;
    }
    if (meBtn) {
      const hidden = meBtn.classList.contains('hidden');
      meBtn.className = `${hidden ? 'hidden ' : ''}${src === 'mine' ? `${base} bg-am/15 text-am border border-am/35` : inactive}`;
    }
    if (pColWrap) {
      pColWrap.classList.toggle('hidden', !personal);
      pColWrap.classList.toggle('flex', personal);
    }
    if (pFilterBar) {
      pFilterBar.classList.toggle('hidden', !personal);
      pFilterBar.classList.toggle('flex', personal);
    }
    document.getElementById('refPlayerMax')?.classList.remove('hidden');
    refreshReferenceExplorer();
  };
  document.getElementById('refSrcMasters').onclick = () => setRefSource('masters');
  document.getElementById('refSrcLichess').onclick = () => setRefSource('lichess');
  document.getElementById('refSrcPlayer').onclick = () => setRefSource('player');
  document.getElementById('refSrcMine').onclick = () => setRefSource('mine');
  const refreshMineTabVisibility = () => {
    countMyGames().then((n) => {
      const btn = document.getElementById('refSrcMine');
      if (!btn) return;
      const signedIn = Boolean(getCloudSyncState().authenticated);
      // When signed in, "My Games" already reads directly from the Neon/IndexedDB database,
      // so hide the duplicate "Mine" button to keep the Explorer header clean.
      btn.classList.toggle('hidden', signedIn || !n);
      if (n) {
        btn.title = `Your ${n.toLocaleString('en-US')} games downloaded in Insights (all accounts, works offline)`;
      }
    });
  };
  refreshMineTabVisibility();
  window.addEventListener('tichess:insights-updated', () => {
    invalidateMyGamesCache();
    refreshMineTabVisibility();
    if (state.refSource === 'player' || state.refSource === 'mine') {
      refreshReferenceExplorer();
    }
  });
  document.querySelectorAll('.ref-pcol-btn').forEach((b) => {
    b.onclick = () => {
      state.refPlayerColor = b.dataset.pcol === 'black' ? 'black' : 'white';
      document.querySelectorAll('.ref-pcol-btn').forEach(
        (x) =>
          (x.className =
            x === b
              ? 'ref-pcol-btn px-1.5 rounded bg-vi/25 text-vi font-bold'
              : 'ref-pcol-btn px-1.5 rounded text-txtMuted hover:text-txt')
      );
      if (state.refSource === 'player' || state.refSource === 'mine') refreshReferenceExplorer();
    };
  });
  const refSinceSel = document.getElementById('refPlayerSince');
  if (refSinceSel) {
    refSinceSel.value = state.refPlayerSince || '3m';
    refSinceSel.onchange = (e) => {
      state.refPlayerSince = e.target.value;
      if (state.refSource === 'player' || state.refSource === 'mine') refreshReferenceExplorer();
    };
  }
  const refMaxSel = document.getElementById('refPlayerMax');
  if (refMaxSel) {
    refMaxSel.value = state.refPlayerMax || '200';
    refMaxSel.onchange = (e) => {
      state.refPlayerMax = e.target.value;
      if (state.refSource === 'player' || state.refSource === 'mine') refreshReferenceExplorer();
    };
  }
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
    if (state.engineTab === 'hf') {
      state.hf.running = !state.hf.running;
      document.getElementById('btnSfToggle').textContent = state.hf.running ? '⏸' : '▶';
      triggerHumanfishAnalysis();
      return;
    }
    if (state.engineTab === 'maia') {
      state.maia.running = !state.maia.running;
      document.getElementById('btnSfToggle').textContent = state.maia.running ? '⏸' : '▶';
      triggerMaia2Analysis();
      return;
    }
    state.sf.running = !state.sf.running;
    document.getElementById('btnSfToggle').textContent = state.sf.running ? '⏸' : '▶';
    triggerSfAnalysis();
  };
  document.getElementById('btnEngineTabSf').onclick = () => setEngineTab('sf');
  document.getElementById('btnEngineTabMaia').onclick = () => setEngineTab('maia');
  document.getElementById('btnEngineTabHf').onclick = () => setEngineTab('hf');
  if (!HUMANFISH_ENABLED) document.getElementById('btnEngineTabHf')?.classList.add('hidden');
  document.getElementById('sfMaiaSummaryChip').onclick = () => setEngineTab('maia');
  document.getElementById('sfHfSummaryChip').onclick = () => setEngineTab('hf');
  document.getElementById('btnMaiaArrows').onclick = toggleMaiaArrows;
  document.getElementById('btnHfClockMode').onclick = () => setHumanfishUseClocks(!state.hf.useClocks);
  document.getElementById('btnHfArrows').onclick = toggleHumanfishArrows;
  document.getElementById('btnHfWhatIf').onclick = toggleHumanfishWhatIf;
  document.getElementById('btnHfRefresh').onclick = () => triggerHumanfishAnalysis({ force: true });
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
  document.getElementById('btnSaveToken').onclick = async () => {
    const token = document.getElementById('inputLichessToken').value.trim();
    state.lichessToken = token;
    localStorage.setItem('cms_lichess_token', state.lichessToken);
    refreshReferenceExplorer();
    if (!token) {
      showToast('Lichess token saved');
      return;
    }
    const cloud = getCloudSyncState();
    if (!cloud.configured) {
      showToast('Lichess token saved');
      return;
    }
    showToast('Verifying Lichess token…');
    const res = await signInWithLichessToken(token);
    if (res.ok) {
      showToast(`Signed in as ${res.user?.username || 'Lichess'} — syncing games in background`);
      refreshReferenceExplorer();
    } else if (res.status === 401 || res.status === 403) {
      showToast(res.error || 'Lichess rejected that token', true);
    } else {
      showToast('Lichess token saved locally');
    }
  };
  document.getElementById('btnClearToken').onclick = () => {
    state.lichessToken = '';
    localStorage.removeItem('cms_lichess_token');
    document.getElementById('inputLichessToken').value = '';
      showToast('Token cleared');
    refreshReferenceExplorer();
  };
  document.getElementById('btnConnectLc0Ws').onclick = () => {
    if (!state.panels.lc0) {
      state.panels.lc0 = true;
      applyPanelLayout();
    }
    connectLc0Ws(document.getElementById('inputLc0WsUrl').value.trim());
  };
  document.getElementById('btnDisconnectLc0Ws').onclick = disconnectLc0Ws;
  document.getElementById('btnConnectSfWs').onclick = () =>
    connectSfWs(document.getElementById('inputSfWsUrl').value.trim());
  document.getElementById('btnDisconnectSfWs').onclick = disconnectSfWs;
  document.getElementById('btnSaveHfServerUrl').onclick = () => {
    const val = document.getElementById('inputHfServerUrl')?.value.trim() || '';
    if (val && !/^https?:\/\//i.test(val)) {
      showToast('HumanFish URL must start with http:// or https://', true);
      return;
    }
    setHumanfishServerUrl(val);
    showToast(val ? `HumanFish server set to ${val}` : 'Using built-in HumanFish proxy');
  };
  document.getElementById('btnResetHfServerUrl').onclick = () => {
    const inp = document.getElementById('inputHfServerUrl');
    if (inp) inp.value = '';
    setHumanfishServerUrl('');
    showToast('Reset to built-in HumanFish proxy');
  };
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
    } else if ((e.key === 'n' || e.key === 'N') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      resetCurrentBoard();
    } else if (e.key === ']') {
      largerBoard();
    } else if (e.key === '[') {
      nudgeBoard(-48);
    } else if (e.key === '=') {
      fitBoardToScreen();
    } else if (e.key === '?') {
      openModal('shortcutsModal');
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
  triggerMaia2Analysis();
  triggerHumanfishAnalysis();
}, 250);

// Subscribe all views to position changes
onPositionChange(() => {
  renderBoardTabs();
  renderBoard();
  renderVariationTree();
  renderGameReviewPanel();
  if (state.activeHub === 'repertoire') renderStudioRepertoirePanel();
  syncRepertoireBoardArrows();
  stopLocalSf();
  stopMaia2();
  stopHumanfish();
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

const MOBILE_PIN_KEY = 'tichess_mobile_pin_board_v1';

function applyMobileBoardPin(pinned) {
  document.body.classList.toggle('mobile-board-pinned', pinned);
  const btn = document.getElementById('btnPinBoard');
  const label = document.getElementById('btnPinBoardLabel');
  if (btn) {
    btn.setAttribute('aria-pressed', String(pinned));
    btn.title = pinned
      ? 'Board fixed at top while scrolling — tap to unpin'
      : 'Fix board at top while scrolling tools';
    btn.classList.toggle('bg-em/15', pinned);
    btn.classList.toggle('text-em', pinned);
    btn.classList.toggle('border-em/40', pinned);
    btn.classList.toggle('bg-surface', !pinned);
    btn.classList.toggle('text-txtMuted', !pinned);
    btn.classList.toggle('border-borderSubtle', !pinned);
  }
  if (label) label.textContent = pinned ? 'Pinned' : 'Pin';
}

function initMobileBoardPin() {
  let pinned = true;
  try {
    const saved = localStorage.getItem(MOBILE_PIN_KEY);
    if (saved === '0' || saved === 'false') pinned = false;
  } catch (_) {}
  applyMobileBoardPin(pinned);
  const btn = document.getElementById('btnPinBoard');
  if (btn) {
    btn.onclick = () => {
      pinned = !pinned;
      applyMobileBoardPin(pinned);
      try {
        localStorage.setItem(MOBILE_PIN_KEY, pinned ? '1' : '0');
      } catch (_) {}
    };
  }
}

function syncMobileToolTabs() {
  document.querySelectorAll('#mobileToolTabs [data-tool-jump]').forEach((btn) => {
    const key = btn.dataset.toolJump;
    const panel = document.getElementById(`panel-${key}`);
    const visible = Boolean(panel && !panel.classList.contains('hidden'));
    btn.classList.toggle('hidden', !visible);
  });
}

function setActiveMobileToolTab(key) {
  document.querySelectorAll('#mobileToolTabs [data-tool-jump]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.toolJump === key);
  });
}

function initMobileToolTabs() {
  const nav = document.getElementById('mobileToolTabs');
  if (!nav) return;
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tool-jump]');
    if (!btn) return;
    const key = btn.dataset.toolJump;
    const panel = document.getElementById(`panel-${key}`);
    if (!panel) return;
    setActiveMobileToolTab(key);
    const boardPanel = document.getElementById('boardPanel');
    const pinned = document.body.classList.contains('mobile-board-pinned');
    const offset = pinned && boardPanel ? boardPanel.getBoundingClientRect().height + 6 : 6;
    const targetTop = panel.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: Math.max(0, Math.round(targetTop)), behavior: 'smooth' });
  });
  let scrollTick = 0;
  window.addEventListener(
    'scroll',
    () => {
      if (window.innerWidth >= 1024 || scrollTick) return;
      scrollTick = requestAnimationFrame(() => {
        scrollTick = 0;
        const boardPanel = document.getElementById('boardPanel');
        const pinned = document.body.classList.contains('mobile-board-pinned');
        const anchor = (pinned && boardPanel ? boardPanel.getBoundingClientRect().bottom : 48) + 24;
        let bestKey = null;
        let bestDist = Infinity;
        document.querySelectorAll('#mobileToolTabs [data-tool-jump]:not(.hidden)').forEach((btn) => {
          const panel = document.getElementById(`panel-${btn.dataset.toolJump}`);
          if (!panel) return;
          const dist = Math.abs(panel.getBoundingClientRect().top - anchor);
          if (dist < bestDist) {
            bestDist = dist;
            bestKey = btn.dataset.toolJump;
          }
        });
        if (bestKey) setActiveMobileToolTab(bestKey);
      });
    },
    { passive: true }
  );
  syncMobileToolTabs();
}

async function bootstrap() {
  mountAppNav('studio');
  mountAccount();
  registerPwa();
  mountModals();
  initMobileBoardPin();
  initMobileToolTabs();
  setLc0SettingsHandler(() => openModal('settingsModal'));
  setHumanfishSettingsHandler(() => openModal('settingsModal'));
  initBoardInteractions();
  bindEvents();
  renderLayoutMenus();
  const applyLayoutAndTabs = () => {
    applyPanelLayout();
    syncMobileToolTabs();
  };
  initLayout(applyLayoutAndTabs);
  applyLayoutAndTabs();
  renderLiveHub();

  await reloadCollections();
  await initStudioRepertoire();
  bindStudioRepertoireSync();

  let wasAuthenticated = false;
  onCloudSyncState((snap) => {
    renderCloudSyncUI(snap);
    renderSyncedScoutTargets();
    const pBtn = document.getElementById('refSrcPlayer');
    const meBtn = document.getElementById('refSrcMine');
    const signedIn = Boolean(snap.authenticated && snap.user);
    if (pBtn) {
      pBtn.classList.toggle('hidden', !signedIn);
      if (signedIn) {
        pBtn.title = `Your synced games (${snap.user.username})`;
      } else if (state.refSource === 'player') {
        document.getElementById('refSrcMasters')?.click();
      }
    }
    if (meBtn) {
      if (signedIn) {
        meBtn.classList.add('hidden');
        if (state.refSource === 'mine') {
          document.getElementById('refSrcPlayer')?.click();
        }
      } else {
        countMyGames().then((n) => {
          if (!getCloudSyncState().authenticated) {
            meBtn.classList.toggle('hidden', !n);
          }
        });
      }
    }
    if (snap.authenticated && !wasAuthenticated) {
      wasAuthenticated = true;
      refreshReferenceExplorer();
    } else if (!snap.authenticated) {
      wasAuthenticated = false;
    }
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
  initHumanfish();
  discoverAndSyncLiveBroadcasts();
  startLivePollTimer();
}

bootstrap();
