import { Chess } from 'chess.js';
import {
  state,
  getActiveTab,
  getCurrentFen,
  emitPositionChanged,
} from '../state.js';
import { PIECE_SVG } from '../chess/pieces.js';
import { createNode } from '../chess/tree.js';

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

function sqToCoords(sq) {
  const fi = FILES.indexOf(sq[0]);
  const ri = parseInt(sq[1], 10) - 1;
  return {
    col: state.flipped ? 7 - fi : fi,
    row: state.flipped ? ri : 7 - ri,
  };
}

export function renderBoard() {
  const boardEl = document.getElementById('chessboard');
  const tab = getActiveTab();
  if (!boardEl || !tab) return;

  let chess;
  try {
    chess = new Chess(tab.current.fen);
  } catch (_) {
    return;
  }
  const board = chess.board();
  const last = tab.current.san ? tab.current : null;
  const inCheck = chess.inCheck();
  const turn = chess.turn();

  let html = '';
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const rankIdx = state.flipped ? r : 7 - r;
      const fileIdx = state.flipped ? 7 - c : c;
      const sq = FILES[fileIdx] + (rankIdx + 1);
      const isLight = (rankIdx + fileIdx) % 2 === 1;
      let cls = isLight ? 'light' : 'dark';
      if (last && (last.from === sq || last.to === sq)) {
        cls = isLight ? 'last-light' : 'last-dark';
      }
      if (state.selectedSq === sq) cls += ' selected';
      const uhl = state.userHighlights.get(sq);
      if (uhl) cls += ' ' + uhl;

      const piece = board[7 - rankIdx][fileIdx];
      if (inCheck && piece && piece.type === 'k' && piece.color === turn) {
        cls += ' in-check';
      }

      const marker = state.legalTargets.includes(sq)
        ? piece
          ? '<div class="legal-ring"></div>'
          : '<div class="legal-dot"></div>'
        : '';
      const rCoord =
        state.showCoords && c === 0 ? `<span class="coord-rank">${rankIdx + 1}</span>` : '';
      const fCoord =
        state.showCoords && r === 7 ? `<span class="coord-file">${FILES[fileIdx]}</span>` : '';
      const pHtml = piece
        ? `<div class="piece-svg">${PIECE_SVG[piece.color + piece.type.toUpperCase()]}</div>`
        : '';
      html += `<div class="sq ${cls}" data-sq="${sq}">${rCoord}${fCoord}${marker}${pHtml}</div>`;
    }
  }

  boardEl.innerHTML = html;
  renderArrows();
  renderPlayerClockBars();
}

export function renderPlayerClockBars() {
  const tab = getActiveTab();
  const topBar = document.getElementById('topPlayerBar');
  const botBar = document.getElementById('botPlayerBar');
  if (!topBar || !botBar) return;

  if (!tab || !tab.meta) {
    topBar.classList.add('hidden');
    botBar.classList.add('hidden');
    return;
  }

  topBar.classList.remove('hidden');
  botBar.classList.remove('hidden');

  let wClk = tab.liveClocks?.white || '';
  let bClk = tab.liveClocks?.black || '';
  let cur = tab.current;
  let foundW = false;
  let foundB = false;
  while (cur && cur.parent && (!foundW || !foundB)) {
    if (cur.clk) {
      if (cur.color === 'w' && !foundW) {
        wClk = cur.clk;
        foundW = true;
      }
      if (cur.color === 'b' && !foundB) {
        bClk = cur.clk;
        foundB = true;
      }
    }
    cur = cur.parent;
  }

  const topIsWhite = state.flipped;
  document.getElementById('topPlayerName').textContent = topIsWhite ? tab.meta.white : tab.meta.black;
  const topElo = topIsWhite ? tab.meta.whiteElo : tab.meta.blackElo;
  document.getElementById('topPlayerElo').textContent = topElo ? `(${topElo})` : '';
  document.getElementById('topPlayerClock').textContent = (topIsWhite ? wClk : bClk) || '--:--';
  document.getElementById('topPlayerDot').className = topIsWhite
    ? 'w-2.5 h-2.5 rounded-sm bg-slate-200 border border-slate-400 shrink-0'
    : 'w-2.5 h-2.5 rounded-sm bg-slate-800 border border-slate-500 shrink-0';

  document.getElementById('botPlayerName').textContent = topIsWhite ? tab.meta.black : tab.meta.white;
  const botElo = topIsWhite ? tab.meta.blackElo : tab.meta.whiteElo;
  document.getElementById('botPlayerElo').textContent = botElo ? `(${botElo})` : '';
  document.getElementById('botPlayerClock').textContent = (topIsWhite ? bClk : wClk) || '--:--';
  document.getElementById('botPlayerDot').className = topIsWhite
    ? 'w-2.5 h-2.5 rounded-sm bg-slate-800 border border-slate-500 shrink-0'
    : 'w-2.5 h-2.5 rounded-sm bg-slate-200 border border-slate-400 shrink-0';
}

const PROB_ARROW_COLOR = {
  best: '#16a34a',
  inaccuracy: '#d97706',
  blunder: '#dc2626',
  unknown: '#8b5cf6',
};

export function renderArrows() {
  const svg = document.getElementById('arrowOverlay');
  if (!svg) return;

  const arrows = [];
  const curFen = getCurrentFen();
  let probCandidates = [];
  let hoveredProbUci = null;

  if (state.showEngineArrows) {
    if (
      state.engineTab === 'hf' &&
      state.hf.enabled &&
      state.hf.showArrows &&
      state.hf.result?.fen === curFen
    ) {
      probCandidates = state.hf.result?.explanation?.candidates || [];
      hoveredProbUci = state.hf.hoverCandidateUci;
    } else if (
      state.engineTab === 'maia' &&
      state.maia.enabled &&
      state.maia.showArrows &&
      state.maia.result?.fen === curFen
    ) {
      probCandidates = state.maia.result?.graded?.candidates || [];
      hoveredProbUci = state.maia.hoverCandidateUci;
    }
  }

  if (state.showRepertoireArrows && state.repertoireArrows?.length) {
    let mineSeen = 0;
    state.repertoireArrows.forEach((ra, i) => {
      let color;
      let w;
      if (ra.mine) {
        const isPrimary = !ra.isAlt && mineSeen === 0;
        color = isPrimary ? 'rgba(16, 185, 129, 0.80)' : 'rgba(245, 158, 11, 0.76)';
        w = isPrimary ? 14 : 12;
        mineSeen++;
      } else {
        color = 'rgba(148, 163, 184, 0.56)';
        w = 11;
      }
      arrows.push({ uci: ra.uci, color, id: 'rep' + i, w });
    });
  }
  if (state.showEngineArrows) {
    if (probCandidates.length) {
      const hovered = hoveredProbUci;
      const ordered = [...probCandidates].sort((a, b) => {
        if (a.uci === hovered) return 1;
        if (b.uci === hovered) return -1;
        return (a.prob || 0) - (b.prob || 0);
      });
      ordered.forEach((c, idx) => {
        const prob = Math.max(0, Math.min(1, Number(c.prob) || 0));
        const pct = Math.round(prob * 100);
        if (pct < 3 && !c.is_sf_best && c.uci !== hovered) return;
        const grade = PROB_ARROW_COLOR[c.grade] ? c.grade : 'unknown';
        const color = PROB_ARROW_COLOR[grade];
        const isHov = hovered && c.uci === hovered;
        const dashed = Boolean(c.is_sf_best && prob < 0.2);
        const w = Math.max(7.5, Math.min(19, 6.5 + prob * 24)) + (isHov ? 2.5 : 0);
        const opacity = hovered ? (isHov ? 0.98 : 0.32) : 0.88;
        arrows.push({
          uci: c.uci,
          color,
          id: `pb${idx}`,
          w,
          dashed,
          opacity,
          badgeText: `${pct}%`,
        });
      });
    } else {
      if (state.lc0.mode === 'ws' && state.lc0.running && state.lc0.topArrowUci) {
        arrows.push({ uci: state.lc0.topArrowUci, color: 'rgba(167, 139, 250, 0.80)', id: 'lc0', w: 12 });
      }
      if (state.sf.running && state.sf.topArrowUci) {
        arrows.push({ uci: state.sf.topArrowUci, color: 'rgba(56, 189, 248, 0.78)', id: 'sf', w: 12 });
      }
    }
  }
  if (state.hoverArrowUci) {
    arrows.push({ uci: state.hoverArrowUci, color: 'rgba(16, 185, 129, 0.92)', id: 'hov', w: 15 });
  }
  state.userArrows.forEach((ua, i) =>
    arrows.push({ uci: ua.from + ua.to, color: 'rgba(245, 158, 11, 0.85)', id: 'u' + i, w: 14 })
  );

  if (!arrows.length) {
    svg.innerHTML = '';
    return;
  }

  let defs = '<defs>';
  let lines = '';
  let badges = '';
  for (const a of arrows) {
    if (!a.uci || a.uci.length < 4) continue;
    const f = sqToCoords(a.uci.slice(0, 2));
    const t = sqToCoords(a.uci.slice(2, 4));
    const x1 = f.col * 100 + 50;
    const y1 = f.row * 100 + 50;
    const x2 = t.col * 100 + 50;
    const y2 = t.row * 100 + 50;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1) continue;
    const ux = dx / len;
    const uy = dy / len;
    const sx = a.badgeText ? x1 + ux * 16 : x1;
    const sy = a.badgeText ? y1 + uy * 16 : y1;
    const ex = x2 - ux * (a.badgeText ? 24 : 22);
    const ey = y2 - uy * (a.badgeText ? 24 : 22);
    const dashAttr = a.dashed ? ' stroke-dasharray="14,9"' : '';
    const opAttr = typeof a.opacity === 'number' ? ` opacity="${a.opacity.toFixed(2)}"` : '';
    defs += `<marker id="ah-${a.id}" markerWidth="4" markerHeight="4" refX="2.2" refY="2" orient="auto"><polygon points="0 0, 4 2, 0 4" fill="${a.color}"/></marker>`;
    lines += `<line x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="${a.color}" stroke-width="${a.w.toFixed(1)}" stroke-linecap="round"${dashAttr}${opAttr} marker-end="url(#ah-${a.id})"/>`;
    if (a.badgeText) {
      // Push badges slightly closer to destination on short 1-square moves so they don't pile onto the origin piece
      const tPos = len <= 155 ? 0.72 : 0.56;
      const bx = x1 + dx * tPos;
      const by = y1 + dy * tPos;
      const bw = a.badgeText.length >= 3 ? 52 : 42;
      badges += `<g${opAttr}><rect x="${(bx - bw / 2).toFixed(1)}" y="${(by - 13).toFixed(1)}" width="${bw}" height="24" rx="6" fill="#0f1218" stroke="${a.color}" stroke-width="3" opacity="0.96"/><text x="${bx.toFixed(1)}" y="${(by + 5).toFixed(1)}" text-anchor="middle" font-size="17.5" font-weight="800" font-family="IBM Plex Mono,ui-monospace,monospace" fill="#f8fafc">${a.badgeText}</text></g>`;
    }
  }
  svg.innerHTML = defs + '</defs>' + lines + badges;
}

export function playMoveOnTree(moveInput) {
  const tab = getActiveTab();
  if (!tab) return false;
  let chess;
  try {
    chess = new Chess(tab.current.fen);
  } catch (_) {
    return false;
  }
  let res = null;
  try {
    if (typeof moveInput === 'string') {
      try {
        res = chess.move(moveInput, { strict: false });
      } catch (_) {
        if (moveInput.length >= 4) {
          res = chess.move({
            from: moveInput.slice(0, 2),
            to: moveInput.slice(2, 4),
            promotion: moveInput[4] || 'q',
          });
        }
      }
    } else {
      res = chess.move(moveInput);
    }
  } catch (_) {
    return false;
  }
  if (!res) return false;

  const existing = tab.current.children.find((ch) => ch.san === res.san);
  if (existing) {
    tab.current = existing;
  } else {
    const moveNum = parseInt(tab.current.fen.split(' ')[5] || '1', 10);
    const node = createNode({
      parent: tab.current,
      san: res.san,
      uci: res.from + res.to + (res.promotion || ''),
      from: res.from,
      to: res.to,
      promotion: res.promotion || '',
      fen: chess.fen(),
      color: res.color,
      moveNum,
    });
    tab.current.children.push(node);
    tab.current = node;
  }

  state.selectedSq = null;
  state.legalTargets = [];
  state.hoverArrowUci = null;
  emitPositionChanged();
  return true;
}

export function attemptUserMove(from, to) {
  let chess;
  try {
    chess = new Chess(getCurrentFen());
  } catch (_) {
    return;
  }
  const legal = chess.moves({ square: from, verbose: true }).filter((m) => m.to === to);
  if (!legal.length) {
    state.selectedSq = null;
    state.legalTargets = [];
    renderBoard();
    return;
  }

  if (legal.some((m) => m.promotion)) {
    state.pendingPromotion = { from, to };
    const modal = document.getElementById('promotionModal');
    const box = document.getElementById('promotionChoices');
    box.innerHTML = ['q', 'r', 'b', 'n']
      .map(
        (p) =>
          `<button data-p="${p}" class="w-14 h-14 p-1.5 rounded bg-surface hover:bg-em/20 border border-borderSubtle">${PIECE_SVG[chess.turn() + p.toUpperCase()]}</button>`
      )
      .join('');
    modal.classList.remove('hidden');
    box.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        modal.classList.add('hidden');
        if (state.pendingPromotion) {
          const { from: f, to: t } = state.pendingPromotion;
          state.pendingPromotion = null;
          playMoveOnTree({ from: f, to: t, promotion: b.dataset.p });
        }
      };
    });
    return;
  }

  playMoveOnTree({ from, to });
}

let dragState = null;
let rClickStartSq = null;

export function initBoardInteractions() {
  const boardEl = document.getElementById('chessboard');
  const ghostEl = document.getElementById('dragGhost');
  if (!boardEl || !ghostEl) return;

  boardEl.addEventListener('contextmenu', (e) => e.preventDefault());
  const preventBoardTouchScroll = (e) => {
    if (e.cancelable) e.preventDefault();
  };
  boardEl.addEventListener('touchstart', preventBoardTouchScroll, { passive: false });
  boardEl.addEventListener('touchmove', preventBoardTouchScroll, { passive: false });

  boardEl.addEventListener('pointerdown', (e) => {
    const sqEl = e.target.closest('.sq');
    if (!sqEl) return;
    const sq = sqEl.dataset.sq;
    if (e.button === 2) {
      rClickStartSq = sq;
      return;
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return;

    if (state.userHighlights.size || state.userArrows.length) {
      state.userHighlights.clear();
      state.userArrows = [];
    }

    let chess;
    try {
      chess = new Chess(getCurrentFen());
    } catch (_) {
      return;
    }
    const piece = chess.get(sq);

    if (state.selectedSq && state.legalTargets.includes(sq)) {
      attemptUserMove(state.selectedSq, sq);
      return;
    }

    if (piece && piece.color === chess.turn()) {
      state.selectedSq = sq;
      state.legalTargets = chess.moves({ square: sq, verbose: true }).map((m) => m.to);
      renderBoard();
      const rect = sqEl.getBoundingClientRect();
      dragState = {
        from: sq,
        pieceKey: piece.color + piece.type.toUpperCase(),
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        size: rect.width,
      };
      boardEl.setPointerCapture(e.pointerId);
    } else {
      state.selectedSq = null;
      state.legalTargets = [];
      renderBoard();
    }
  });

  boardEl.addEventListener('pointermove', (e) => {
    if (!dragState) return;
    if (!dragState.moved && Math.hypot(e.clientX - dragState.startX, e.clientY - dragState.startY) > 6) {
      dragState.moved = true;
      ghostEl.innerHTML = PIECE_SVG[dragState.pieceKey];
      ghostEl.style.width = dragState.size + 'px';
      ghostEl.style.height = dragState.size + 'px';
      ghostEl.style.display = 'block';
      const orig = boardEl.querySelector(`.sq[data-sq="${dragState.from}"] .piece-svg`);
      if (orig) orig.style.opacity = '0.25';
    }
    if (dragState.moved) {
      ghostEl.style.left = e.clientX + 'px';
      ghostEl.style.top = e.clientY + 'px';
    }
  });

  const endPtr = (e) => {
    if (e.button === 2 && rClickStartSq) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const endSq = el ? el.closest('.sq')?.dataset.sq : null;
      if (endSq === rClickStartSq) {
        const cur = state.userHighlights.get(endSq);
        if (!cur) state.userHighlights.set(endSq, 'hl-green');
        else if (cur === 'hl-green') state.userHighlights.set(endSq, 'hl-red');
        else if (cur === 'hl-red') state.userHighlights.set(endSq, 'hl-amber');
        else state.userHighlights.delete(endSq);
      } else if (endSq) {
        const idx = state.userArrows.findIndex((a) => a.from === rClickStartSq && a.to === endSq);
        if (idx >= 0) state.userArrows.splice(idx, 1);
        else state.userArrows.push({ from: rClickStartSq, to: endSq });
      }
      rClickStartSq = null;
      renderBoard();
      return;
    }

    if (!dragState) return;
    const moved = dragState.moved;
    const fromSq = dragState.from;
    dragState = null;
    ghostEl.style.display = 'none';
    if (moved) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const toSq = el ? el.closest('.sq')?.dataset.sq : null;
      if (toSq && toSq !== fromSq && state.legalTargets.includes(toSq)) {
        attemptUserMove(fromSq, toSq);
      } else {
        renderBoard();
      }
    }
  };

  boardEl.addEventListener('pointerup', endPtr);
  boardEl.addEventListener('pointercancel', endPtr);
}
