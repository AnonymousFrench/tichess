/**
 * Small SVG/HTML chart builders for Insights. Each returns an HTML string.
 * Colors follow the app palette; results always read win = green,
 * draw = gray, loss = rose.
 */

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const fmtInt = (n) => (Number(n) || 0).toLocaleString('en-US');
export const fmtPct = (x, digits = 0) => `${(x * 100).toFixed(digits)}%`;

/** Score (0..1) to a red → amber → green color. */
export function scoreColor(score, alpha = 1) {
  const t = Math.min(1, Math.max(0, (score - 0.3) / 0.4));
  const hue = 4 + t * 138;
  return `hsla(${hue.toFixed(0)}, 72%, ${t > 0.4 && t < 0.65 ? 52 : 50}%, ${alpha})`;
}

/** Stacked win/draw/loss bar with optional percentage labels. */
export function wdlBar({ n, w, d, l }, { labels = true, height = 'h-[18px]' } = {}) {
  if (!n) return `<div class="${height} rounded bg-surface"></div>`;
  const seg = (count, cls, txtCls) => {
    if (!count) return '';
    const p = (count / n) * 100;
    const label = labels && p >= 12 ? `<span class="${txtCls}">${Math.round(p)}%</span>` : '';
    return `<div class="${cls} flex items-center justify-center overflow-hidden" style="width:${p.toFixed(2)}%">${label}</div>`;
  };
  return `<div class="flex ${height} rounded overflow-hidden text-[10px] font-semibold font-mono leading-none" title="${fmtInt(w)} wins · ${fmtInt(d)} draws · ${fmtInt(l)} losses">${seg(
    w,
    'bg-em/85',
    'text-[#032016]'
  )}${seg(d, 'bg-[#5b6273]', 'text-[#e5e7eb]')}${seg(l, 'bg-ro/85', 'text-[#2a0710]')}</div>`;
}

/**
 * Line chart that stays crisp at any width: the line is drawn in a stretched
 * SVG, while labels and markers are HTML positioned in percent.
 * points: [{x: number, y: number}] (x usually ms). opts: { height, yFmt, color, label }.
 */
export function lineChart(points, opts = {}) {
  const H = opts.height || 180;
  if (points.length < 2) {
    return `<div class="flex items-center justify-center text-txtMuted text-[11px]" style="height:${H}px">Not enough rated games in this selection</div>`;
  }
  const padL = 40;
  const padB = 20;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  const span = Math.max(20, y1 - y0);
  y0 = Math.floor((y0 - span * 0.08) / 10) * 10;
  y1 = Math.ceil((y1 + span * 0.08) / 10) * 10;
  const fx = (x) => (x - x0) / Math.max(1, x1 - x0); // 0..1
  const fy = (y) => 1 - (y - y0) / Math.max(1, y1 - y0); // 0..1 from top
  const color = opts.color || '#10b981';
  const step = Math.max(1, Math.floor(points.length / 600));
  const pts = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${(fx(p.x) * 1000).toFixed(1)},${(fy(p.y) * 100).toFixed(2)}`).join('');
  const area = `${path}L1000,100L0,100Z`;
  const yFmt = opts.yFmt || ((v) => String(v));
  const yTicks = niceTicks(y0, y1, 4);
  const xTicks = timeTicks(x0, x1);
  const peak = points.reduce((a, b) => (b.y > a.y ? b : a), points[0]);
  const last = points[points.length - 1];
  const dot = (p, cls, title) =>
    `<span class="absolute w-[8px] h-[8px] -ml-[4px] -mt-[4px] rounded-full ${cls}" style="left:${(fx(p.x) * 100).toFixed(2)}%;top:${(fy(p.y) * 100).toFixed(2)}%" title="${esc(title)}"></span>`;
  return `<div class="relative select-none" style="height:${H}px" role="img" aria-label="${esc(opts.label || 'Chart')}">
    <div class="absolute top-0 left-0" style="bottom:${padB}px;width:${padL}px">${yTicks
      .map((v) => `<span class="absolute right-[8px] -translate-y-1/2 font-mono text-[10px] text-txtMuted" style="top:${(fy(v) * 100).toFixed(2)}%">${esc(yFmt(v))}</span>`)
      .join('')}</div>
    <div class="absolute top-0 right-0" style="bottom:${padB}px;left:${padL}px">
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none" class="absolute inset-0 w-full h-full overflow-visible">
        ${yTicks.map((v) => `<line x1="0" x2="1000" y1="${(fy(v) * 100).toFixed(2)}" y2="${(fy(v) * 100).toFixed(2)}" stroke="#252934" stroke-dasharray="4 5" vector-effect="non-scaling-stroke"/>`).join('')}
        ${opts.area === false ? '' : `<path d="${area}" fill="${color}" opacity="0.10"/>`}
        <path d="${path}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      </svg>
      ${dot(peak, 'bg-am', `Peak ${yFmt(peak.y)}`)}${dot(last, 'bg-em ring-2 ring-bg', `Latest ${yFmt(last.y)}`)}
    </div>
    <div class="absolute bottom-0 right-0" style="left:${padL}px;height:${padB}px">${xTicks
      .map((t) => `<span class="absolute -translate-x-1/2 bottom-[2px] text-[10px] text-txtMuted whitespace-nowrap" style="left:${(fx(t.x) * 100).toFixed(2)}%">${esc(t.label)}</span>`)
      .join('')}</div>
  </div>`;
}

function niceTicks(lo, hi, count) {
  const range = hi - lo;
  const raw = range / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(Math.round(v));
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function timeTicks(x0, x1) {
  const spanDays = (x1 - x0) / 86_400_000;
  const out = [];
  const d = new Date(x0);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  const monthStep = spanDays > 1500 ? 12 : spanDays > 700 ? 6 : spanDays > 300 ? 3 : spanDays > 100 ? 1 : 0;
  if (!monthStep) {
    const step = Math.max(1, Math.round(spanDays / 5)) * 86_400_000;
    for (let t = x0; t <= x1; t += step) {
      const dd = new Date(t);
      out.push({ x: t, label: `${MONTHS[dd.getMonth()]} ${dd.getDate()}` });
    }
    return out;
  }
  if (monthStep === 12) d.setMonth(0);
  while (d.getTime() <= x1) {
    if (d.getTime() >= x0) {
      out.push({ x: d.getTime(), label: monthStep >= 12 || d.getMonth() === 0 ? String(d.getFullYear()) : MONTHS[d.getMonth()] });
    }
    d.setMonth(d.getMonth() + monthStep);
  }
  return out;
}

/**
 * Vertical bars colored by score. items: [{label, n, score}]. Height ∝ games.
 * Each bar's score shows on hover and above the bar when there is room.
 */
export function scoreBars(items, { height = 130, showScore = true } = {}) {
  const max = Math.max(1, ...items.map((i) => i.n));
  const cols = items
    .map((i) => {
      const h = i.n ? Math.max(3, (i.n / max) * (height - 30)) : 0;
      return `<div class="flex-1 min-w-0 flex flex-col items-center justify-end gap-1" title="${esc(i.label)}: ${fmtInt(i.n)} games${i.n ? `, ${fmtPct(i.score)} score` : ''}">
        ${showScore && i.n ? `<span class="text-[9.5px] font-mono text-txtMuted leading-none">${Math.round(i.score * 100)}</span>` : ''}
        <div class="w-full max-w-[26px] rounded-sm" style="height:${h.toFixed(1)}px;background:${i.n ? scoreColor(i.score) : 'transparent'}"></div>
        <span class="text-[9.5px] text-txtMuted leading-none whitespace-nowrap h-[10px]">${esc(i.label)}</span>
      </div>`;
    })
    .join('');
  return `<div class="flex items-end gap-[3px]" style="height:${height}px">${cols}</div>`;
}

/**
 * GitHub-style calendar for one year. dayMap: Map('YYYY-MM-DD' → {n, pts}).
 * Square size grows with games played, color shows the score that day.
 */
export function yearCalendar(year, dayMap, { maxN } = {}) {
  const cell = 11;
  const gap = 2;
  const start = new Date(year, 0, 1);
  const offset = start.getDay();
  const days = (new Date(year + 1, 0, 1) - start) / 86_400_000;
  const top = 14;
  const left = 22;
  const weeks = Math.ceil((days + offset) / 7);
  const W = left + weeks * (cell + gap);
  const H = top + 7 * (cell + gap);
  const max = maxN || Math.max(1, ...[...dayMap.values()].map((v) => v.n));
  let rects = '';
  let monthLabels = '';
  for (let i = 0; i < days; i++) {
    const d = new Date(year, 0, 1 + i);
    const idx = i + offset;
    const wk = Math.floor(idx / 7);
    const wd = idx % 7;
    const x = left + wk * (cell + gap);
    const y = top + wd * (cell + gap);
    if (d.getDate() === 1) monthLabels += `<text x="${x}" y="10" fill="#8e96a8" font-size="9">${MONTHS[d.getMonth()]}</text>`;
    const key = `${year}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const v = dayMap.get(key);
    rects += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="#1b1e25"/>`;
    if (v && v.n) {
      const s = Math.max(4, Math.round(cell * Math.sqrt(Math.min(1, v.n / max))));
      const o = (cell - s) / 2;
      // The whole cell is the click target, so small days are easy to hit.
      rects += `<g data-act="day-games" data-day="${key}" style="cursor:pointer"><rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="transparent"/><rect x="${x + o}" y="${y + o}" width="${s}" height="${s}" rx="1.5" fill="${scoreColor(v.pts / v.n)}"/><title>${key}: ${v.n} game${v.n === 1 ? '' : 's'}, ${Math.round((v.pts / v.n) * 100)}% score. Click to see them.</title></g>`;
    }
  }
  const dayLabels = ['Mon', 'Wed', 'Fri']
    .map((l, i) => `<text x="0" y="${top + (1 + i * 2) * (cell + gap) + 9}" fill="#8e96a8" font-size="9">${l}</text>`)
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="w-full h-auto block" style="max-width:${Math.round(W * 1.45)}px" role="img" aria-label="Activity in ${year}">${monthLabels}${dayLabels}${rects}</svg>`;
}

/** Hour × weekday grid (rows Sunday..Saturday). grid[wd][h] = {n, pts}. */
export function hourGrid(grid, { hourLabel = (h) => String(h) } = {}) {
  const cell = 22;
  const gap = 3;
  const left = 34;
  const top = 16;
  const W = left + 24 * (cell + gap);
  const H = top + 7 * (cell + gap);
  const max = Math.max(1, ...grid.flat().map((c) => c.n));
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let out = '';
  for (let h = 0; h < 24; h++) {
    if (h % 3 === 0) out += `<text x="${left + h * (cell + gap) + cell / 2}" y="10" text-anchor="middle" fill="#8e96a8" font-size="9.5">${esc(hourLabel(h))}</text>`;
  }
  for (let wd = 0; wd < 7; wd++) {
    const y = top + wd * (cell + gap);
    out += `<text x="0" y="${y + 15}" fill="#8e96a8" font-size="10">${names[wd]}</text>`;
    for (let h = 0; h < 24; h++) {
      const x = left + h * (cell + gap);
      const c = grid[wd][h];
      out += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="#161920"/>`;
      if (c.n) {
        const s = Math.max(5, Math.round(cell * Math.sqrt(c.n / max)));
        const o = (cell - s) / 2;
        out += `<rect x="${x + o}" y="${y + o}" width="${s}" height="${s}" rx="2" fill="${scoreColor(c.pts / c.n)}"><title>${names[wd]} ${hourLabel(h)}: ${fmtInt(c.n)} games, ${Math.round((c.pts / c.n) * 100)}% score</title></rect>`;
      }
    }
  }
  return `<svg viewBox="0 0 ${W} ${H}" class="w-full h-auto block" style="max-width:${Math.round(W * 1.5)}px" role="img" aria-label="Games by weekday and hour">${out}</svg>`;
}

/** Horizontal paired bars: actual score vs expected, per bucket. */
export function expectedVsActual(rows) {
  return rows
    .map((r) => {
      if (!r.n) {
        return `<div class="grid grid-cols-[110px_1fr_70px] items-center gap-2 text-[11px] opacity-40"><span class="text-txtMuted">${esc(r.label)}</span><span></span><span class="text-right font-mono">—</span></div>`;
      }
      const diff = r.score - r.expected;
      return `<div class="grid grid-cols-[110px_1fr_70px] items-center gap-2 text-[11px]" title="${fmtInt(r.n)} games: ${fmtPct(r.score)} actual vs ${fmtPct(r.expected)} expected">
        <span class="text-txtMuted truncate">${esc(r.label)}</span>
        <div class="relative h-[14px] rounded bg-surface overflow-hidden">
          <div class="absolute inset-y-0 left-0 rounded" style="width:${(r.score * 100).toFixed(1)}%;background:${scoreColor(r.score, 0.85)}"></div>
          <div class="absolute inset-y-[-2px] w-[2px] bg-txt/80" style="left:calc(${(r.expected * 100).toFixed(1)}% - 1px)"></div>
        </div>
        <span class="text-right font-mono ${diff >= 0 ? 'text-em' : 'text-ro'}">${diff >= 0 ? '+' : '−'}${Math.abs(Math.round(diff * 100))} pts</span>
      </div>`;
    })
    .join('');
}
