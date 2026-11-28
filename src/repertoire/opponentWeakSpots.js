/**
 * Find a scouted opponent's opening weak spots: moves they keep choosing in the
 * opening and score badly with. Each spot can be turned into prep with the
 * existing repertoire generator ("vs opponent move" mode).
 *
 * Works on the scout position index (IndexedDB `positions` store), whose entries
 * look like { uci, san, res: 'w'|'b'|'d', pColor: 'white'|'black'|'both', gid }.
 */
import { Chess } from 'chess.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function defaultNormalize(fen) {
  return String(fen || '').split(' ').slice(0, 4).join(' ');
}

/**
 * Group one position's entries by move.
 * Returns [{ uci, san, n, playerN, playerScore }] where playerN/playerScore count
 * only games where the scouted player made this move.
 */
export function groupPositionMoves(entries, sideToMove) {
  const playerColor = sideToMove === 'w' ? 'white' : 'black';
  const map = new Map();
  for (const e of entries || []) {
    if (!e || typeof e.uci !== 'string') continue;
    let g = map.get(e.uci);
    if (!g) {
      g = { uci: e.uci, san: String(e.san || e.uci), n: 0, playerN: 0, playerPts: 0 };
      map.set(e.uci, g);
    }
    g.n++;
    if (e.pColor === playerColor) {
      g.playerN++;
      if (e.res === 'd') g.playerPts += 0.5;
      else if (e.res === sideToMove) g.playerPts += 1;
    }
  }
  return [...map.values()].map((g) => ({
    uci: g.uci,
    san: g.san,
    n: g.n,
    playerN: g.playerN,
    playerScore: g.playerN ? g.playerPts / g.playerN : null,
  }));
}

/**
 * Walk the opponent's opening tree breadth-first and collect their weak moves.
 *
 * @param lookupBatch async (normFens: string[]) => Map<normFen, entries[]>
 * @returns Promise<Array<{ pathSans, pathUcis, fen, moveSan, moveUci, games, scorePct, theirColor, myColor, ply }>>
 */
export async function findOpponentWeakSpots({
  lookupBatch,
  normalize = defaultNormalize,
  startFen = START_FEN,
  maxPlies = 16,
  minGames = 3,
  maxScorePct = 40,
  maxNodes = 600,
  maxSpots = 8,
  signal = null,
} = {}) {
  if (typeof lookupBatch !== 'function') return [];
  let frontier = [{ fen: startFen, sans: [], ucis: [], underWeak: false }];
  const seen = new Set([normalize(startFen)]);
  const spots = [];
  let nodes = 1;

  for (let ply = 0; ply < maxPlies && frontier.length; ply++) {
    if (signal?.aborted) break;
    const keys = frontier.map((f) => normalize(f.fen));
    const found = await lookupBatch(keys);
    const next = [];
    for (let i = 0; i < frontier.length; i++) {
      const node = frontier[i];
      const entries = found?.get?.(keys[i]);
      if (!entries?.length) continue;
      const turn = node.fen.split(' ')[1] === 'b' ? 'b' : 'w';
      const groups = groupPositionMoves(entries, turn);
      for (const g of groups) {
        if (g.n < minGames) continue;
        const weak = g.playerN >= minGames && g.playerScore !== null && g.playerScore * 100 <= maxScorePct;
        // Report only the first weak move on a line: what follows it is the same games.
        if (weak && !node.underWeak) {
          spots.push({
            pathSans: node.sans,
            pathUcis: node.ucis,
            fen: node.fen,
            moveSan: g.san,
            moveUci: g.uci,
            games: g.playerN,
            scorePct: Math.round(g.playerScore * 100),
            theirColor: turn,
            myColor: turn === 'w' ? 'b' : 'w',
            ply,
          });
        }
        if (nodes >= maxNodes) continue;
        let chess;
        try {
          chess = new Chess(node.fen);
          const mv = chess.move({ from: g.uci.slice(0, 2), to: g.uci.slice(2, 4), promotion: g.uci[4] || undefined });
          if (!mv) continue;
        } catch (_) {
          continue;
        }
        const childFen = chess.fen();
        const key = normalize(childFen);
        if (seen.has(key)) continue;
        seen.add(key);
        nodes++;
        next.push({ fen: childFen, sans: [...node.sans, g.san], ucis: [...node.ucis, g.uci], underWeak: node.underWeak || weak });
      }
    }
    frontier = next;
  }

  spots.sort((a, b) => a.scorePct - b.scorePct || b.games - a.games || a.ply - b.ply);
  return spots.slice(0, maxSpots);
}

/** "1.e4 c5 2.Nf3 d6" style label for a SAN path. */
export function sanPathLabel(sans) {
  if (!sans?.length) return 'Start';
  return sans.map((s, i) => (i % 2 === 0 ? `${Math.floor(i / 2) + 1}.${s}` : s)).join(' ');
}

/** "6...e5" style label for the move at `ply` (0-based). */
export function plyMoveLabel(ply, san) {
  const num = Math.floor(ply / 2) + 1;
  return ply % 2 === 0 ? `${num}.${san}` : `${num}...${san}`;
}
