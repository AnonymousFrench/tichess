/**
 * Position trainer controller shared by three modes:
 *
 *  - 'mistakes'  Find the move you missed. Any move within ACCEPT_WIN_DROP of the
 *                best counts. While the position stays critical (one clearly best
 *                move), the engine replies and you keep going, up to MAX_DRILL_STEPS.
 *  - 'blunder'   Blunder check. Step 1: from the position after your game move,
 *                find their strongest reply. Step 2: back before it, find a safe move.
 *  - 'convert'   Play out a position where you were +2 or better against Maia 2,
 *                with Stockfish judging every move until you win, hold or slip.
 *
 * The controller owns its state and calls `onChange()` whenever the view should
 * re-render, and `onOutcome(cardId, ok)` once per attempt for spaced repetition.
 */
import { Chess } from 'chess.js';
import { analyse, scoreMove } from './engine.js';
import { maiaCandidates, clampMaiaElo, onMaiaStatus } from './maiaOpponent.js';
import {
  ACCEPT_WIN_DROP,
  SAFE_WIN_DROP,
  MAX_DRILL_STEPS,
  gradeAgainstBest,
  isCritical,
  findLine,
  lineCp,
  pickMaiaMove,
  convertVerdict,
  applyUci,
} from './grading.js';
import { formatReviewScore, uciMoveToSan } from '../engines/evalMath.js';

function idleState() {
  return {
    mode: 'mistakes',
    cardId: '',
    card: null,
    token: 0,
    phase: 'idle', // idle | loading | move | checking | wrong | done | error
    step: 'find', // find | refute | safe | play
    fen: '',
    myColor: 'w',
    selected: null,
    lastBad: null,
    lastMove: null,
    arrows: [],
    prompt: '',
    feedback: '',
    tone: '', // '' | 'good' | 'bad'
    bestLines: [],
    steps: 0,
    history: [],
    hinted: false,
    hintSq: null,
    failedOnce: false,
    outcomeRecorded: false,
    result: '', // solved | revealed | won | held | slipped | drawn
    evalLabel: '',
    maiaElo: 2200,
    opponent: 'maia', // maia | stockfish
    maiaStatus: '',
    error: '',
  };
}

function sideName(c) {
  return c === 'b' ? 'Black' : 'White';
}

/** "15.Qxc7" / "15...Qxc7" for a move by `color` in move `moveNum`. */
function moveLabel(moveNum, color, san) {
  return color === 'b' ? `${moveNum}...${san}` : `${moveNum}.${san}`;
}

/** Label for the opponent's reply to the user's move `moveNum`. */
function replyLabel(moveNum, myColor, san) {
  return myColor === 'b' ? `${moveNum + 1}.${san}` : `${moveNum}...${san}`;
}

/** Mover-POV line → label from the user's point of view. */
function myEvalLabel(line, moverIsMe) {
  if (!line) return '';
  const cp = typeof line.cp === 'number' ? line.cp : null;
  const mate = typeof line.mate === 'number' ? line.mate : null;
  const sign = moverIsMe ? 1 : -1;
  return formatReviewScore(cp === null ? 0 : cp * sign, mate === null ? null : mate * sign);
}

function arrowFor(uci, color = '#10b981', weight = 0.9) {
  return uci && uci.length >= 4 ? { from: uci.slice(0, 2), to: uci.slice(2, 4), weight, color } : null;
}

export function createTrainer({ onChange = () => {}, onOutcome = () => {} } = {}) {
  let S = idleState();

  const emit = () => {
    try {
      onChange();
    } catch (_) {}
  };
  const alive = (token) => token === S.token;

  onMaiaStatus(({ status, pct }) => {
    S.maiaStatus = status === 'downloading' && Number.isFinite(pct) ? `Downloading Maia 2 (${Math.round(pct)}%)…` : status === 'initializing' ? 'Starting Maia 2…' : '';
    emit();
  });

  function recordOnce(ok) {
    if (S.outcomeRecorded || !S.cardId) return;
    S.outcomeRecorded = true;
    try {
      onOutcome(S.cardId, Boolean(ok), S.mode);
    } catch (_) {}
  }

  function fail(token, err) {
    if (!alive(token)) return;
    S.phase = 'error';
    S.error = err?.message || 'The engine could not analyse this position.';
    emit();
  }

  async function analyseCurrent(token, multipv = 3) {
    const res = await analyse(S.fen, { multipv });
    if (!alive(token)) return null;
    S.bestLines = res.lines || [];
    return res;
  }

  /* ----------------------------- opening a card ---------------------------- */

  async function open(mode, card, opts = {}) {
    const keepElo = S.maiaElo;
    S = idleState();
    S.token = Date.now() + Math.random();
    S.maiaElo = clampMaiaElo(opts.maiaElo ?? keepElo);
    const token = S.token;
    if (!card) {
      emit();
      return;
    }
    S.mode = mode;
    S.card = card;
    S.cardId = card.id;
    S.myColor = card.color === 'b' ? 'b' : 'w';
    S.phase = 'loading';

    try {
      if (mode === 'blunder') {
        S.step = 'refute';
        S.fen = card.fenAfter;
        S.lastMove = card.playedUci ? { from: card.playedUci.slice(0, 2), to: card.playedUci.slice(2, 4) } : null;
        S.prompt = `In the game you played ${moveLabel(card.moveNum, S.myColor, card.playedSan)}. Before moving, check: what is their strongest reply?`;
        emit();
        const res = await analyseCurrent(token);
        if (!res) return;
        if (res.over) {
          S.phase = 'error';
          S.error = 'This position is already over.';
        } else {
          S.phase = 'move';
          S.evalLabel = myEvalLabel(S.bestLines[0], false);
        }
        emit();
        return;
      }

      if (mode === 'convert') {
        S.step = 'play';
        S.fen = card.fen;
        S.prompt = `You were ${formatReviewScore(card.peakCp)} here. Convert it against Maia 2 (${S.maiaElo}).`;
        emit();
        if (new Chess(S.fen).turn() !== S.myColor) {
          await opponentMove(token);
          return;
        }
        await readyForMyMove(token);
        return;
      }

      // mistakes
      S.step = 'find';
      S.fen = card.fenBefore;
      S.prompt = `${sideName(S.myColor)} to move. Find the best move.`;
      emit();
      const res = await analyseCurrent(token);
      if (!res) return;
      if (res.over) {
        S.phase = 'error';
        S.error = 'This position is already over.';
      } else {
        S.phase = 'move';
        S.evalLabel = myEvalLabel(S.bestLines[0], true);
      }
      emit();
    } catch (err) {
      fail(token, err);
    }
  }

  /* ------------------------------ board input ------------------------------ */

  function moverColor() {
    try {
      return new Chess(S.fen).turn();
    } catch (_) {
      return S.myColor;
    }
  }

  function legalDests(sq) {
    try {
      return new Chess(S.fen).moves({ square: sq, verbose: true }).map((m) => m.to);
    } catch (_) {
      return [];
    }
  }

  function clickSquare(sq) {
    if (!(S.phase === 'move' || S.phase === 'wrong')) return;
    let chess;
    try {
      chess = new Chess(S.fen);
    } catch (_) {
      return;
    }
    const piece = chess.get(sq);
    const own = Boolean(piece && piece.color === chess.turn());
    if (!S.selected) {
      if (own) {
        S.selected = sq;
        S.lastBad = null;
        emit();
      }
      return;
    }
    if (S.selected === sq) {
      S.selected = null;
      emit();
      return;
    }
    if (own) {
      S.selected = sq;
      emit();
      return;
    }
    const from = S.selected;
    S.selected = null;
    const legal = chess.moves({ square: from, verbose: true }).find((m) => m.to === sq);
    if (!legal) {
      emit();
      return;
    }
    // Auto-promote to a queen unless the engine's best line underpromotes on this square.
    let promo = '';
    if (legal.promotion) {
      const best = S.bestLines[0]?.uci || '';
      promo = best.slice(0, 4) === from + sq && best[4] ? best[4] : 'q';
    }
    submit(from + sq + promo);
  }

  async function submit(uci) {
    const token = S.token;
    const fenBefore = S.fen;
    const applied = applyUci(fenBefore, uci);
    if (!applied) return;
    const san = applied.move.san;
    S.phase = 'checking';
    S.feedback = '';
    S.tone = '';
    emit();

    try {
      if (S.mode === 'convert') {
        await convertMove(token, uci, applied);
        return;
      }

      const best = S.bestLines[0];
      let line = findLine(S.bestLines, fenBefore, uci);
      if (!line) line = await scoreMove(fenBefore, uci);
      if (!alive(token)) return;
      const tolerance = S.step === 'safe' ? SAFE_WIN_DROP : ACCEPT_WIN_DROP;
      let grade = gradeAgainstBest(best, line, tolerance);
      // Replaying the game move as the "safe" move never counts.
      if (S.step === 'safe' && S.card?.playedUci && uci.slice(0, 4) === S.card.playedUci.slice(0, 4)) {
        grade = { ok: false, drop: grade.drop };
      }

      if (!grade.ok) {
        const firstMiss = !S.failedOnce;
        S.failedOnce = true;
        if (firstMiss) recordOnce(false);
        S.phase = 'wrong';
        S.lastBad = uci.slice(2, 4);
        S.tone = 'bad';
        S.feedback =
          S.step === 'safe' && S.card?.playedUci && uci.slice(0, 4) === S.card.playedUci.slice(0, 4)
            ? `${san} is the game move. Find something that doesn't allow their reply.`
            : S.step === 'refute'
              ? `${san} isn't their strongest reply. Look at what your move left undefended.`
              : `${san} gives up about ${Math.round(grade.drop)}% winning chances. Try again.`;
        emit();
        return;
      }

      if (S.mode === 'blunder') {
        await blunderStepPassed(token, uci, san, line);
        return;
      }
      await mistakeStepPassed(token, uci, san, applied, best, fenBefore);
    } catch (err) {
      fail(token, err);
    }
  }

  /* ------------------------------- mistakes ------------------------------- */

  async function mistakeStepPassed(token, uci, san, applied, best, fenBefore) {
    S.steps += 1;
    S.history.push(san);
    S.fen = applied.chess.fen();
    S.lastMove = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
    S.lastBad = null;
    S.tone = 'good';
    const bestSan = best?.uci ? uciMoveToSan(fenBefore, best.uci) : '';
    S.feedback = bestSan && bestSan !== san ? `${san} works too (engine's first choice: ${bestSan}).` : `${san}: good.`;

    if (applied.chess.isGameOver() || S.steps >= MAX_DRILL_STEPS) {
      finish('solved');
      return;
    }

    // Opponent replies with the engine's best move.
    S.phase = 'checking';
    emit();
    const opp = await analyse(S.fen, { multipv: 1 });
    if (!alive(token)) return;
    if (opp.over || !opp.lines.length) {
      finish('solved');
      return;
    }
    const reply = applyUci(S.fen, opp.lines[0].uci);
    if (!reply) {
      finish('solved');
      return;
    }
    S.history.push(reply.move.san);
    S.fen = reply.chess.fen();
    S.lastMove = { from: reply.move.from, to: reply.move.to };
    const res = await analyseCurrent(token);
    if (!res) return;
    if (res.over || !isCritical(S.bestLines)) {
      S.evalLabel = res.over ? '' : myEvalLabel(S.bestLines[0], true);
      finish('solved', 'They replied ' + reply.move.san + '. No more forcing moves needed.');
      return;
    }
    S.phase = 'move';
    S.evalLabel = myEvalLabel(S.bestLines[0], true);
    S.prompt = `They replied ${reply.move.san}. Keep going: find the next move.`;
    emit();
  }

  /* ---------------------------- blunder check ----------------------------- */

  async function blunderStepPassed(token, uci, san, line) {
    if (S.step === 'refute') {
      S.arrows = [arrowFor(uci, '#fb7185')].filter(Boolean);
      S.tone = 'good';
      S.feedback = `Right: ${replyLabel(S.card.moveNum, S.myColor, san)} (${myEvalLabel(line, false)}). That's what ${moveLabel(S.card.moveNum, S.myColor, S.card.playedSan)} allowed.`;
      await startSafeStep(token);
      return;
    }
    S.history.push(san);
    S.lastMove = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
    S.tone = 'good';
    S.feedback = `${san} is safe (${myEvalLabel(line, true)}).`;
    finish('solved');
  }

  async function startSafeStep(token) {
    S.step = 'safe';
    S.fen = S.card.fenBefore;
    S.lastMove = null;
    S.lastBad = null;
    S.phase = 'checking';
    S.prompt = `Now find a move that doesn't allow it.`;
    emit();
    const res = await analyseCurrent(token);
    if (!res) return;
    S.phase = res.over ? 'error' : 'move';
    S.evalLabel = myEvalLabel(S.bestLines[0], true);
    emit();
  }

  /* ------------------------------ conversion ------------------------------ */

  async function readyForMyMove(token) {
    const res = await analyseCurrent(token, 1);
    if (!res) return;
    if (res.over) {
      finish(res.over === 'checkmate' ? 'slipped' : 'drawn');
      return;
    }
    S.evalLabel = myEvalLabel(S.bestLines[0], true);
    S.phase = 'move';
    emit();
  }

  async function opponentMove(token) {
    S.phase = 'checking';
    emit();
    let chosen = null;
    if (S.opponent === 'maia') {
      try {
        const cands = await maiaCandidates(S.fen, S.maiaElo);
        if (!alive(token)) return;
        chosen = pickMaiaMove(cands);
      } catch (_) {
        if (!alive(token)) return;
        S.opponent = 'stockfish';
        S.feedback = 'Maia 2 is unavailable, so Stockfish is defending instead.';
      }
    }
    if (!chosen) {
      const res = await analyse(S.fen, { multipv: 1 });
      if (!alive(token)) return;
      if (res.over || !res.lines.length) {
        finish(res.over === 'checkmate' ? 'won' : 'drawn');
        return;
      }
      chosen = { uci: res.lines[0].uci };
    }
    const reply = applyUci(S.fen, chosen.uci);
    if (!reply) {
      fail(token, new Error('Opponent move was not legal'));
      return;
    }
    S.history.push(reply.move.san);
    S.fen = reply.chess.fen();
    S.lastMove = { from: reply.move.from, to: reply.move.to };
    if (reply.chess.isCheckmate()) {
      finish('slipped', `${reply.move.san} is mate.`);
      return;
    }
    if (reply.chess.isGameOver()) {
      finish('drawn');
      return;
    }
    S.prompt = `They played ${reply.move.san}. Your move.`;
    await readyForMyMove(token);
  }

  async function convertMove(token, uci, applied) {
    const bestBefore = S.bestLines[0] || null;
    const fenBefore = S.fen;
    S.history.push(applied.move.san);
    S.steps += 1;
    S.fen = applied.chess.fen();
    S.lastMove = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
    S.selected = null;
    if (applied.chess.isCheckmate()) {
      finish('won', `${applied.move.san} is mate.`);
      return;
    }
    if (applied.chess.isGameOver()) {
      finish('drawn');
      return;
    }
    const res = await analyse(S.fen, { multipv: 1 });
    if (!alive(token)) return;
    const theirBest = res.lines[0];
    const myCp = -lineCp(theirBest);
    S.evalLabel = myEvalLabel(theirBest, false);
    const verdict = convertVerdict({ myCp, myMoves: S.steps });
    if (verdict === 'slipped') {
      // Show the position before the slip, with the move that kept the advantage.
      S.fen = fenBefore;
      S.lastMove = null;
      S.lastBad = uci.slice(2, 4);
      if (bestBefore?.uci) {
        S.arrows = [arrowFor(bestBefore.uci)].filter(Boolean);
      }
      const bestSan = bestBefore?.uci ? uciMoveToSan(fenBefore, bestBefore.uci) : '';
      finish(
        'slipped',
        `${applied.move.san} lets the advantage slip (${S.evalLabel}).${bestSan ? ` ${bestSan} kept it.` : ''}`
      );
      return;
    }
    if (verdict === 'won' || verdict === 'held') {
      finish(verdict);
      return;
    }
    await opponentMove(token);
  }

  /* ------------------------------- controls ------------------------------- */

  function finish(result, note = '') {
    S.phase = 'done';
    S.result = result;
    S.selected = null;
    if (note) S.feedback = note;
    const success = result === 'solved' || result === 'won' || result === 'held';
    recordOnce(success && !S.failedOnce && !S.hinted);
    emit();
  }

  function hint() {
    if (!(S.phase === 'move' || S.phase === 'wrong')) return;
    const best = S.bestLines[0];
    if (!best?.uci) return;
    S.hinted = true;
    S.hintSq = best.uci.slice(0, 2);
    emit();
  }

  async function reveal() {
    if (!(S.phase === 'move' || S.phase === 'wrong')) return;
    const best = S.bestLines[0];
    if (!best?.uci) return;
    const token = S.token;
    S.hinted = true;
    recordOnce(false);
    const san = uciMoveToSan(S.fen, best.uci);
    if (S.mode === 'blunder' && S.step === 'refute') {
      S.arrows = [arrowFor(best.uci, '#fb7185')].filter(Boolean);
      S.tone = 'bad';
      S.feedback = `Their strongest reply was ${replyLabel(S.card.moveNum, S.myColor, san)}. That's what ${moveLabel(S.card.moveNum, S.myColor, S.card.playedSan)} allowed.`;
      try {
        await startSafeStep(token);
      } catch (err) {
        fail(token, err);
      }
      return;
    }
    S.arrows = [arrowFor(best.uci)].filter(Boolean);
    S.tone = '';
    S.feedback = `Best: ${san} (${myEvalLabel(best, true)}).`;
    S.phase = 'done';
    S.result = 'revealed';
    emit();
  }

  function setMaiaElo(elo) {
    S.maiaElo = clampMaiaElo(elo);
    emit();
  }

  function view() {
    const turn = S.fen ? moverColor() : S.myColor;
    return {
      ...S,
      turn,
      flipped: S.myColor === 'b',
      dests: S.selected ? legalDests(S.selected) : null,
      interactive: S.phase === 'move' || S.phase === 'wrong',
    };
  }

  function reset() {
    S = { ...idleState(), maiaElo: S.maiaElo, token: Date.now() + Math.random() };
  }

  return { open, clickSquare, hint, reveal, setMaiaElo, view, reset, get cardId() { return S.cardId; }, get mode() { return S.mode; } };
}
