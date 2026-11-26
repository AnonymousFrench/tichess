import { Chess } from 'chess.js';
import { START_FEN } from '../state.js';

let nodeSeq = 1;

export function createNode({
  parent = null,
  san = null,
  uci = null,
  from = null,
  to = null,
  promotion = '',
  fen = START_FEN,
  color = null,
  moveNum = 1,
  comment = '',
  clk = '',
  nags = [],
} = {}) {
  return {
    id: 'n' + nodeSeq++,
    parent,
    san,
    uci,
    from,
    to,
    promotion,
    fen,
    color,
    moveNum,
    comment,
    clk,
    nags: [...nags],
    children: [],
  };
}

/**
 * Extract [%clk H:MM:SS] comments per ply from a PGN string.
 */
export function extractClocksFromPgn(pgnText) {
  const clocks = [];
  const cleaned = (pgnText || '').replace(/^\s*\[[^\]]*\]\s*$/gm, ' ');
  const tokens = cleaned.match(/\{[^}]*\}|\S+/g) || [];
  let ply = 0;
  for (const tok of tokens) {
    if (tok.startsWith('{')) {
      const m = tok.match(/\[%clk\s+([0-9:.]+)\]/);
      if (m && ply > 0) clocks[ply - 1] = m[1];
    } else if (
      !/^\d+\.+$/.test(tok) &&
      !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok) &&
      !tok.startsWith('$') &&
      !tok.startsWith('(') &&
      !tok.startsWith(')')
    ) {
      ply++;
    }
  }
  return clocks;
}

/**
 * Safely parse a FEN or PGN into a variation tree.
 */
export function createTreeFromPgn(pgnText, fallbackFen = START_FEN) {
  const trimmed = (pgnText || '').trim();

  // Check if input is a FEN string
  if (trimmed && trimmed.split('/').length === 8 && !trimmed.includes('[')) {
    try {
      const fenCheck = new Chess();
      fenCheck.load(trimmed);
      const root = createNode({ fen: fenCheck.fen() });
      return { root, current: root, meta: null };
    } catch (_) {
      // Not a valid FEN; fall through to PGN parser
    }
  }

  const parser = new Chess();
  let loaded = false;
  if (trimmed) {
    try {
      parser.loadPgn(trimmed, { strict: false });
      loaded = true;
    } catch (_) {
      loaded = false;
    }
  }

  if (!loaded) {
    const root = createNode({ fen: fallbackFen });
    return { root, current: root, meta: null };
  }

  const headers = parser.getHeaders();
  const startFen = headers.FEN || START_FEN;
  let replay;
  try {
    replay = new Chess(startFen);
  } catch (_) {
    const root = createNode({ fen: fallbackFen });
    return { root, current: root, meta: null, invalidFen: true };
  }

  const root = createNode({ fen: replay.fen() });
  const verbose = parser.history({ verbose: true });
  const clocks = extractClocksFromPgn(trimmed);

  let cur = root;
  let moveNum = parseInt(replay.fen().split(' ')[5] || '1', 10) || 1;
  for (let i = 0; i < verbose.length; i++) {
    let m = null;
    try {
      m = replay.move({
        from: verbose[i].from,
        to: verbose[i].to,
        promotion: verbose[i].promotion,
      });
    } catch (_) {
      break;
    }
    if (!m) break;
    const child = createNode({
      parent: cur,
      san: m.san,
      uci: m.from + m.to + (m.promotion || ''),
      from: m.from,
      to: m.to,
      promotion: m.promotion || '',
      fen: replay.fen(),
      color: m.color,
      moveNum,
      clk: clocks[i] || '',
    });
    if (m.color === 'b') moveNum++;
    cur.children.push(child);
    cur = child;
  }

  const meta =
    headers.White || headers.Black || headers.Event || headers.ECO || headers.Opening
      ? {
          white: headers.White || 'White',
          whiteElo: headers.WhiteElo || '',
          black: headers.Black || 'Black',
          blackElo: headers.BlackElo || '',
          event: headers.Event || '',
          date: headers.Date || headers.UTCDate || '',
          result: headers.Result || '*',
          eco: headers.ECO || '',
          opening: headers.Opening || '',
        }
      : null;

  return { root, current: cur, meta };
}

/**
 * Merge a freshly parsed broadcast mainline into an existing variation tree
 * without losing user variations or detaching `tab.current`.
 *
 * If the broadcast mainline diverges (e.g. a broadcast correction), the old
 * continuation is demoted to a variation rather than deleted.
 */
export function mergeMainline(existingRoot, newRoot) {
  if (!existingRoot || !newRoot) {
    return { added: 0, clockChanged: false, lastNode: existingRoot };
  }

  let curExisting = existingRoot;
  let curNew = newRoot.children[0] || null;
  let added = 0;
  let clockChanged = false;

  while (curNew) {
    const matchIdx = curExisting.children.findIndex((ch) => ch.san === curNew.san);
    if (matchIdx === 0) {
      const matched = curExisting.children[0];
      if (curNew.clk && matched.clk !== curNew.clk) {
        matched.clk = curNew.clk;
        clockChanged = true;
      }
      curExisting = matched;
    } else if (matchIdx > 0) {
      const [matched] = curExisting.children.splice(matchIdx, 1);
      curExisting.children.unshift(matched);
      if (curNew.clk && matched.clk !== curNew.clk) {
        matched.clk = curNew.clk;
        clockChanged = true;
      }
      added++;
      curExisting = matched;
    } else {
      const inserted = createNode({
        parent: curExisting,
        san: curNew.san,
        uci: curNew.uci,
        from: curNew.from,
        to: curNew.to,
        promotion: curNew.promotion,
        fen: curNew.fen,
        color: curNew.color,
        moveNum: curNew.moveNum,
        comment: curNew.comment,
        clk: curNew.clk,
        nags: curNew.nags,
      });
      // Insert as mainline (index 0), demoting any prior continuation to a variation
      curExisting.children.unshift(inserted);
      added++;
      curExisting = inserted;
    }
    curNew = curNew.children[0] || null;
  }

  return { added, clockChanged, lastNode: curExisting };
}

export function exportTreeToPgn(tab) {
  let headers = '';
  if (tab.meta) {
    headers += `[Event "${tab.meta.event || 'Analysis'}"]\n[White "${tab.meta.white || 'White'}"]\n[Black "${tab.meta.black || 'Black'}"]\n[Result "${tab.meta.result || '*'}"]\n`;
  }
  if (tab.root.fen !== START_FEN) {
    headers += `[SetUp "1"]\n[FEN "${tab.root.fen}"]\n`;
  }

  const ser = (node, forceNum) => {
    if (!node.children.length) return '';
    const main = node.children[0];
    let s =
      main.color === 'w'
        ? `${main.moveNum}. ${main.san}`
        : forceNum || node === tab.root
          ? `${main.moveNum}... ${main.san}`
          : main.san;
    if (main.nags.length) s += main.nags.join('');
    if (main.comment) s += ` {${main.comment}}`;

    for (let i = 1; i < node.children.length; i++) {
      const v = node.children[i];
      let vs = v.color === 'w' ? `${v.moveNum}. ${v.san}` : `${v.moveNum}... ${v.san}`;
      if (v.nags.length) vs += v.nags.join('');
      if (v.comment) vs += ` {${v.comment}}`;
      const rest = ser(v, false);
      if (rest) vs += ' ' + rest;
      s += ` (${vs})`;
    }

    const nxt = ser(main, node.children.length > 1);
    return nxt ? s + ' ' + nxt : s;
  };

  return (headers ? headers + '\n' : '') + ser(tab.root, true);
}

export function findNodeById(node, id) {
  if (node.id === id) return node;
  for (const ch of node.children) {
    const r = findNodeById(ch, id);
    if (r) return r;
  }
  return null;
}
