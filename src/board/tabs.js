import {
  state,
  getActiveTab,
  escapeHtml,
  showToast,
  emitPositionChanged,
} from '../state.js';
import { createTreeFromPgn, findNodeById } from '../chess/tree.js';

export function renderBoardTabs() {
  const bar = document.getElementById('boardTabsBar');
  if (!bar) return;

  bar.innerHTML = state.tabs
    .map((t) => {
      const active = t.id === state.activeTabId;
      const liveBadge = t.liveMeta
        ? `<span class="w-1.5 h-1.5 rounded-full bg-ro live-dot shrink-0"></span>`
        : '';
      return `
        <div role="tab" aria-selected="${active}" data-tid="${t.id}" class="board-tab flex items-center gap-1.5 px-2.5 py-1 rounded-t text-[11px] cursor-pointer max-w-[175px] ${
          active
            ? 'bg-panel text-txt font-semibold border-t border-x border-borderSubtle'
            : 'text-txtMuted hover:text-txt hover:bg-surface/60'
        }">
          ${liveBadge}
          <span class="truncate">${escapeHtml(t.title)}</span>
          ${
            state.tabs.length > 1
              ? `<button data-close="${t.id}" aria-label="Close tab" class="tab-close opacity-60 hover:opacity-100 hover:text-ro text-[10px]">✕</button>`
              : ''
          }
        </div>
      `;
    })
    .join('');

  bar.querySelectorAll('.board-tab').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('.tab-close')) return;
      state.activeTabId = el.dataset.tid;
      state.selectedSq = null;
      state.legalTargets = [];
      emitPositionChanged();
    };
  });

  bar.querySelectorAll('.tab-close').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      closeBoardTab(btn.dataset.close);
    };
  });

  const tab = getActiveTab();
  const followBtn = document.getElementById('btnLiveFollow');
  if (followBtn) {
    if (tab && tab.liveMeta) {
      followBtn.classList.remove('hidden');
      followBtn.classList.add('inline-flex');
      followBtn.classList.toggle('opacity-50', !tab.autoFollow);
    } else {
      followBtn.classList.add('hidden');
      followBtn.classList.remove('inline-flex');
    }
  }
}

export function addBoardTab(title, pgnOrFen = '', metaOverride = null, opts = {}) {
  const { root, current, meta, invalidFen } = createTreeFromPgn(pgnOrFen);
  if (invalidFen) {
    showToast('Invalid FEN in PGN', true);
    return null;
  }
  const id = 'tab_' + Date.now() + '_' + Math.floor(Math.random() * 999);
  const finalMeta = metaOverride
    ? { ...metaOverride, eco: metaOverride.eco || meta?.eco || '', opening: metaOverride.opening || meta?.opening || '' }
    : meta;
  const finalTitle =
    title ||
    (finalMeta
      ? `${finalMeta.white.split(',')[0]} - ${finalMeta.black.split(',')[0]}`
      : `Analysis ${state.tabs.length + 1}`);

  let startNode = opts.jumpEnd ? current : root;
  if (!opts.jumpEnd && pgnOrFen && root.children.length) {
    let c = root;
    for (let i = 0; i < 6 && c.children.length; i++) c = c.children[0];
    startNode = c;
  }

  const tab = {
    id,
    title: finalTitle,
    root,
    current: startNode,
    meta: finalMeta,
    liveMeta: opts.liveMeta || null,
    autoFollow: !!opts.liveMeta,
  };
  state.tabs.push(tab);
  state.activeTabId = id;
  state.selectedSq = null;
  state.legalTargets = [];
  emitPositionChanged();
  return tab;
}

export function addPrebuiltBoardTab({ title, root, current, meta = null }) {
  const id = 'tab_' + Date.now() + '_' + Math.floor(Math.random() * 999);
  const tab = {
    id,
    title: title || `Analysis ${state.tabs.length + 1}`,
    root,
    current: current || root,
    meta,
    liveMeta: null,
    autoFollow: false,
  };
  state.tabs.push(tab);
  state.activeTabId = id;
  state.selectedSq = null;
  state.legalTargets = [];
  emitPositionChanged();
  return tab;
}

export function closeBoardTab(tid) {
  if (state.tabs.length <= 1) return;
  const idx = state.tabs.findIndex((t) => t.id === tid);
  if (idx < 0) return;
  state.tabs.splice(idx, 1);
  if (state.activeTabId === tid) {
    state.activeTabId = state.tabs[Math.max(0, idx - 1)].id;
  }
  emitPositionChanged();
}

export function renderVariationTree() {
  const tab = getActiveTab();
  const box = document.getElementById('variationTreeContainer');
  if (!tab || !box) return;

  if (!tab.root.children.length) {
    box.innerHTML = `<span class="text-txtMuted italic">Play moves on the board, click a live game, or pick a move from the explorer...</span>`;
    return;
  }

  const renderNode = (n, showNum) => {
    const active = n.id === tab.current.id;
    const num = n.color === 'w' ? `${n.moveNum}.` : showNum ? `${n.moveNum}...` : '';
    const nags = n.nags.length
      ? n.nags
          .map((g) => {
            const cls =
              g === '??'
                ? 'text-ro'
                : g === '?'
                  ? 'text-am'
                  : g === '!!' || g === '!'
                    ? 'text-em'
                    : 'text-cy';
            return `<span class="${cls} font-bold">${escapeHtml(g)}</span>`;
          })
          .join('')
      : '';
    const cmt = n.comment
      ? ` <span class="text-em font-sans italic text-[11px] bg-em/10 px-1 rounded">${escapeHtml(n.comment)}</span>`
      : '';
    return `<span class="tree-move ${active ? 'active' : ''}" data-nid="${n.id}">${
      num ? `<span class="opacity-60">${num}</span>` : ''
    }${escapeHtml(n.san)}${nags}</span>${cmt}`;
  };

  const renderLine = (p, forceNum) => {
    if (!p.children.length) return '';
    const main = p.children[0];
    let html = renderNode(main, forceNum || p === tab.root);
    for (let i = 1; i < p.children.length; i++) {
      const v = p.children[i];
      html += ` <span class="tree-var">(${renderNode(v, true)}${
        v.children.length ? ' ' + renderLine(v, false) : ''
      })</span>`;
    }
    if (main.children.length) html += ' ' + renderLine(main, p.children.length > 1);
    return html;
  };

  box.innerHTML = renderLine(tab.root, true);
  box.querySelectorAll('.tree-move').forEach((el) => {
    el.onclick = () => {
      const f = findNodeById(tab.root, el.dataset.nid);
      if (f) {
        tab.current = f;
        state.selectedSq = null;
        state.legalTargets = [];
        emitPositionChanged();
      }
    };
  });

  const act = box.querySelector('.tree-move.active');
  if (act) act.scrollIntoView({ block: 'nearest' });
}

export function promoteVar() {
  const t = getActiveTab();
  if (!t) return;
  let n = t.current;
  while (n && n.parent) {
    const idx = n.parent.children.indexOf(n);
    if (idx > 0) {
      n.parent.children.splice(idx, 1);
      n.parent.children.unshift(n);
      renderVariationTree();
      showToast('Promoted variation');
      return;
    }
    n = n.parent;
  }
}

export function deleteVar() {
  const t = getActiveTab();
  if (!t || t.current === t.root) return;
  const p = t.current.parent;
  p.children = p.children.filter((c) => c.id !== t.current.id);
  t.current = p;
  emitPositionChanged();
}
