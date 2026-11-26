import { Chess } from 'chess.js';
import { state, escapeHtml } from '../state.js';
import { playMoveOnTree, renderArrows } from '../board/board.js';

export function parseUciInfoLine(line) {
  const dM = line.match(/\bdepth (\d+)/);
  const mpvM = line.match(/\bmultipv (\d+)/);
  const scM = line.match(/\bscore (cp|mate) (-?\d+)/);
  const pvM = line.match(/\bpv (.+)$/);
  if (!dM || !scM || !pvM) return null;

  const npsM = line.match(/\bnps (\d+)/);
  const wdlM = line.match(/\bwdl (\d+) (\d+) (\d+)/);
  return {
    multipv: mpvM ? parseInt(mpvM[1], 10) : 1,
    depth: parseInt(dM[1], 10),
    scoreType: scM[1],
    scoreVal: parseInt(scM[2], 10),
    nps: npsM ? parseInt(npsM[1], 10) : 0,
    wdl: wdlM
      ? [parseInt(wdlM[1], 10), parseInt(wdlM[2], 10), parseInt(wdlM[3], 10)]
      : null,
    pv: pvM[1].trim().split(/\s+/),
  };
}

export function uciPvToSan(fen, pvUci) {
  const c = new Chess(fen);
  const out = [];
  let mNum = parseInt(fen.split(' ')[5] || '1', 10);
  for (let i = 0; i < pvUci.length && i < 8; i++) {
    const u = pvUci[i];
    if (!u || u.length < 4) break;
    let m = null;
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
    rows.push(
      `<div data-uci="${escapeHtml(l.pv[0])}" class="pv-row px-2 py-1 flex items-center gap-2 hover:bg-surfaceHover cursor-pointer"><span class="px-1.5 py-[1px] rounded font-bold text-[10.5px] w-12 text-center shrink-0 ${cls}">${sc}</span><span class="truncate text-txt/90">${escapeHtml(uciPvToSan(fen, l.pv))}</span></div>`
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

export function updateEvalBarFromState() {
  // If user selected Lc0 for eval bar but Lc0 is disconnected, fall back to Stockfish display
  const useLc0 = state.evalBarSource === 'lc0' && state.lc0.mode === 'ws';
  const src = useLc0 ? state.lc0 : state.sf;
  const cp = src.evalWhiteCp || 0;
  const lbl = src.evalLabel && src.evalLabel !== '—' ? src.evalLabel : '0.0';
  const pct = Math.max(4, Math.min(96, 50 + 50 * (2 / (1 + Math.exp(-0.42 * (cp / 100))) - 1)));

  const fill = document.getElementById('evalFillWhite');
  const top = document.getElementById('evalLabelTop');
  const bot = document.getElementById('evalLabelBottom');
  const box = document.getElementById('evalBarContainer');
  const badge = document.getElementById('evalSourceBadge');
  if (!fill || !top || !bot || !box || !badge) return;

  badge.textContent = useLc0 ? 'Lc0' : 'SF';
  badge.className = `absolute top-1/2 left-0 right-0 -translate-y-1/2 text-center font-mono text-[7.5px] font-bold py-0.5 bg-bg/80 pointer-events-none ${
    useLc0 ? 'text-vi' : 'text-cy'
  }`;

  const wAdv = cp >= 0;
  if (state.flipped) {
    box.classList.remove('justify-end');
    box.classList.add('justify-start');
    fill.style.height = `${pct}%`;
    top.textContent = wAdv ? lbl.replace('+', '') : '';
    top.style.color = '#0f172a';
    bot.textContent = !wAdv ? lbl.replace('-', '') : '';
    bot.style.color = '#e2e8f0';
  } else {
    box.classList.remove('justify-start');
    box.classList.add('justify-end');
    fill.style.height = `${pct}%`;
    bot.textContent = wAdv ? lbl.replace('+', '') : '';
    bot.style.color = '#0f172a';
    top.textContent = !wAdv ? lbl.replace('-', '') : '';
    top.style.color = '#e2e8f0';
  }
}
