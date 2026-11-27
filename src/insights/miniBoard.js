/**
 * Board for the Insights explorer: pieces from tichess's own set,
 * optional last-move highlight, frequency arrows, and tap-to-move interaction.
 */
import { PIECE_SVG } from '../chess/pieces.js';

const PIECE_URL = {};
for (const [k, svg] of Object.entries(PIECE_SVG)) {
  PIECE_URL[k] = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    svg.includes('xmlns') ? svg : svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')
  )}`;
}

const FILES = 'abcdefgh';

/**
 * @param {string} fen
 * @param {{
 *   flipped?: boolean,
 *   last?: {from: string, to: string} | null,
 *   arrows?: {from: string, to: string, weight?: number, color?: string}[],
 *   interactive?: boolean,
 *   sqAct?: string,
 *   selected?: string | null,
 *   dests?: Set<string> | string[] | null,
 *   hint?: string | null,
 *   good?: string | null,
 *   bad?: string | null,
 * }} opts
 */
export function miniBoardHtml(
  fen,
  {
    flipped = false,
    last = null,
    arrows = [],
    interactive = false,
    sqAct = 'ex-sq',
    selected = null,
    dests = null,
    hint = null,
    good = null,
    bad = null,
  } = {}
) {
  const destSet = dests instanceof Set ? dests : new Set(dests || []);
  const rows = fen.split(' ')[0].split('/');
  const sq = [];
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) {
        for (let k = 0; k < +ch; k++) sq.push({ name: FILES[f++] + (8 - r), piece: null });
      } else {
        sq.push({ name: FILES[f++] + (8 - r), piece: ch });
      }
    }
  }
  const ordered = flipped ? [...sq].reverse() : sq;
  const cells = ordered
    .map((s, i) => {
      const file = FILES.indexOf(s.name[0]);
      const rank = +s.name[1];
      const light = (file + rank) % 2 === 1;
      const isLast = last && (s.name === last.from || s.name === last.to);
      const isSel = selected === s.name;
      const isDest = destSet.has(s.name);
      const bg = isLast ? (light ? 'var(--sq-last-light)' : 'var(--sq-last-dark)') : light ? 'var(--sq-light)' : 'var(--sq-dark)';
      let ring = '';
      if (good === s.name) ring = 'box-shadow:inset 0 0 0 2.5px #10b981;';
      else if (bad === s.name) ring = 'box-shadow:inset 0 0 0 2.5px #fb7185;';
      else if (hint === s.name) ring = 'box-shadow:inset 0 0 0 2.5px #f59e0b;';
      const key = s.piece ? (s.piece === s.piece.toUpperCase() ? 'w' : 'b') + s.piece.toUpperCase() : '';
      const img = key ? `<img src="${PIECE_URL[key]}" alt="" draggable="false" class="w-[88%] h-[88%] pointer-events-none select-none relative z-[2]">` : '';
      const selOverlay = isSel ? '<span class="absolute inset-0 pointer-events-none z-[1]" style="background:var(--sq-select)"></span>' : '';
      const destMark = isDest
        ? key
          ? '<span class="absolute inset-[6%] rounded-full border-[4px] border-black/30 pointer-events-none z-[3]"></span>'
          : '<span class="absolute w-[28%] h-[28%] rounded-full bg-black/28 pointer-events-none z-[3]"></span>'
        : '';
      const col = i % 8;
      const row = Math.floor(i / 8);
      const coordColor = light ? 'var(--sq-dark)' : 'var(--sq-light)';
      const fileLbl = row === 7 ? `<span class="absolute right-[3px] bottom-[1px] text-[9px] font-semibold pointer-events-none" style="color:${coordColor}">${s.name[0]}</span>` : '';
      const rankLbl = col === 0 ? `<span class="absolute left-[3px] top-[1px] text-[9px] font-semibold pointer-events-none" style="color:${coordColor}">${s.name[1]}</span>` : '';
      const actAttrs = interactive ? ` data-act="${sqAct}" data-sq="${s.name}"` : '';
      const curCls = interactive ? ' cursor-pointer select-none' : '';
      return `<div class="relative flex items-center justify-center${curCls}" style="background:${bg};${ring}"${actAttrs}>${selOverlay}${img}${destMark}${fileLbl}${rankLbl}</div>`;
    })
    .join('');

  const center = (name) => {
    let x = FILES.indexOf(name[0]);
    let y = 8 - +name[1];
    if (flipped) {
      x = 7 - x;
      y = 7 - y;
    }
    return [x * 100 + 50, y * 100 + 50];
  };
  const uid = Math.random().toString(36).slice(2, 7);
  const arrowSvg = arrows
    .map((a, i) => {
      const [x1, y1] = center(a.from);
      const [x2, y2] = center(a.to);
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (!len) return '';
      const k = (len - 32) / len;
      const ex = x1 + (x2 - x1) * k;
      const ey = y1 + (y2 - y1) * k;
      const weight = typeof a.weight === 'number' ? a.weight : 0.7;
      const color = a.color || '#10b981';
      const w = 8 + weight * 12;
      const op = 0.35 + weight * 0.5;
      return `<line x1="${x1}" y1="${y1}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="${color}" stroke-width="${w.toFixed(1)}" stroke-linecap="round" opacity="${op.toFixed(2)}" marker-end="url(#mbHead${uid}_${i})"/>
        <defs><marker id="mbHead${uid}_${i}" markerWidth="3" markerHeight="3" refX="1.5" refY="1.5" orient="auto"><path d="M0,0 L3,1.5 L0,3 z" fill="${color}" opacity="${op.toFixed(2)}"/></marker></defs>`;
    })
    .join('');

  return `<div class="relative w-full aspect-square rounded-lg overflow-hidden shadow-xl select-none">
    <div class="absolute inset-0 grid grid-cols-8 grid-rows-8">${cells}</div>
    <svg viewBox="0 0 800 800" class="absolute inset-0 w-full h-full pointer-events-none z-[4]">${arrowSvg}</svg>
  </div>`;
}
