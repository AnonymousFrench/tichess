import { Chess } from 'chess.js';
import { state, escapeHtml } from '../state.js';
import { playMoveOnTree, renderArrows } from '../board/board.js';
import { getActiveHumanOutcome } from './humanfishMath.js';

const CASTLING_KING_ROOK_MAP = {
  w: {
    e1h1: 'e1g1',
    e1a1: 'e1c1',
  },
  b: {
    e8h8: 'e8g8',
    e8a8: 'e8c8',
  },
};

function normalizeCastlingWithChess(chess, uci) {
  if (!uci || uci.length < 4) return uci;
  const key = uci.slice(0, 4);
  const turn = chess.turn();
  const mapped = CASTLING_KING_ROOK_MAP[turn]?.[key];
  if (!mapped) return uci;

  const from = key.slice(0, 2);
  const to = key.slice(2, 4);
  const fromPiece = chess.get(from);
  const toPiece = chess.get(to);
  if (
    fromPiece &&
    fromPiece.type === 'k' &&
    fromPiece.color === turn &&
    toPiece &&
    toPiece.type === 'r' &&
    toPiece.color === turn
  ) {
    return mapped;
  }
  return uci;
}

/**
 * Normalize king-to-rook castling notation (e.g. e1h1 from Lichess cloud eval
 * or UCI_Chess960 engines) into standard UCI (e1g1) when applicable.
 */
export function normalizeCastlingUci(fen, uci) {
  if (!fen || !uci || uci.length < 4) return uci;
  try {
    const chess = new Chess(fen);
    return normalizeCastlingWithChess(chess, uci);
  } catch (_) {
    return uci;
  }
}

/**
 * Walk a PV array from `fen`, normalizing king-to-rook castling per ply so
 * arrows, click-to-play, and SAN conversion all receive standard UCI moves.
 */
export function normalizePv(fen, pvUci) {
  if (!Array.isArray(pvUci) || !pvUci.length) return [];
  let chess;
  try {
    chess = new Chess(fen);
  } catch (_) {
    return [...pvUci];
  }

  const out = [];
  for (let i = 0; i < pvUci.length; i++) {
    const raw = pvUci[i];
    if (!raw || raw.length < 4) break;
    const u = normalizeCastlingWithChess(chess, raw);
    let m;
    try {
      m = chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined });
    } catch (_) {
      break;
    }
    if (!m) break;
    out.push(u);
  }
  return out;
}

export function parseUciInfoLine(line) {
  const dM = line.match(/\bdepth (\d+)/);
  const mpvM = line.match(/\bmultipv (\d+)/);
  const scM = line.match(/\bscore (cp|mate) (-?\d+)/);
  const pvM = line.match(/\bpv (.+)$/);
  if (!dM || !scM || !pvM) return null;

  const npsM = line.match(/\bnps (\d+)/);
  const nodesM = line.match(/\bnodes (\d+)/);
  const wdlM = line.match(/\bwdl (\d+) (\d+) (\d+)/);
  return {
    multipv: mpvM ? parseInt(mpvM[1], 10) : 1,
    depth: parseInt(dM[1], 10),
    scoreType: scM[1],
    scoreVal: parseInt(scM[2], 10),
    nps: npsM ? parseInt(npsM[1], 10) : null,
    nodes: nodesM ? parseInt(nodesM[1], 10) : null,
    wdl: wdlM
      ? [parseInt(wdlM[1], 10), parseInt(wdlM[2], 10), parseInt(wdlM[3], 10)]
      : null,
    pv: pvM[1].trim().split(/\s+/),
  };
}

export function uciPvToSan(fen, pvUci) {
  let c;
  try {
    c = new Chess(fen);
  } catch (_) {
    return '';
  }
  const out = [];
  let mNum = parseInt((fen || '').split(' ')[5] || '1', 10) || 1;
  for (let i = 0; i < pvUci.length && i < 8; i++) {
    const raw = pvUci[i];
    if (!raw || raw.length < 4) break;
    const u = normalizeCastlingWithChess(c, raw);
    let m;
    try {
      m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined });
    } catch (_) {
      break;
    }
    if (!m) break;
    if (m.color === 'w') {
      out.push(`${mNum}.${m.san}`);
    } else {
      out.push(i === 0 ? `${mNum}...${m.san}` : m.san);
      mNum++;
    }
  }
  return out.join(' ');
}

export function renderEngineLines(elId, linesObj, fen, flip) {
  const el = document.getElementById(elId);
  if (!el) return;

  const rows = [];
  for (let i = 1; i <= 3; i++) {
    const l = linesObj[i];
    if (!l || !l.pv?.length) continue;
    const wVal = l.scoreVal * flip;
    const sc =
      l.scoreType === 'mate'
        ? `${wVal > 0 ? '+M' : '-M'}${Math.abs(wVal)}`
        : `${wVal >= 0 ? '+' : ''}${(wVal / 100).toFixed(2)}`;
    const cls =
      wVal > 30
        ? 'bg-em/15 text-em'
        : wVal < -30
          ? 'bg-ro/15 text-ro'
          : 'bg-surface text-txt';
    const firstUci = normalizeCastlingUci(fen, l.pv[0]);
    rows.push(
      `<div data-uci="${escapeHtml(firstUci)}" class="pv-row px-2 py-1 flex items-center gap-2 hover:bg-surfaceHover cursor-pointer"><span class="px-1.5 py-[1px] rounded font-bold text-[10.5px] w-12 text-center shrink-0 ${cls}">${sc}</span><span class="truncate text-txt/90">${escapeHtml(uciPvToSan(fen, l.pv))}</span></div>`
    );
  }

  if (rows.length) {
    el.innerHTML = rows.join('');
    el.querySelectorAll('.pv-row').forEach((r) => {
      r.onclick = () => playMoveOnTree(r.dataset.uci);
      r.onmouseenter = () => {
        state.hoverArrowUci = r.dataset.uci;
        renderArrows();
      };
      r.onmouseleave = () => {
        state.hoverArrowUci = null;
        renderArrows();
      };
    });
  }
}

export function formatEvalBarLabel(evalLabel, cp) {
  if (!evalLabel || evalLabel === '—') return '0.0';
  const mateMatch = evalLabel.match(/[+-]?M(\d+)/);
  if (mateMatch) return `M${mateMatch[1]}`;
  const num = Math.abs((cp || 0) / 100);
  if (num >= 10) return String(Math.round(num));
  return num.toFixed(1);
}

export function updateEvalBarFromState() {
  const fill = document.getElementById('evalFillWhite');
  const drawFill = document.getElementById('evalFillDraw');
  const top = document.getElementById('evalLabelTop');
  const bot = document.getElementById('evalLabelBottom');
  const box = document.getElementById('evalBarContainer');
  const badge = document.getElementById('evalSourceBadge');
  if (!fill || !top || !bot || !box || !badge) return;

  const maiaActive = state.evalBarSource === 'maia' && state.maia.enabled && state.maia.result;
  if (maiaActive) {
    const expPct = Math.max(4, Math.min(96, Math.round((Number(state.maia.result.whiteExp) || 0.5) * 100)));
    const wAdv = expPct >= 50;
    if (drawFill) drawFill.style.height = '0%';
    badge.textContent = 'M2';
    badge.className =
      'absolute top-1/2 left-0 right-0 -translate-y-1/2 text-center font-mono text-[7.5px] font-bold py-0.5 bg-bg/85 text-vi pointer-events-none';
    fill.style.height = `${expPct}%`;
    if (state.flipped) {
      box.classList.remove('justify-end');
      box.classList.add('justify-start');
      top.textContent = wAdv ? `${expPct}%` : '';
      top.style.color = '#0f172a';
      bot.textContent = !wAdv ? `${100 - expPct}%` : '';
      bot.style.color = '#e2e8f0';
    } else {
      box.classList.remove('justify-start');
      box.classList.add('justify-end');
      bot.textContent = wAdv ? `${expPct}%` : '';
      bot.style.color = '#0f172a';
      top.textContent = !wAdv ? `${100 - expPct}%` : '';
      top.style.color = '#e2e8f0';
    }
    return;
  }

  const hfActive = state.evalBarSource === 'hf' && state.hf.enabled && state.hf.result;
  if (hfActive) {
    const hum = getActiveHumanOutcome(state.hf.result, state.hf.useClocks);
    if (hum) {
      const wPct = Math.max(0, Math.min(100, Math.round((Number(hum.white) || 0) * 100)));
      const dPct = Math.max(0, Math.min(100 - wPct, Math.round((Number(hum.draw) || 0) * 100)));
      const expPct = Math.round((Number(hum.expected_score) || 0.5) * 100);
      const wAdv = expPct >= 50;

      badge.textContent = 'HF';
      badge.className =
        'absolute top-1/2 left-0 right-0 -translate-y-1/2 text-center font-mono text-[7.5px] font-bold py-0.5 bg-bg/85 text-em pointer-events-none';

      fill.style.height = `${wPct}%`;
      if (drawFill) drawFill.style.height = `${dPct}%`;

      if (state.flipped) {
        box.classList.remove('justify-end');
        box.classList.add('justify-start');
        if (drawFill && fill.nextElementSibling !== drawFill) fill.after(drawFill);
        top.textContent = wAdv ? `${expPct}%` : '';
        top.style.color = wPct >= 14 ? '#0f172a' : '#e2e8f0';
        bot.textContent = !wAdv ? `${100 - expPct}%` : '';
        bot.style.color = '#e2e8f0';
      } else {
        box.classList.remove('justify-start');
        box.classList.add('justify-end');
        if (drawFill && drawFill.nextElementSibling !== fill) fill.before(drawFill);
        bot.textContent = wAdv ? `${expPct}%` : '';
        bot.style.color = wPct >= 14 ? '#0f172a' : '#e2e8f0';
        top.textContent = !wAdv ? `${100 - expPct}%` : '';
        top.style.color = '#e2e8f0';
      }
      return;
    }
  }

  if (drawFill) drawFill.style.height = '0%';

  // If user selected Lc0 for eval bar but Lc0 is disconnected, fall back to Stockfish display
  const useLc0 = state.evalBarSource === 'lc0' && state.lc0.mode === 'ws';
  const src = useLc0 ? state.lc0 : state.sf;
  const cp = src.evalWhiteCp || 0;
  const shortLbl = formatEvalBarLabel(src.evalLabel, cp);
  const pct = Math.max(4, Math.min(96, 50 + 50 * (2 / (1 + Math.exp(-0.42 * (cp / 100))) - 1)));

  badge.textContent = useLc0 ? 'Lc0' : 'SF';
  badge.className = `absolute top-1/2 left-0 right-0 -translate-y-1/2 text-center font-mono text-[7.5px] font-bold py-0.5 bg-bg/80 pointer-events-none ${
    useLc0 ? 'text-vi' : 'text-cy'
  }`;

  const wAdv = cp >= 0;
  if (state.flipped) {
    box.classList.remove('justify-end');
    box.classList.add('justify-start');
    fill.style.height = `${pct}%`;
    top.textContent = wAdv ? shortLbl : '';
    top.style.color = '#0f172a';
    bot.textContent = !wAdv ? shortLbl : '';
    bot.style.color = '#e2e8f0';
  } else {
    box.classList.remove('justify-start');
    box.classList.add('justify-end');
    fill.style.height = `${pct}%`;
    bot.textContent = wAdv ? shortLbl : '';
    bot.style.color = '#0f172a';
    top.textContent = !wAdv ? shortLbl : '';
    top.style.color = '#e2e8f0';
  }
}
