/**
 * Normalizes games from Lichess, Chess.com and PGN files into one compact
 * record, always seen from the account owner's side. Pure functions, so they
 * are unit tested directly.
 *
 * Record shape:
 * {
 *   id: 'li:abc123' | 'cc:123456' | 'pgn:<hash>',
 *   src: 'lichess' | 'chesscom' | 'pgn',
 *   acct: lowercase account name the game belongs to,
 *   t: start time (ms),
 *   tc: 'bullet' | 'blitz' | 'rapid' | 'classical' | 'daily',
 *   clock: '180+0' | '' (base seconds + increment),
 *   rated: boolean,
 *   color: 'w' | 'b' (owner's color),
 *   res: 1 | 0.5 | 0 (owner's score),
 *   term: 'mate' | 'resign' | 'time' | 'abandon' | 'agreement' | 'repetition'
 *         | 'stalemate' | 'insufficient' | 'fifty' | 'other',
 *   me: owner's rating (0 if unknown), op: opponent name, opR: opponent rating,
 *   opT: opponent title ('' if none),
 *   eco: 'B27' | '', opening: full opening name, oply: plies that define it,
 *   moves: 'e4 c5 Nf3 ...' (SAN, space separated), plies: number,
 *   url: link to the game ('' for PGN imports)
 * }
 */

export const TIME_CONTROLS = ['bullet', 'blitz', 'rapid', 'classical', 'daily'];

export const TC_LABEL = {
  bullet: 'Bullet',
  blitz: 'Blitz',
  rapid: 'Rapid',
  classical: 'Classical',
  daily: 'Daily',
};

const LICHESS_TC = {
  ultraBullet: 'bullet',
  bullet: 'bullet',
  blitz: 'blitz',
  rapid: 'rapid',
  classical: 'classical',
  correspondence: 'daily',
};

const CHESSCOM_TC = { bullet: 'bullet', blitz: 'blitz', rapid: 'rapid', daily: 'daily' };

export const TERM_LABEL = {
  mate: 'Checkmate',
  resign: 'Resignation',
  time: 'Time',
  abandon: 'Abandoned',
  agreement: 'Agreement',
  repetition: 'Repetition',
  stalemate: 'Stalemate',
  insufficient: 'Insufficient material',
  fifty: '50-move rule',
  other: 'Other',
};

/** Classify a game by estimated duration (base + 40 × increment), Lichess style. */
export function classifyClock(baseSec, incSec) {
  const est = (Number(baseSec) || 0) + 40 * (Number(incSec) || 0);
  if (est < 180) return 'bullet';
  if (est < 480) return 'blitz';
  if (est < 1500) return 'rapid';
  return 'classical';
}

const lc = (s) => String(s || '').toLowerCase();

/** Lichess NDJSON game → record (or null for variants, aborted games or games without the owner). */
export function normalizeLichessGame(g, account) {
  if (!g || typeof g !== 'object') return null;
  if (g.variant && g.variant !== 'standard') return null;
  const tc = LICHESS_TC[g.speed] || LICHESS_TC[g.perf];
  if (!tc) return null;
  if (['created', 'started', 'aborted', 'noStart', 'unknownFinish'].includes(g.status)) return null;

  const acct = lc(account);
  const wName = g.players?.white?.user?.name || '';
  const bName = g.players?.black?.user?.name || '';
  let color;
  if (lc(wName) === acct || lc(g.players?.white?.user?.id) === acct) color = 'w';
  else if (lc(bName) === acct || lc(g.players?.black?.user?.id) === acct) color = 'b';
  else return null;

  const mine = color === 'w' ? g.players.white : g.players.black;
  const theirs = color === 'w' ? g.players.black : g.players.white;
  const res = g.winner ? (g.winner === (color === 'w' ? 'white' : 'black') ? 1 : 0) : 0.5;

  const moves = typeof g.moves === 'string' ? g.moves.trim() : '';
  const plies = moves ? moves.split(/\s+/).length : 0;
  const clock = g.clock ? `${g.clock.initial}+${g.clock.increment}` : '';
  const opName = theirs?.user?.name || (theirs?.aiLevel ? `Stockfish level ${theirs.aiLevel}` : 'Anonymous');

  const clks = Array.isArray(g.clocks) && g.clocks.length
    ? g.clocks.map((c) => (Number.isFinite(Number(c)) ? Math.round(Number(c) / 100) : null))
    : null;
  const acc = Number.isFinite(Number(mine?.analysis?.accuracy)) ? Number(mine.analysis.accuracy) : null;
  const evals = Array.isArray(g.analysis) && g.analysis.length
    ? g.analysis.map((a) => {
        const o = {};
        if (typeof a?.mate === 'number') o.m = a.mate;
        else if (typeof a?.eval === 'number') o.c = a.eval;
        if (typeof a?.best === 'string' && a.best) o.b = a.best;
        return o;
      })
    : null;

  const rec = {
    id: `li:${g.id}`,
    src: 'lichess',
    acct,
    t: Number(g.createdAt) || 0,
    tc,
    clock,
    rated: Boolean(g.rated),
    color,
    res,
    term: lichessTermination(g.status, res),
    me: Number(mine?.rating) || 0,
    op: opName,
    opR: Number(theirs?.rating) || 0,
    opT: theirs?.user?.title || '',
    eco: g.opening?.eco || '',
    opening: g.opening?.name || '',
    oply: Number(g.opening?.ply) || 0,
    moves,
    plies,
    url: `https://lichess.org/${g.id}${color === 'b' ? '/black' : ''}`,
  };
  if (clks) rec.clks = clks;
  if (acc !== null) rec.acc = acc;
  if (evals) rec.evals = evals;
  return rec;
}

export function lichessTermination(status, res) {
  switch (status) {
    case 'mate':
      return 'mate';
    case 'resign':
      return 'resign';
    case 'outoftime':
      return res === 0.5 ? 'insufficient' : 'time';
    case 'timeout':
      return 'abandon';
    case 'stalemate':
      return 'stalemate';
    case 'draw':
      return 'agreement';
    case 'insufficientMaterialClaim':
      return 'insufficient';
    default:
      return 'other';
  }
}

const CC_DRAW = {
  agreed: 'agreement',
  repetition: 'repetition',
  stalemate: 'stalemate',
  insufficient: 'insufficient',
  '50move': 'fifty',
  timevsinsufficient: 'insufficient',
};
const CC_LOSS = {
  checkmated: 'mate',
  resigned: 'resign',
  timeout: 'time',
  abandoned: 'abandon',
};

/** Chess.com monthly-archive game → record. */
export function normalizeChessComGame(g, account) {
  if (!g || typeof g !== 'object') return null;
  if (g.rules && g.rules !== 'chess') return null;
  const acct = lc(account);
  let color;
  if (lc(g.white?.username) === acct) color = 'w';
  else if (lc(g.black?.username) === acct) color = 'b';
  else return null;
  const mine = color === 'w' ? g.white : g.black;
  const theirs = color === 'w' ? g.black : g.white;

  let res;
  let term;
  if (mine.result === 'win') {
    res = 1;
    term = CC_LOSS[theirs.result] || 'other';
  } else if (CC_DRAW[mine.result]) {
    res = 0.5;
    term = CC_DRAW[mine.result];
  } else {
    res = 0;
    term = CC_LOSS[mine.result] || 'other';
  }

  const parsed = parsePgnGames(g.pgn || '')[0];
  const headers = parsed?.headers || {};
  const sans = parsed?.sans || [];
  if (headers.SetUp === '1' || headers.FEN) return null;

  let tc = CHESSCOM_TC[g.time_class];
  if (!tc) return null;
  let clock = '';
  if (typeof g.time_control === 'string' && /^\d+(\+\d+)?$/.test(g.time_control)) {
    const [base, inc = '0'] = g.time_control.split('+');
    clock = `${base}+${inc}`;
  }
  const t = parseHeaderDateTime(headers.UTCDate || headers.Date, headers.UTCTime || headers.StartTime) ||
    (Number(g.end_time) || 0) * 1000;

  const openingUrl = headers.ECOUrl || (typeof g.eco === 'string' ? g.eco : '');
  const idMatch = String(g.url || '').match(/(\d+)\s*$/);
  const accRaw = g.accuracies?.[color === 'w' ? 'white' : 'black'];
  const acc = Number.isFinite(Number(accRaw)) ? Number(accRaw) : null;
  const rec = {
    id: `cc:${idMatch ? idMatch[1] : g.uuid || `${t}-${theirs.username}`}`,
    src: 'chesscom',
    acct,
    t,
    tc,
    clock,
    rated: g.rated !== false,
    color,
    res,
    term,
    me: Number(mine.rating) || 0,
    op: theirs.username || 'Opponent',
    opR: Number(theirs.rating) || 0,
    opT: '',
    eco: headers.ECO || '',
    opening: openingNameFromChessComUrl(openingUrl),
    oply: 0,
    moves: sans.join(' '),
    plies: sans.length,
    url: g.url || '',
  };
  if (parsed?.clks) rec.clks = parsed.clks;
  if (acc !== null) rec.acc = acc;
  return rec;
}

/** "https://www.chess.com/openings/Sicilian-Defense-Open-2...Nc6" → "Sicilian Defense: Open 2...Nc6" */
export function openingNameFromChessComUrl(url) {
  const m = String(url || '').match(/\/openings\/([^?#]+)/);
  if (!m) return '';
  let slug;
  try {
    slug = decodeURIComponent(m[1]);
  } catch (_) {
    slug = m[1];
  }
  // Drop trailing move sequences such as "-3.Nc3-Nf6-4.Bc4"
  slug = slug.replace(/-\d+\.(\.\.)?.*$/, '');
  const words = slug.split('-').filter(Boolean).map((w) => (w === 'Kings' || w === 'Queens' ? `${w.slice(0, -1)}'s` : w));
  const stop = words.findIndex((w) => /^(Defense|Defence|Opening|Game|Gambit|Attack|System|Countergambit)$/.test(w));
  if (stop >= 0 && stop < words.length - 1) {
    return `${words.slice(0, stop + 1).join(' ')}: ${words.slice(stop + 1).join(' ')}`;
  }
  return words.join(' ');
}

/** Opening family: the part before the first colon ("Sicilian Defense: Najdorf" → "Sicilian Defense"). */
export function openingFamily(name) {
  const s = String(name || '').trim();
  if (!s) return 'Unknown opening';
  return s.split(':')[0].trim();
}

function parseHeaderDateTime(date, time) {
  const d = String(date || '').match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  if (!d) return 0;
  const tm = String(time || '').match(/^(\d{2}):(\d{2}):(\d{2})/);
  return Date.UTC(+d[1], +d[2] - 1, +d[3], tm ? +tm[1] : 12, tm ? +tm[2] : 0, tm ? +tm[3] : 0);
}

/**
 * Split a PGN file into games and extract headers and mainline SAN moves.
 * Comments, variations, NAGs and move numbers are dropped.
 */
export function parsePgnGames(text) {
  const out = [];
  if (typeof text !== 'string' || !text.trim()) return out;
  const src = text.replace(/\r\n?/g, '\n');
  const chunks = src.split(/\n(?=\[Event\s)/);
  for (const chunk of chunks) {
    const headers = {};
    const headerRe = /^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/gm;
    let m;
    let lastHeaderEnd = 0;
    while ((m = headerRe.exec(chunk))) {
      headers[m[1]] = m[2].replace(/\\"/g, '"');
      lastHeaderEnd = headerRe.lastIndex;
    }
    const movetext = chunk.slice(lastHeaderEnd);
    const { sans, clks } = extractMovesAndClocks(movetext);
    if (!Object.keys(headers).length && !sans.length) continue;
    const item = { headers, sans };
    if (clks) item.clks = clks;
    out.push(item);
  }
  return out;
}

function parseClkTag(comment) {
  const m = comment.match(/\[%clk\s+(\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?\]/);
  if (!m) return null;
  if (m[3] !== undefined) {
    return Math.round(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
  }
  return Math.round(Number(m[1]) * 60 + Number(m[2]));
}

function extractMovesAndClocks(movetext) {
  const sans = [];
  const clks = [];
  let hasClk = false;
  let token = '';
  let depth = 0;
  let inBrace = false;
  let braceBuf = '';

  const flushToken = () => {
    if (!token) return;
    const cleaned = token.replace(/^\d+\.+/, '').replace(/[!?]+$/, '');
    token = '';
    if (
      cleaned &&
      !/^\$\d+$/.test(cleaned) &&
      !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(cleaned) &&
      !/^\d+\.+$/.test(cleaned)
    ) {
      sans.push(cleaned);
      clks.push(null);
    }
  };

  for (let i = 0; i < movetext.length; i++) {
    const c = movetext[i];
    if (inBrace) {
      if (c === '}') {
        inBrace = false;
        if (depth === 0 && sans.length > 0) {
          const sec = parseClkTag(braceBuf);
          if (sec !== null) {
            clks[sans.length - 1] = sec;
            hasClk = true;
          }
        }
        braceBuf = '';
      } else if (depth === 0) {
        braceBuf += c;
      }
      continue;
    }
    if (c === '{') {
      flushToken();
      inBrace = true;
      braceBuf = '';
      continue;
    }
    if (c === ';') {
      flushToken();
      const nl = movetext.indexOf('\n', i);
      i = nl === -1 ? movetext.length : nl;
      continue;
    }
    if (c === '(') {
      flushToken();
      depth++;
      continue;
    }
    if (c === ')') {
      flushToken();
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) {
      if (/\s/.test(c)) flushToken();
      else token += c;
    }
  }
  flushToken();
  return { sans, clks: hasClk ? clks : null };
}

/** Most frequent player name across PGN games (the likely owner of an uploaded file). */
export function guessPgnOwner(games) {
  const counts = new Map();
  for (const g of games) {
    for (const n of [g.headers.White, g.headers.Black]) {
      if (!n || n === '?') continue;
      counts.set(n, (counts.get(n) || 0) + 1);
    }
  }
  let best = '';
  let bestN = 0;
  for (const [n, c] of counts) {
    if (c > bestN) {
      best = n;
      bestN = c;
    }
  }
  return best;
}

function hashString(str) {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h1 ^= str.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  return (h1 >>> 0).toString(36);
}

/** PGN game (from parsePgnGames) → record for the named owner, or null. */
export function normalizePgnGame(game, owner) {
  const h = game.headers || {};
  if (h.SetUp === '1' || h.FEN) return null;
  if (h.Variant && !/^standard$/i.test(h.Variant)) return null;
  const o = lc(owner);
  let color;
  if (lc(h.White) === o) color = 'w';
  else if (lc(h.Black) === o) color = 'b';
  else return null;
  const r = h.Result;
  if (r !== '1-0' && r !== '0-1' && r !== '1/2-1/2') return null;
  const res = r === '1/2-1/2' ? 0.5 : (r === '1-0') === (color === 'w') ? 1 : 0;

  let tc = 'classical';
  let clock = '';
  const tcm = String(h.TimeControl || '').match(/^(\d+)(?:\+(\d+))?$/);
  if (tcm) {
    clock = `${tcm[1]}+${tcm[2] || 0}`;
    tc = classifyClock(+tcm[1], +(tcm[2] || 0));
  } else if (/^\d+\/\d+/.test(h.TimeControl || '') || h.TimeControl === '-') {
    tc = h.TimeControl === '-' ? 'daily' : 'classical';
  }

  const term = /time/i.test(h.Termination || '')
    ? res === 0.5
      ? 'insufficient'
      : 'time'
    : /abandon/i.test(h.Termination || '')
      ? 'abandon'
      : res === 0.5
        ? 'agreement'
        : /mate/i.test(game.sans[game.sans.length - 1] || '') || (game.sans[game.sans.length - 1] || '').endsWith('#')
          ? 'mate'
          : 'resign';

  const t = parseHeaderDateTime(h.UTCDate || h.Date, h.UTCTime || h.Time) || 0;
  const moves = game.sans.join(' ');
  const site = /^https?:\/\//.test(h.Site || '') ? h.Site : '';
  const rec = {
    id: `pgn:${hashString(`${h.White}|${h.Black}|${h.Date}|${h.Round}|${moves}`)}`,
    src: 'pgn',
    acct: o,
    t,
    tc,
    clock,
    rated: h.Rated !== 'false',
    color,
    res,
    term,
    me: Number(color === 'w' ? h.WhiteElo : h.BlackElo) || 0,
    op: (color === 'w' ? h.Black : h.White) || 'Opponent',
    opR: Number(color === 'w' ? h.BlackElo : h.WhiteElo) || 0,
    opT: (color === 'w' ? h.BlackTitle : h.WhiteTitle) || '',
    eco: h.ECO || '',
    opening: h.Opening || '',
    oply: 0,
    moves,
    plies: game.sans.length,
    url: site,
  };
  if (game.clks) rec.clks = game.clks;
  return rec;
}
