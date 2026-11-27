import { Chess } from 'chess.js';
import { START_FEN, normalizeFen } from '../state.js';

const MAX_LINES_PER_IMPORT = 400;
const MAX_PLY_DEPTH = 60;

/**
 * Deterministic 32-bit FNV-1a hex hash for stable card IDs across re-imports and merges.
 */
function stableHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function makeCardId(color, normFen, uci) {
  return `c_${color}_${stableHash(`${color}|${normFen}|${uci}`)}`;
}

/**
 * Strip Lichess/ChessBase annotation commands (`[%cal ...]`, `[%csl ...]`, `[%clk ...]`, `[%eval ...]`)
 * from PGN brace comments while keeping human notes clean.
 */
export function cleanPgnComment(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/\[%[a-zA-Z]+[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split a multi-chapter PGN string (such as a Lichess Study export) into individual PGN chunks.
 */
export function splitPgnChapters(pgnText) {
  if (typeof pgnText !== 'string' || !pgnText.trim()) return [];
  const normalized = pgnText.replace(/\r\n/g, '\n').trim();
  const lines = normalized.split('\n');
  const chapters = [];
  let current = [];
  let sawMovetext = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isHeader = /^\[[A-Za-z0-9_]+\s+"[^"]*"\]$/.test(trimmed);
    if (isHeader && sawMovetext) {
      const chunk = current.join('\n').trim();
      if (chunk) chapters.push(chunk);
      current = [line];
      sawMovetext = false;
    } else {
      current.push(line);
      if (trimmed && !isHeader) sawMovetext = true;
    }
  }
  const tail = current.join('\n').trim();
  if (tail) chapters.push(tail);
  return chapters;
}

function parsePgnHeaders(chunk) {
  const headers = {};
  const re = /^\s*\[([A-Za-z0-9_]+)\s+"([^"]*)"\]\s*$/gm;
  let m;
  while ((m = re.exec(chunk)) !== null) {
    headers[m[1]] = m[2];
  }
  const movetext = chunk.replace(/^\s*\[[A-Za-z0-9_]+\s+"[^"]*"\]\s*$/gm, '').trim();
  return { headers, movetext };
}

/**
 * Tokenize PGN movetext preserving nested RAV parentheses `(` `)`, brace comments `{...}`,
 * line comments `;...`, and NAGs (`$1`..`$255`).
 */
function tokenizePgnMovetext(movetext) {
  const tokens = [];
  let i = 0;
  const len = movetext.length;
  while (i < len) {
    const ch = movetext[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '{') {
      const end = movetext.indexOf('}', i + 1);
      const raw = end === -1 ? movetext.slice(i + 1) : movetext.slice(i + 1, end);
      tokens.push({ type: 'comment', value: cleanPgnComment(raw) });
      i = end === -1 ? len : end + 1;
      continue;
    }
    if (ch === ';') {
      const end = movetext.indexOf('\n', i + 1);
      const raw = end === -1 ? movetext.slice(i + 1) : movetext.slice(i + 1, end);
      tokens.push({ type: 'comment', value: cleanPgnComment(raw) });
      i = end === -1 ? len : end + 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen' });
      i++;
      continue;
    }
    let j = i;
    while (j < len && !/[\s{}();]/.test(movetext[j])) j++;
    const word = movetext.slice(i, j);
    i = j;

    if (word === '1-0' || word === '0-1' || word === '1/2-1/2' || word === '*') {
      tokens.push({ type: 'result', value: word });
    } else if (/^\$\d+$/.test(word)) {
      tokens.push({ type: 'nag', value: word });
    } else if (/^\d+\.+$/.test(word)) {
      // Pure move number token like "1." or "12..."
      continue;
    } else {
      // Strip leading move number glued to SAN (e.g. "1.e4" or "12...Nf6") and trailing ?!/!? annotations
      const cleaned = word.replace(/^\d+\.+/, '').replace(/[!?]+$/, '');
      if (cleaned) tokens.push({ type: 'san', value: cleaned });
    }
  }
  return tokens;
}

/**
 * Parse tokenized movetext into a branching node tree starting from `startFen`.
 */
function parseBranchTree(tokens, startFen = START_FEN) {
  let rootChess;
  try {
    rootChess = new Chess(startFen);
  } catch (_) {
    return null;
  }

  const root = {
    fen: rootChess.fen(),
    san: '',
    uci: '',
    color: '',
    comment: '',
    isAlt: false,
    children: [],
  };

  let idx = 0;

  function parseSequence(startNode, isRav) {
    let cur = startNode;
    let prev = startNode;
    let firstInSeq = true;

    while (idx < tokens.length) {
      const tok = tokens[idx];
      if (tok.type === 'rparen') {
        idx++;
        return;
      }
      if (tok.type === 'lparen') {
        idx++;
        // RAV branches off `prev` (the position before the move that was just played)
        parseSequence(prev, true);
        continue;
      }
      if (tok.type === 'comment') {
        idx++;
        if (tok.value) {
          cur.comment = cur.comment ? `${cur.comment} ${tok.value}` : tok.value;
        }
        continue;
      }
      if (tok.type === 'nag' || tok.type === 'result') {
        idx++;
        continue;
      }
      if (tok.type === 'san') {
        idx++;
        const chess = new Chess(cur.fen);
        let move = null;
        try {
          move = chess.move(tok.value);
        } catch (_) {
          // Ignore malformed token gracefully
        }
        if (!move) continue;
        const uci = move.from + move.to + (move.promotion || '');
        const existing = cur.children.find((c) => c.uci === uci);
        prev = cur;
        if (existing) {
          cur = existing;
        } else {
          const child = {
            fen: chess.fen(),
            san: move.san,
            uci,
            color: move.color,
            comment: '',
            isAlt: isRav && firstInSeq && cur.children.length > 0,
            children: [],
          };
          cur.children.push(child);
          cur = child;
        }
        firstInSeq = false;
      }
    }
  }

  parseSequence(root, false);
  return root;
}

/**
 * Flatten a parsed PGN tree into root-to-leaf branches (capped at MAX_LINES_PER_IMPORT).
 */
function extractBranchesFromTree(root, maxLines = MAX_LINES_PER_IMPORT) {
  const branches = [];

  function dfs(node, path, hasAlt) {
    if (branches.length >= maxLines) return;
    if (!node.children.length || path.length >= MAX_PLY_DEPTH) {
      if (path.length) {
        branches.push({ moves: path, alt: hasAlt });
      }
      return;
    }
    for (let i = 0; i < node.children.length; i++) {
      const ch = node.children[i];
      dfs(
        ch,
        [
          ...path,
          {
            san: ch.san,
            uci: ch.uci,
            fen: ch.fen,
            color: ch.color,
            comment: ch.comment || '',
            isAlt: ch.isAlt || i > 0,
          },
        ],
        hasAlt || i > 0
      );
      if (branches.length >= maxLines) return;
    }
  }

  dfs(root, [], false);
  return branches;
}

function detectChapterColor(headers, fallbackColor) {
  const orient = (headers.Orientation || headers.RepertoireColor || '').toLowerCase();
  if (orient === 'black' || orient === 'b') return 'b';
  if (orient === 'white' || orient === 'w') return 'w';
  return fallbackColor === 'b' ? 'b' : 'w';
}

function cleanChapterTitle(headers, fallbackIdx) {
  const raw =
    headers.ChapterName ||
    headers.Opening ||
    headers.Event ||
    (headers.White && headers.Black && headers.White !== '?' && headers.Black !== '?'
      ? `${headers.White} – ${headers.Black}`
      : '') ||
    `Opening ${fallbackIdx + 1}`;
  // Strip common Lichess Study prefix "Study Name: Chapter Name" -> keep concise part
  const colonIdx = raw.indexOf(': ');
  const cleaned = colonIdx > 0 && raw.length - colonIdx > 4 ? raw.slice(colonIdx + 2) : raw;
  return cleaned.trim().slice(0, 60) || `Opening ${fallbackIdx + 1}`;
}

function makeSectionCode(index) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (index < 26) return letters[index];
  return `S${index + 1}`;
}

/**
 * Build a valid `tichess-repertoire` v1 object from a list of structured section specs:
 * `[{ name, color, startFen, lines: [{ name, note, alt, moves: [{ san, uci, fen, color, comment }] }] }]`
 */
export function compileRepertoireFromSections(sectionSpecs) {
  const pos = [];
  const posKeyToIdx = new Map();
  const cards = {};
  const theory = [{ ev: null, name: '', alts: [] }];
  const theoryKeyToIdx = new Map([['', 0]]);
  const lines = [];
  const secs = [];
  const warn = {};

  function getTheoryIdx(openingName) {
    const key = (openingName || '').trim();
    if (theoryKeyToIdx.has(key)) return theoryKeyToIdx.get(key);
    const idx = theory.length;
    theory.push({ ev: null, name: key, alts: [] });
    theoryKeyToIdx.set(key, idx);
    return idx;
  }

  function ensurePos(color, fen, openingName) {
    const norm = normalizeFen(fen);
    const key = `${color}|${norm}`;
    if (posKeyToIdx.has(key)) return posKeyToIdx.get(key);
    const idx = pos.length;
    pos.push({
      f: fen,
      t: getTheoryIdx(openingName),
      e: [],
    });
    posKeyToIdx.set(key, idx);
    return idx;
  }

  for (let sIdx = 0; sIdx < sectionSpecs.length; sIdx++) {
    const spec = sectionSpecs[sIdx];
    const color = spec.color === 'b' ? 'b' : 'w';
    const secId = spec.id || makeSectionCode(sIdx);
    const secName = (spec.name || `Opening ${sIdx + 1}`).trim().slice(0, 60);
    const startFen = spec.startFen || START_FEN;
    const secLineIndices = [];

    for (let bIdx = 0; bIdx < spec.lines.length; bIdx++) {
      const br = spec.lines[bIdx];
      if (!br.moves || !br.moves.length) continue;

      const lineIdx = lines.length;
      const linePos = [ensurePos(color, startFen, secName)];
      const lineSan = [];
      const lineUci = [];
      let lineNote = br.note || '';

      let prevFen = startFen;
      for (let p = 0; p < br.moves.length; p++) {
        const mv = br.moves[p];
        const fromPi = linePos[p];
        const toPi = ensurePos(color, mv.fen, secName);
        const turn = prevFen.split(' ')[1] === 'b' ? 'b' : 'w';
        const mine = turn === color;
        const isAlt = Boolean(mv.isAlt && mine);
        const flags = (mine ? 1 : 0) | (isAlt ? 2 : 0);

        let cardId = 0;
        if (mine) {
          cardId = makeCardId(color, normalizeFen(prevFen), mv.uci);
          if (!cards[cardId]) {
            cards[cardId] = {
              p: fromPi,
              u: mv.uci,
              s: mv.san,
              n: mv.comment || '',
            };
          } else if (mv.comment && !cards[cardId].n) {
            cards[cardId].n = mv.comment;
          }
        }
        if (!lineNote && mv.comment) lineNote = mv.comment;

        let edge = pos[fromPi].e.find((e) => e[0] === mv.uci);
        if (!edge) {
          edge = cardId
            ? [mv.uci, mv.san, toPi, flags, [lineIdx], cardId]
            : [mv.uci, mv.san, toPi, flags, [lineIdx]];
          pos[fromPi].e.push(edge);
        } else {
          if (!edge[4].includes(lineIdx)) edge[4].push(lineIdx);
          if (mine && !(edge[3] & 1)) edge[3] |= 1;
          if (cardId && !edge[5]) edge[5] = cardId;
        }

        linePos.push(toPi);
        lineSan.push(mv.san);
        lineUci.push(mv.uci);
        prevFen = mv.fen;
      }

      const derivedName =
        br.name ||
        (bIdx === 0
          ? `${secName} · Main Line`
          : `${secName} · Line ${bIdx + 1}`);

      lines.push({
        id: `${secId}${bIdx + 1}`,
        name: derivedName.slice(0, 72),
        sec: secId,
        color,
        ev: '',
        note: lineNote,
        san: lineSan,
        uci: lineUci,
        pos: linePos,
        alt: Boolean(br.alt),
      });
      secLineIndices.push(lineIdx);
    }

    if (!secLineIndices.length) continue;

    // Compute longest common move prefix among lines in this section (keep at least 1 move ahead)
    const firstLn = lines[secLineIndices[0]];
    let commonPly = 0;
    if (secLineIndices.length > 1) {
      const minLen = Math.min(...secLineIndices.map((li) => lines[li].uci.length));
      while (
        commonPly < minLen - 1 &&
        secLineIndices.every((li) => lines[li].uci[commonPly] === firstLn.uci[commonPly])
      ) {
        commonPly++;
      }
    }

    const firstMoveSan = firstLn.san[0] || '';
    secs.push({
      id: secId,
      name: secName,
      group: `${color === 'w' ? 'White' : 'Black'}${firstMoveSan ? ` · 1.${firstMoveSan}` : ''}`,
      color,
      start: firstLn.pos[commonPly],
      startPly: commonPly,
      lines: secLineIndices,
    });
  }

  const roots = {};
  const wRoot = posKeyToIdx.get(`w|${normalizeFen(START_FEN)}`);
  const bRoot = posKeyToIdx.get(`b|${normalizeFen(START_FEN)}`);
  if (wRoot !== undefined) roots.w = wRoot;
  if (bRoot !== undefined) roots.b = bRoot;

  return { secs, lines, pos, cards, warn, theory, roots };
}

/**
 * Import a PGN or multi-chapter Lichess Study PGN into a valid `tichess-repertoire` object.
 */
export function buildRepertoireFromPgn(
  pgnText,
  { color = 'w', name = '', sectionName = '' } = {}
) {
  if (typeof pgnText !== 'string' || !pgnText.trim()) {
    return { ok: false, error: 'PGN text is empty.' };
  }

  const chapters = splitPgnChapters(pgnText);
  if (!chapters.length) {
    return { ok: false, error: 'No PGN games or chapters found.' };
  }

  const sectionSpecs = [];
  let totalBranches = 0;
  let derivedRepName = name.trim();

  for (let i = 0; i < chapters.length; i++) {
    const { headers, movetext } = parsePgnHeaders(chapters[i]);
    if (!movetext) continue;
    const startFen = headers.FEN || START_FEN;
    const tokens = tokenizePgnMovetext(movetext);
    const tree = parseBranchTree(tokens, startFen);
    if (!tree || !tree.children.length) continue;

    const remaining = Math.max(1, MAX_LINES_PER_IMPORT - totalBranches);
    const branches = extractBranchesFromTree(tree, remaining);
    if (!branches.length) continue;

    totalBranches += branches.length;
    const chapColor = detectChapterColor(headers, color);
    const chapName =
      (chapters.length === 1 && sectionName.trim()) || cleanChapterTitle(headers, i);

    if (!derivedRepName) {
      const ev = headers.Event || '';
      const studyPrefix = ev.includes(': ') ? ev.split(': ')[0].trim() : ev.trim();
      derivedRepName = studyPrefix && studyPrefix !== '?' ? studyPrefix : chapName;
    }

    sectionSpecs.push({
      name: chapName,
      color: chapColor,
      startFen: tree.fen,
      lines: branches.map((br, bIdx) => ({
        name:
          bIdx === 0
            ? `${chapName} · Main`
            : `${chapName} · Var ${bIdx}`,
        note: tree.comment || '',
        alt: br.alt,
        moves: br.moves,
      })),
    });

    if (totalBranches >= MAX_LINES_PER_IMPORT) break;
  }

  if (!sectionSpecs.length) {
    return { ok: false, error: 'No legal moves were found in the PGN.' };
  }

  const repertoire = compileRepertoireFromSections(sectionSpecs);
  if (!repertoire.lines.length || !repertoire.secs.length) {
    return { ok: false, error: 'Could not build any repertoire lines from the PGN.' };
  }

  return {
    ok: true,
    repertoire,
    name: (derivedRepName || 'PGN Repertoire').slice(0, 60),
    stats: {
      sections: repertoire.secs.length,
      lines: repertoire.lines.length,
      cards: Object.keys(repertoire.cards).length,
    },
  };
}

/**
 * Merge `incoming` repertoire into `existing` repertoire, preserving all existing sections,
 * lines, warnings, notes, and card IDs (so SRS review progress stays intact).
 */
export function mergeRepertoires(existing, incoming, { refreshNotes = false } = {}) {
  if (!existing || !existing.pos?.length || !existing.lines?.length) {
    return structuredClone(incoming);
  }
  if (!incoming || !incoming.pos?.length || !incoming.lines?.length) {
    return structuredClone(existing);
  }

  const out = structuredClone(existing);
  out.warn = out.warn || {};
  out.theory = out.theory || [{ ev: null, name: '', alts: [] }];
  out.roots = out.roots || {};

  // Map existing positions by (color|normFen) inferred from existing lines so we merge cleanly
  const posKeyToIdx = new Map();
  for (const ln of out.lines) {
    for (const pi of ln.pos) {
      const f = out.pos[pi]?.f;
      if (f) {
        const key = `${ln.color}|${normalizeFen(f)}`;
        if (!posKeyToIdx.has(key)) posKeyToIdx.set(key, pi);
      }
    }
  }

  const theoryNameToIdx = new Map();
  out.theory.forEach((t, idx) => {
    const hasEngine = Boolean(
      t && ((t.ev !== null && t.ev !== undefined) || (Array.isArray(t.alts) && t.alts.length))
    );
    const k = (t?.name || '').trim();
    if (!hasEngine && !theoryNameToIdx.has(k)) theoryNameToIdx.set(k, idx);
  });

  function hasTheoryEngine(t) {
    return Boolean(
      t && ((t.ev !== null && t.ev !== undefined) || (Array.isArray(t.alts) && t.alts.length))
    );
  }

  function mapTheory(inTheoryIdx) {
    const t = incoming.theory?.[inTheoryIdx];
    const nameKey = (t?.name || '').trim();
    const withEngine = hasTheoryEngine(t);
    if (!withEngine && theoryNameToIdx.has(nameKey)) return theoryNameToIdx.get(nameKey);
    const idx = out.theory.length;
    out.theory.push(t ? structuredClone(t) : { ev: null, name: nameKey, alts: [] });
    if (!withEngine) theoryNameToIdx.set(nameKey, idx);
    return idx;
  }

  const inToOutPos = new Map();

  function ensureOutPos(color, inPi) {
    const src = incoming.pos[inPi];
    const key = `${color}|${normalizeFen(src.f)}`;
    if (posKeyToIdx.has(key)) {
      const existingIdx = posKeyToIdx.get(key);
      inToOutPos.set(inPi, existingIdx);
      const inTh = incoming.theory?.[src.t];
      const curTh = out.theory?.[out.pos[existingIdx]?.t];
      if (hasTheoryEngine(inTh) && !hasTheoryEngine(curTh)) {
        out.pos[existingIdx].t = mapTheory(src.t);
      }
      return existingIdx;
    }
    const idx = out.pos.length;
    out.pos.push({
      f: src.f,
      t: mapTheory(src.t),
      e: [],
    });
    posKeyToIdx.set(key, idx);
    inToOutPos.set(inPi, idx);
    return idx;
  }

  const existingSecByNameColor = new Map();
  const usedSecIds = new Set();
  for (const s of out.secs) {
    usedSecIds.add(s.id);
    existingSecByNameColor.set(`${s.color}|${s.name.trim().toLowerCase()}`, s);
  }

  function nextUniqueSecId(preferred) {
    if (preferred && !usedSecIds.has(preferred)) {
      usedSecIds.add(preferred);
      return preferred;
    }
    let idx = out.secs.length;
    while (true) {
      const cand = makeSectionCode(idx++);
      if (!usedSecIds.has(cand)) {
        usedSecIds.add(cand);
        return cand;
      }
    }
  }

  const existingLineSigs = new Set(
    out.lines.map((ln) => `${ln.color}|${normalizeFen(out.pos[ln.pos[0]]?.f || START_FEN)}|${ln.uci.join(' ')}`)
  );

  for (const inSec of incoming.secs) {
    const matchKey = `${inSec.color}|${inSec.name.trim().toLowerCase()}`;
    let targetSec = existingSecByNameColor.get(matchKey);

    const addedLineIndices = [];
    for (const inLi of inSec.lines) {
      const inLn = incoming.lines[inLi];
      if (!inLn || !inLn.uci.length) continue;

      const startFen = incoming.pos[inLn.pos[0]]?.f || START_FEN;
      const sig = `${inLn.color}|${normalizeFen(startFen)}|${inLn.uci.join(' ')}`;
      if (existingLineSigs.has(sig)) {
        if (refreshNotes) {
          for (let p = 0; p < inLn.uci.length; p++) {
            const inFrom = inLn.pos[p];
            const outFrom = ensureOutPos(inLn.color, inFrom);
            const uci = inLn.uci[p];
            const inEdge = incoming.pos[inFrom]?.e?.find((e) => e[0] === uci);
            const inCardId = inEdge?.[5];
            const outEdge = out.pos[outFrom]?.e?.find((e) => e[0] === uci);
            if (inCardId && incoming.cards?.[inCardId]?.n && outEdge?.[5] && out.cards[outEdge[5]]) {
              out.cards[outEdge[5]].n = incoming.cards[inCardId].n;
            }
          }
        }
        continue;
      }
      existingLineSigs.add(sig);

      const outPosIndices = inLn.pos.map((pi) => ensureOutPos(inLn.color, pi));
      const newLineIdx = out.lines.length;

      for (let p = 0; p < inLn.uci.length; p++) {
        const inFrom = inLn.pos[p];
        const outFrom = outPosIndices[p];
        const outTo = outPosIndices[p + 1];
        const uci = inLn.uci[p];
        const san = inLn.san[p];
        const inEdge = incoming.pos[inFrom].e.find((e) => e[0] === uci);
        const flags = inEdge ? inEdge[3] : 0;
        const inCardId = inEdge?.[5];

        let outCardId = 0;
        if (inCardId && incoming.cards?.[inCardId]) {
          // Reuse existing card if an edge already exists at (outFrom, uci) with a card
          const existingEdge = out.pos[outFrom].e.find((e) => e[0] === uci);
          if (existingEdge?.[5] && out.cards[existingEdge[5]]) {
            outCardId = existingEdge[5];
            if (incoming.cards[inCardId].n && (refreshNotes || !out.cards[outCardId].n)) {
              out.cards[outCardId].n = incoming.cards[inCardId].n;
            }
          } else {
            outCardId = out.cards[inCardId] ? makeCardId(inLn.color, normalizeFen(out.pos[outFrom].f), uci) : inCardId;
            if (!out.cards[outCardId]) {
              out.cards[outCardId] = {
                p: outFrom,
                u: uci,
                s: san,
                n: incoming.cards[inCardId].n || '',
              };
            }
          }
        }

        const inWarn = incoming.warn?.[`${inFrom}|${uci}`];
        if (inWarn && (refreshNotes || !out.warn[`${outFrom}|${uci}`])) {
          out.warn[`${outFrom}|${uci}`] = inWarn;
        }

        let outEdge = out.pos[outFrom].e.find((e) => e[0] === uci);
        if (!outEdge) {
          outEdge = outCardId
            ? [uci, san, outTo, flags, [newLineIdx], outCardId]
            : [uci, san, outTo, flags, [newLineIdx]];
          out.pos[outFrom].e.push(outEdge);
        } else {
          if (!outEdge[4].includes(newLineIdx)) outEdge[4].push(newLineIdx);
          if (flags & 1) outEdge[3] |= 1;
          if (outCardId && !outEdge[5]) outEdge[5] = outCardId;
        }
      }

      const secId = targetSec ? targetSec.id : nextUniqueSecId(inSec.id);
      if (!targetSec) {
        targetSec = {
          id: secId,
          name: inSec.name,
          group: inSec.group || (inSec.color === 'w' ? 'White' : 'Black'),
          color: inSec.color,
          start: outPosIndices[Math.min(inSec.startPly || 0, outPosIndices.length - 1)],
          startPly: Math.min(inSec.startPly || 0, inLn.uci.length),
          lines: [],
        };
        out.secs.push(targetSec);
        existingSecByNameColor.set(matchKey, targetSec);
      }

      const lineNum = targetSec.lines.length + 1;
      out.lines.push({
        id: `${targetSec.id}${lineNum}`,
        name: inLn.name,
        sec: targetSec.id,
        color: inLn.color,
        ev: inLn.ev || '',
        note: inLn.note || '',
        san: [...inLn.san],
        uci: [...inLn.uci],
        pos: outPosIndices,
        alt: Boolean(inLn.alt),
      });
      targetSec.lines.push(newLineIdx);
      addedLineIndices.push(newLineIdx);
    }

    // If we appended lines to an existing section whose startPly doesn't match the new line's prefix,
    // adjust startPly safely down to the common prefix so Study view stays valid.
    if (targetSec && addedLineIndices.length) {
      const firstLn = out.lines[targetSec.lines[0]];
      let ply = targetSec.startPly || 0;
      while (
        ply > 0 &&
        !targetSec.lines.every(
          (li) => out.lines[li].uci.length >= ply && out.lines[li].uci[ply - 1] === firstLn.uci[ply - 1]
        )
      ) {
        ply--;
      }
      targetSec.startPly = ply;
      targetSec.start = firstLn.pos[ply];
    }
  }

  for (const [warnKey, warnMsg] of Object.entries(incoming.warn || {})) {
    const sep = warnKey.indexOf('|');
    if (sep <= 0) continue;
    const inPi = Number(warnKey.slice(0, sep));
    const uci = warnKey.slice(sep + 1);
    const outPi = inToOutPos.get(inPi);
    if (outPi !== undefined && uci && (refreshNotes || !out.warn[`${outPi}|${uci}`])) {
      out.warn[`${outPi}|${uci}`] = warnMsg;
    }
  }

  return out;
}

/**
 * Extract the current move path from `root` to `currentNode` on the main analysis board.
 */
export function extractPathToNode(currentNode) {
  const path = [];
  let cur = currentNode;
  while (cur && cur.parent) {
    path.unshift({
      san: cur.san,
      uci: cur.uci,
      fen: cur.fen,
      color: cur.color,
      comment: cur.comment || '',
    });
    cur = cur.parent;
  }
  const startFen = cur?.fen || START_FEN;
  return { startFen, moves: path };
}

/**
 * Append a line played on the main analysis board into an existing repertoire (or create one).
 */
export function appendBoardLineToRepertoire(
  existingRep,
  { startFen = START_FEN, moves, color = 'w', sectionName = 'Custom Lines', lineName = '', note = '' }
) {
  if (!Array.isArray(moves) || !moves.length) {
    return { ok: false, error: 'Play at least one move on the board before saving a line.' };
  }
  const cleanSection = (sectionName || 'Custom Lines').trim().slice(0, 60) || 'Custom Lines';
  const defaultLineName =
    lineName.trim() ||
    moves
      .slice(0, 6)
      .map((m, i) => (i % 2 === 0 ? `${Math.floor(i / 2) + 1}.${m.san}` : m.san))
      .join(' ');

  const snippet = compileRepertoireFromSections([
    {
      name: cleanSection,
      color: color === 'b' ? 'b' : 'w',
      startFen,
      lines: [
        {
          name: defaultLineName,
          note: note.trim(),
          alt: false,
          moves,
        },
      ],
    },
  ]);

  const merged = existingRep ? mergeRepertoires(existingRep, snippet) : snippet;
  return {
    ok: true,
    repertoire: merged,
    sectionName: cleanSection,
    lineName: defaultLineName,
  };
}
