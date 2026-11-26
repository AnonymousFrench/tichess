import { normalizeFen } from '../state.js';
import { cardStatus } from './model.js';

export const PREP_DRILL_STORAGE_KEY = 'tichess-rep-prep-drill';

function formatPrefixSan(sanList) {
  if (!Array.isArray(sanList) || !sanList.length) return 'Start';
  return sanList
    .map((s, idx) => (idx % 2 === 0 ? `${Math.floor(idx / 2) + 1}.${s}` : s))
    .join(' ');
}

function buildLinePgnWithMove(prefixSan, extraSan, title) {
  const full = extraSan ? [...prefixSan, extraSan] : [...prefixSan];
  const movetext = full
    .map((s, idx) => (idx % 2 === 0 ? `${Math.floor(idx / 2) + 1}. ${s}` : s))
    .join(' ');
  return `[Event "${String(title || 'Opponent Prep').replace(/"/g, '')}"]\n[Result "*"]\n\n${movetext} *`;
}

/**
 * Collect all normalized FENs in `repertoire` where it is the opponent's turn to move
 * (so we can batch-fetch only relevant positions from IndexedDB).
 */
export function collectRepertoireOpponentFens(repertoire, userColor = 'both') {
  const fens = new Set();
  if (!repertoire?.lines || !repertoire?.pos) return [];
  for (const ln of repertoire.lines) {
    if (userColor !== 'both' && ln.color !== userColor) continue;
    const oppTurn = ln.color === 'w' ? 'b' : 'w';
    for (let p = 0; p < ln.pos.length; p++) {
      const f = repertoire.pos[ln.pos[p]]?.f;
      if (!f) continue;
      const turn = f.split(' ')[1] === 'b' ? 'b' : 'w';
      if (turn === oppTurn) {
        fens.add(normalizeFen(f));
      }
    }
  }
  return Array.from(fens);
}

/**
 * Cross-reference a scouted opponent's position map (`Map<normFen, entries[]>`)
 * against the user's opening repertoire.
 *
 * Identifies:
 * - `gaps`: opponent replies at repertoire positions that you haven't prepared yet
 * - `overlaps`: prepared repertoire branches the opponent actually plays
 * - `drillCardIds`: your repertoire cards along lines the opponent plays (due/new first)
 * - `coveragePct`: % of opponent moves at repertoire decision points that are covered
 */
export function analyzeOpponentAgainstRepertoire({
  repertoire,
  scoutPosMap,
  userColor = 'both',
  progress = {},
  now = Date.now(),
}) {
  if (!repertoire?.lines?.length || !repertoire?.pos?.length || !scoutPosMap) {
    return {
      totalOpponentDecisions: 0,
      coveredDecisions: 0,
      coveragePct: null,
      gaps: [],
      overlaps: [],
      drillCardIds: [],
    };
  }

  const secById = new Map((repertoire.secs || []).map((s) => [s.id, s]));

  // Map each unique opponent decision point (userColor|normFen) -> context (best prefix, prepared edges)
  const decisionPoints = new Map();

  for (let li = 0; li < repertoire.lines.length; li++) {
    const ln = repertoire.lines[li];
    if (userColor !== 'both' && ln.color !== userColor) continue;
    const oppTurn = ln.color === 'w' ? 'b' : 'w';
    const secName = secById.get(ln.sec)?.name || ln.name || 'Repertoire';

    for (let p = 0; p < ln.pos.length; p++) {
      const pi = ln.pos[p];
      const posNode = repertoire.pos[pi];
      if (!posNode?.f) continue;
      const turn = posNode.f.split(' ')[1] === 'b' ? 'b' : 'w';
      if (turn !== oppTurn) continue;

      const normFen = normalizeFen(posNode.f);
      const dpKey = `${ln.color}|${normFen}`;
      let dp = decisionPoints.get(dpKey);
      if (!dp) {
        dp = {
          userColor: ln.color,
          oppTurn,
          normFen,
          fen: posNode.f,
          prefixSan: ln.san.slice(0, p),
          sectionName: secName,
          preparedEdges: new Map(), // uci -> { san, lineIds: Set }
        };
        decisionPoints.set(dpKey, dp);
      } else if (p < dp.prefixSan.length) {
        dp.prefixSan = ln.san.slice(0, p);
      }

      for (const e of posNode.e || []) {
        const [uci, san, , , edgeLineIds] = e;
        let rec = dp.preparedEdges.get(uci);
        if (!rec) {
          rec = { uci, san, lineIds: new Set() };
          dp.preparedEdges.set(uci, rec);
        }
        for (const id of edgeLineIds || []) {
          if (repertoire.lines[id]?.color === ln.color) rec.lineIds.add(id);
        }
      }
    }
  }

  let totalOpponentDecisions = 0;
  let coveredDecisions = 0;
  const gaps = [];
  const overlapMap = new Map(); // lineIdx -> { line, sectionName, games, oppWins, oppDraws, oppLosses, matchedPly }
  const cardWeight = new Map(); // cardId -> opponent game frequency weight

  for (const dp of decisionPoints.values()) {
    const rawEntries = scoutPosMap.get(dp.normFen);
    if (!rawEntries?.length) continue;

    const wantPColor = dp.oppTurn === 'w' ? 'white' : 'black';
    const entries = rawEntries.filter((e) => e.pColor === 'both' || e.pColor === wantPColor);
    if (!entries.length) continue;

    // Aggregate opponent moves at this decision point
    const byMove = new Map();
    for (const e of entries) {
      let m = byMove.get(e.uci);
      if (!m) {
        m = { uci: e.uci, san: e.san, games: 0, wins: 0, draws: 0, losses: 0, sampleGid: e.gid };
        byMove.set(e.uci, m);
      }
      m.games += 1;
      if (e.res === 'd') m.draws += 1;
      else if ((dp.oppTurn === 'w' && e.res === 'w') || (dp.oppTurn === 'b' && e.res === 'b')) {
        m.wins += 1;
      } else {
        m.losses += 1;
      }
    }

    for (const mv of byMove.values()) {
      totalOpponentDecisions += mv.games;
      const prepared = dp.preparedEdges.get(mv.uci);
      if (prepared) {
        coveredDecisions += mv.games;
        for (const li of prepared.lineIds) {
          const ln = repertoire.lines[li];
          if (!ln) continue;
          const prev = overlapMap.get(li);
          if (!prev || mv.games > prev.games || dp.prefixSan.length > prev.matchedPly) {
            overlapMap.set(li, {
              lineIdx: li,
              line: ln,
              sectionName: secById.get(ln.sec)?.name || dp.sectionName,
              games: Math.max(mv.games, prev?.games || 0),
              oppWins: mv.wins,
              oppDraws: mv.draws,
              oppLosses: mv.losses,
              matchedPly: dp.prefixSan.length + 1,
              triggerMove: mv.san,
            });
          }
          // Weight every user card in this matched line by opponent frequency
          for (let p = 0; p < ln.uci.length; p++) {
            const edge = repertoire.pos[ln.pos[p]]?.e?.find((x) => x[0] === ln.uci[p]);
            if (edge?.[5] && repertoire.cards?.[edge[5]]) {
              cardWeight.set(edge[5], (cardWeight.get(edge[5]) || 0) + mv.games);
            }
          }
        }
      } else {
        const moveNum = Math.floor(dp.prefixSan.length / 2) + 1;
        const moveLabel = `${moveNum}${dp.oppTurn === 'w' ? '.' : '...'}${mv.san}`;
        gaps.push({
          userColor: dp.userColor,
          oppTurn: dp.oppTurn,
          sectionName: dp.sectionName,
          normFen: dp.normFen,
          fen: dp.fen,
          prefixSan: dp.prefixSan,
          prefixLabel: formatPrefixSan(dp.prefixSan),
          oppUci: mv.uci,
          oppSan: mv.san,
          moveLabel,
          games: mv.games,
          oppWins: mv.wins,
          oppDraws: mv.draws,
          oppLosses: mv.losses,
          sampleGid: mv.sampleGid,
          pgn: buildLinePgnWithMove(
            dp.prefixSan,
            mv.san,
            `${dp.sectionName}: vs ${moveLabel}`
          ),
        });
      }
    }
  }

  gaps.sort((a, b) => b.games - a.games || a.prefixSan.length - b.prefixSan.length);

  const overlaps = Array.from(overlapMap.values())
    .map((ov) => {
      let due = 0;
      let totalCards = 0;
      for (let p = 0; p < ov.line.uci.length; p++) {
        const edge = repertoire.pos[ov.line.pos[p]]?.e?.find((x) => x[0] === ov.line.uci[p]);
        if (edge?.[5] && repertoire.cards?.[edge[5]]) {
          totalCards += 1;
          const st = cardStatus(progress?.[edge[5]], now);
          if (st === 'due' || st === 'new') due += 1;
        }
      }
      return {
        ...ov,
        dueOrNewCards: due,
        totalCards,
        pgn: buildLinePgnWithMove(ov.line.san, '', `${ov.line.id} ${ov.line.name}`),
      };
    })
    .sort((a, b) => b.games - a.games || b.matchedPly - a.matchedPly);

  const statusOrder = { due: 0, new: 1, learning: 2, mastered: 3 };
  const drillCardIds = Array.from(cardWeight.entries())
    .sort((a, b) => {
      const sa = statusOrder[cardStatus(progress?.[a[0]], now)] ?? 2;
      const sb = statusOrder[cardStatus(progress?.[b[0]], now)] ?? 2;
      if (sa !== sb) return sa - sb;
      return b[1] - a[1];
    })
    .map(([id]) => id);

  return {
    totalOpponentDecisions,
    coveredDecisions,
    coveragePct: totalOpponentDecisions
      ? Math.round((coveredDecisions / totalOpponentDecisions) * 100)
      : null,
    gaps,
    overlaps,
    drillCardIds,
  };
}
