/**
 * Interactive "Fix Opening Flaw → Repertoire" modal.
 * Shared between Studio Explorer (My Games / Mine) and Insights Coach (Opening Cliffs).
 */
import { Chess } from 'chess.js';
import { START_FEN, normalizeFen, escapeHtml } from '../state.js';
import { loadRepertoire, saveRepertoire, loadProgress } from './storage.js';
import { mergeRepertoires } from './pgnImport.js';
import { pushRepertoireToCloud } from '../sync/cloudSync.js';
import { PREP_DRILL_STORAGE_KEY } from './opponentPrep.js';
import {
  FLAW_PRESETS,
  formatMoveLabel,
  diagnoseFlawPosition,
  generateFlawRepertoire,
} from './flawGenerator.js';

const MODAL_ID = 'flawRepertoireModal';

let modalEl = null;
let abortCtrl = null;
let activeCtx = null;

function ensureModalMounted() {
  if (modalEl && document.body.contains(modalEl)) return modalEl;
  modalEl = document.createElement('div');
  modalEl.id = MODAL_ID;
  modalEl.className =
    'hidden fixed inset-0 z-50 bg-black/75 backdrop-blur-[2px] flex items-center justify-center p-2.5 sm:p-4';
  modalEl.setAttribute('role', 'dialog');
  modalEl.setAttribute('aria-modal', 'true');
  modalEl.setAttribute('aria-label', 'Generate Repertoire from Opening Flaw');
  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) closeFlawRepertoireModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalEl && !modalEl.classList.contains('hidden')) {
      closeFlawRepertoireModal();
    }
  });
  document.body.appendChild(modalEl);
  return modalEl;
}

export function closeFlawRepertoireModal() {
  if (abortCtrl) {
    abortCtrl.abort();
    abortCtrl = null;
  }
  activeCtx = null;
  if (modalEl) {
    modalEl.classList.add('hidden');
    modalEl.innerHTML = '';
  }
}

function buildPrefixMovesFromSan(pathSans, startFen = START_FEN) {
  const chess = new Chess(startFen);
  const out = [];
  for (const s of pathSans || []) {
    let mv;
    try {
      mv = chess.move(s);
    } catch (_) {
      break;
    }
    if (!mv) break;
    out.push({
      san: mv.san,
      uci: mv.from + mv.to + (mv.promotion || ''),
      fen: chess.fen(),
      color: mv.color,
    });
  }
  return { moves: out, endFen: chess.fen() };
}

function findExistingRepMovesAtFen(repertoire, fen) {
  if (!repertoire?.pos?.length || !fen) return [];
  const target = normalizeFen(fen);
  const found = [];
  for (const node of repertoire.pos) {
    if (!node?.f || normalizeFen(node.f) !== target) continue;
    for (const e of node.e || []) {
      if (e[3] & 1) {
        if (!found.some((x) => x.uci === e[0])) {
          found.push({ uci: e[0], san: e[1] });
        }
      }
    }
  }
  return found;
}

function triggerLabel(ctx) {
  if (ctx.triggerType === 'opponent_reply') {
    const oppColor = ctx.color === 'w' ? 'b' : 'w';
    return formatMoveLabel(ctx.oppMove?.ply ?? Math.max(0, ctx.ply - 1), oppColor, ctx.oppMove?.san || ctx.flawedSan);
  }
  return formatMoveLabel(ctx.ply, ctx.color, ctx.flawedSan);
}

function defaultSectionTitle(ctx) {
  const shortOpening = (ctx.openingName || 'Opening').split(':')[0].trim().slice(0, 30);
  const lbl = triggerLabel(ctx);
  if (ctx.triggerType === 'opponent_reply' || ctx.mode === 'vs_opponent') {
    return `Fix: ${shortOpening} (vs ${lbl})`.slice(0, 60);
  }
  if (ctx.mode === 'repair') {
    return `Fix: ${shortOpening} (${lbl} follow-ups)`.slice(0, 60);
  }
  const cand = ctx.selectedCandidate;
  const anchorLbl = cand ? formatMoveLabel(ctx.ply, ctx.color, cand.san) : lbl;
  return `Fix: ${shortOpening} (${anchorLbl} vs ${lbl})`.slice(0, 60);
}

function inferRatingFromGames(games, color) {
  const ratings = [];
  for (const g of games || []) {
    if (typeof g?.me === 'number' && g.me > 400) {
      ratings.push(g.me);
    } else if (g?.white?.rating || g?.black?.rating) {
      const r = Number(color === 'b' ? g.black?.rating : g.white?.rating);
      if (r > 400) ratings.push(r);
    }
  }
  if (!ratings.length) return 1600;
  ratings.sort((a, b) => a - b);
  return ratings[Math.floor(ratings.length / 2)];
}

async function runDiagnosis(ctx) {
  if (abortCtrl) abortCtrl.abort();
  const ctrl = new AbortController();
  abortCtrl = ctrl;

  ctx.stage = 'diagnosing';
  ctx.error = '';
  ctx.generated = null;
  renderModal(ctx);

  try {
    const res = await diagnoseFlawPosition({
      fen: ctx.fen,
      ply: ctx.ply,
      color: ctx.color,
      flawedUci: ctx.flawedUci,
      flawedSan: ctx.flawedSan,
      flawedStats: ctx.flawedStats,
      triggerType: ctx.triggerType,
      oppMove: ctx.oppMove,
      pool: ctx.pool,
      rating: ctx.rating,
      tc: ctx.tc,
      signal: ctrl.signal,
    });
    if (ctx !== activeCtx || ctrl.signal.aborted) return;

    ctx.diagnosis = res.diagnosis;
    ctx.explorerNote = res.explorerNote;
    ctx.poolLabel = res.poolLabel;
    if (!ctx.openingName && res.openingFromExplorer) {
      ctx.openingName = res.openingFromExplorer;
    }
    ctx.mode =
      ctx.triggerType === 'opponent_reply'
        ? 'vs_opponent'
        : res.diagnosis.recommendedMode || 'replace';
    ctx.selectedCandidate = res.diagnosis.candidates?.[0] || null;
    if (!ctx.sectionEdited) {
      ctx.sectionName = defaultSectionTitle(ctx);
    }
    ctx.stage = 'ready';
    renderModal(ctx);
  } catch (err) {
    if (err?.name === 'AbortError' || ctx !== activeCtx) return;
    ctx.stage = 'error';
    ctx.error = err?.message || 'Could not evaluate this position.';
    renderModal(ctx);
  }
}

async function runGeneration(ctx) {
  if (abortCtrl) abortCtrl.abort();
  const ctrl = new AbortController();
  abortCtrl = ctrl;

  const anchorMove =
    ctx.mode === 'repair'
      ? {
          uci: ctx.diagnosis?.flawedMove?.uci || ctx.flawedUci,
          san: ctx.diagnosis?.flawedMove?.san || ctx.flawedSan,
          evLabel: ctx.diagnosis?.flawedMove?.evLabel || '',
          peerScore: ctx.diagnosis?.flawedMove?.peerScore ?? null,
        }
      : ctx.selectedCandidate;

  if (!anchorMove?.uci && !anchorMove?.san) {
    ctx.error = 'Choose a move to build the repertoire around.';
    renderModal(ctx);
    return;
  }

  ctx.stage = 'generating';
  ctx.error = '';
  ctx.progress = { step: 0, totalEstimate: 16, label: 'Starting Stockfish & Explorer…' };
  renderModal(ctx);

  try {
    const result = await generateFlawRepertoire({
      prefixMoves: ctx.prefixMoves,
      startFen: ctx.startFen,
      fen: ctx.fen,
      color: ctx.color,
      openingName: ctx.openingName,
      flawedUci: ctx.flawedUci,
      flawedSan: ctx.flawedSan,
      flawedStats: ctx.flawedStats,
      mode: ctx.mode,
      oppMove: ctx.oppMove,
      anchorMove,
      diagnosis: ctx.diagnosis,
      presetKey: ctx.presetKey,
      pool: ctx.pool,
      rating: ctx.rating,
      tc: ctx.tc,
      existingRepertoire: ctx.existingRepertoire,
      personalGames: ctx.personalGames,
      sectionName: ctx.sectionName,
      signal: ctrl.signal,
      onProgress: (p) => {
        if (ctx !== activeCtx || ctrl.signal.aborted) return;
        ctx.progress = p;
        updateProgressUi(p);
      },
    });
    if (ctx !== activeCtx || ctrl.signal.aborted) return;

    ctx.generated = result;
    ctx.stage = 'preview';
    renderModal(ctx);
  } catch (err) {
    if (err?.name === 'AbortError' || ctx !== activeCtx) {
      if (ctx === activeCtx) {
        ctx.stage = 'ready';
        renderModal(ctx);
      }
      return;
    }
    ctx.stage = 'ready';
    ctx.error = err?.message || 'Could not generate repertoire lines.';
    renderModal(ctx);
  }
}

async function saveGenerated(ctx, { launchDrill = false } = {}) {
  if (!ctx?.generated?.repertoire) return;
  ctx.saving = true;
  renderModal(ctx);

  try {
    const existingDoc = await loadRepertoire();
    const merged = existingDoc?.repertoire
      ? mergeRepertoires(existingDoc.repertoire, ctx.generated.repertoire)
      : ctx.generated.repertoire;
    const repName = existingDoc?.name || ctx.generated.sectionName || 'My Repertoire';
    const updatedAt = Date.now();

    await saveRepertoire(merged, repName, updatedAt);
    pushRepertoireToCloud(merged, repName, updatedAt, loadProgress());

    await ctx.onSaved?.({
      repertoire: merged,
      name: repName,
      sectionName: ctx.generated.sectionName,
      stats: ctx.generated.stats,
      drillCardIds: ctx.generated.drillCardIds,
    });

    if (launchDrill) {
      try {
        localStorage.setItem(
          PREP_DRILL_STORAGE_KEY,
          JSON.stringify({
            title: ctx.generated.sectionName,
            mode: 'learn',
            cardIds: ctx.generated.drillCardIds,
            createdAt: Date.now(),
          })
        );
      } catch (_) {}
      closeFlawRepertoireModal();
      window.location.href = 'repertoire.html?prep=1';
      return;
    }

    ctx.notify?.(
      `Saved "${ctx.generated.sectionName}" (${ctx.generated.stats.lines} lines · ${ctx.generated.stats.cards} cards)`
    );
    closeFlawRepertoireModal();
  } catch (err) {
    ctx.saving = false;
    ctx.error = err?.message || 'Could not save repertoire to this browser.';
    renderModal(ctx);
  }
}

function updateProgressUi(p) {
  if (!modalEl) return;
  const lbl = modalEl.querySelector('#flawGenProgressLabel');
  const bar = modalEl.querySelector('#flawGenProgressBar');
  if (lbl) lbl.textContent = p.label || 'Generating…';
  if (bar) {
    const pct = Math.min(95, Math.max(8, Math.round((p.step / Math.max(1, p.totalEstimate)) * 100)));
    bar.style.width = `${pct}%`;
  }
}

function toneClasses(tone) {
  if (tone === 'ro') {
    return {
      box: 'bg-ro/10 border-ro/35',
      pill: 'bg-ro/20 text-ro border-ro/40',
      text: 'text-ro',
    };
  }
  if (tone === 'em') {
    return {
      box: 'bg-em/10 border-em/35',
      pill: 'bg-em/20 text-em border-em/40',
      text: 'text-em',
    };
  }
  if (tone === 'cy') {
    return {
      box: 'bg-cy/10 border-cy/35',
      pill: 'bg-cy/20 text-cy border-cy/40',
      text: 'text-cy',
    };
  }
  return {
    box: 'bg-am/10 border-am/35',
    pill: 'bg-am/20 text-am border-am/40',
    text: 'text-am',
  };
}

function renderDiagnosisBlock(ctx) {
  const lbl = triggerLabel(ctx);
  if (ctx.stage === 'diagnosing') {
    const msg =
      ctx.triggerType === 'opponent_reply'
        ? `Finding the strongest sound answers against <b class="font-mono text-txt">${escapeHtml(lbl)}</b> with Stockfish &amp; ${escapeHtml(ctx.pool === 'masters' ? 'Masters OTB' : '+100 Elo Explorer')}…`
        : `Checking <b class="font-mono text-txt">${escapeHtml(lbl)}</b> with Stockfish &amp; ${escapeHtml(ctx.pool === 'masters' ? 'Masters OTB' : '+100 Elo Explorer')} to see if the move itself is weak or the leak is in the follow-ups…`;
    return `<div class="p-3 rounded-lg bg-surface/70 border border-borderSubtle flex items-center gap-2.5 text-xs text-txtMuted">
      <span class="w-2.5 h-2.5 rounded-full bg-em animate-pulse shrink-0"></span>
      <span>${msg}</span>
    </div>`;
  }

  const d = ctx.diagnosis;
  if (!d) return '';
  const tc = toneClasses(d.tone);
  const fm = d.flawedMove;
  const bm = d.bestMove;
  const isOppReply = ctx.triggerType === 'opponent_reply';

  return `<div class="p-3 rounded-lg border ${tc.box} flex flex-col gap-2">
    <div class="flex items-start justify-between gap-2 flex-wrap">
      <div class="flex items-center gap-1.5 flex-wrap">
        <span class="px-1.5 py-0.5 rounded border font-sans text-[10px] font-bold uppercase tracking-wide ${tc.pill}">${escapeHtml(d.badge)}</span>
        <span class="text-xs font-semibold text-txt">${escapeHtml(d.headline)}</span>
      </div>
      <div class="flex items-center gap-2 font-mono text-[11px] shrink-0">
        ${
          isOppReply
            ? bm
              ? `<span class="text-txtMuted">Best reply: <b class="text-em">${escapeHtml(bm.label)}</b> <span class="text-txtMuted">(${escapeHtml(bm.evLabel)})</span></span>`
              : ''
            : `<span class="text-txtMuted">Yours: <b class="text-txt">${escapeHtml(fm.label)}</b> <span class="text-txtMuted">(${escapeHtml(fm.evLabel)})</span></span>
               ${bm && bm.uci.slice(0, 4) !== fm.uci.slice(0, 4) ? `<span class="text-txtMuted">· Best: <b class="text-em">${escapeHtml(bm.label)}</b> <span class="text-txtMuted">(${escapeHtml(bm.evLabel)})</span></span>` : ''}`
        }
      </div>
    </div>
    <p class="text-[11.5px] text-txt/90 leading-relaxed">${escapeHtml(d.explanation)}</p>
    <div class="text-[11px] text-txtMuted leading-relaxed pt-1 border-t border-borderSubtle/50">
      <b class="text-txt">${isOppReply ? 'Why this matters:' : 'Weak move vs. weak follow-up:'}</b> ${escapeHtml(d.whyDistinction)}
    </div>
    ${d.sampleNote ? `<div class="text-[10.5px] text-am bg-am/10 border border-am/25 rounded px-2 py-1">${escapeHtml(d.sampleNote)}</div>` : ''}
    ${
      ctx.existingMoves.length
        ? `<div class="text-[10.5px] text-cy bg-cy/10 border border-cy/25 rounded px-2 py-1">Already in your saved repertoire here: <b class="font-mono">${escapeHtml(ctx.existingMoves.map((m) => m.san).join(', '))}</b>. Generated lines will merge cleanly alongside your existing prep.</div>`
        : ''
    }
  </div>`;
}

function renderConfigBlock(ctx) {
  if (ctx.stage === 'diagnosing' || !ctx.diagnosis) return '';
  const d = ctx.diagnosis;
  const flawLbl = triggerLabel(ctx);
  const cands = d.candidates || [];
  const isOppReply = ctx.triggerType === 'opponent_reply';
  const isReplace = ctx.mode === 'replace';
  const busy = ctx.stage === 'generating' || ctx.saving;

  const candidateChips = cands.length
    ? `<div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5 mt-1.5">${cands
        .map((cand, idx) => {
          const active = ctx.selectedCandidate?.uci === cand.uci;
          return `<button type="button" data-flaw-cand="${idx}" ${busy ? 'disabled' : ''} class="text-left px-2.5 py-1.5 rounded-md border transition-colors ${
            active
              ? 'bg-em/15 border-em/60 text-txt'
              : 'bg-panel border-borderSubtle text-txtMuted hover:border-borderBright hover:text-txt'
          }">
            <div class="flex items-center justify-between gap-2">
              <span class="font-mono font-bold text-xs ${active ? 'text-em' : 'text-txt'}">${escapeHtml(cand.label)}</span>
              <span class="font-mono text-[10.5px] text-txtMuted">${escapeHtml(cand.evLabel)}${cand.peerScore !== null ? ` · <b class="text-txt">${cand.peerScore}%</b>` : ''}</span>
            </div>
            <div class="text-[10px] text-txtMuted truncate mt-0.5">${
              cand.peerShare !== null && cand.peerGames
                ? `${cand.peerShare}% played (${cand.peerGames.toLocaleString()}g)`
                : cand.pvSan?.length > 1
                  ? `PV: ${escapeHtml(cand.pvSan.slice(0, 4).join(' '))}`
                  : 'Stockfish candidate'
            }</div>
          </button>`;
        })
        .join('')}</div>`
    : `<div class="text-[11px] text-txtMuted mt-1">No candidate moves available.</div>`;

  const modeAndCandidateHtml = isOppReply
    ? `<div class="p-2.5 rounded-lg bg-surface/50 border border-borderSubtle">
        <div class="text-[10.5px] font-semibold uppercase tracking-wider text-txtMuted">Choose your reply against ${escapeHtml(flawLbl)}</div>
        ${candidateChips}
      </div>`
    : `<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <button type="button" data-flaw-mode="replace" ${busy ? 'disabled' : ''} class="text-left p-2.5 rounded-lg border transition-colors ${
          isReplace
            ? 'bg-surface border-em/60'
            : 'bg-surface/40 border-borderSubtle hover:border-borderBright'
        }">
          <div class="flex items-center justify-between gap-1.5">
            <span class="text-xs font-semibold text-txt">Switch away from ${escapeHtml(flawLbl)}</span>
            ${d.recommendedMode === 'replace' ? '<span class="px-1.5 py-[1px] rounded bg-em/20 text-em text-[9.5px] font-bold uppercase">Recommended</span>' : ''}
          </div>
          <div class="text-[10.5px] text-txtMuted mt-0.5">Replace ${escapeHtml(flawLbl)} with a stronger move and add a habit warning if you play ${escapeHtml(flawLbl)} in drills.</div>
        </button>

        <button type="button" data-flaw-mode="repair" ${busy ? 'disabled' : ''} class="text-left p-2.5 rounded-lg border transition-colors ${
          !isReplace
            ? 'bg-surface border-em/60'
            : 'bg-surface/40 border-borderSubtle hover:border-borderBright'
        }">
          <div class="flex items-center justify-between gap-1.5">
            <span class="text-xs font-semibold text-txt">Keep ${escapeHtml(flawLbl)} &amp; fix follow-ups</span>
            ${d.recommendedMode === 'repair' ? '<span class="px-1.5 py-[1px] rounded bg-em/20 text-em text-[9.5px] font-bold uppercase">Recommended</span>' : ''}
          </div>
          <div class="text-[10.5px] text-txtMuted mt-0.5">Keep playing ${escapeHtml(flawLbl)} and build concrete answers to the opponent replies that beat you after it.</div>
        </button>
      </div>
      ${
        isReplace
          ? `<div class="p-2.5 rounded-lg bg-surface/50 border border-borderSubtle">
              <div class="text-[10.5px] font-semibold uppercase tracking-wider text-txtMuted">Replacement move</div>
              ${candidateChips}
            </div>`
          : ''
      }`;

  return `<div class="flex flex-col gap-2.5">
    ${modeAndCandidateHtml}

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
      <div>
        <div class="text-[10.5px] font-semibold uppercase tracking-wider text-txtMuted mb-1">Repertoire size</div>
        <div class="grid grid-cols-3 gap-1">${Object.values(FLAW_PRESETS)
          .map((p) => {
            const on = ctx.presetKey === p.key;
            return `<button type="button" data-flaw-preset="${p.key}" ${busy ? 'disabled' : ''} class="px-2 py-1.5 rounded-md border text-center transition-colors ${
              on
                ? 'bg-em/15 border-em/60 text-txt'
                : 'bg-surface border-borderSubtle text-txtMuted hover:text-txt'
            }">
              <div class="text-[11px] font-semibold">${escapeHtml(p.label)}</div>
              <div class="text-[9.5px] text-txtMuted">${escapeHtml(p.summary)}</div>
            </button>`;
          })
          .join('')}</div>
      </div>

      <div class="flex flex-col gap-2">
        <div>
          <div class="text-[10.5px] font-semibold uppercase tracking-wider text-txtMuted mb-1">Opponent reply pool</div>
          <div class="grid grid-cols-2 gap-1">
            <button type="button" data-flaw-pool="peers" ${busy ? 'disabled' : ''} class="px-2 py-1.5 rounded-md border text-[11px] font-semibold ${
              ctx.pool === 'peers'
                ? 'bg-cy/15 border-cy/55 text-cy'
                : 'bg-surface border-borderSubtle text-txtMuted hover:text-txt'
            }">+100 Elo Peers</button>
            <button type="button" data-flaw-pool="masters" ${busy ? 'disabled' : ''} class="px-2 py-1.5 rounded-md border text-[11px] font-semibold ${
              ctx.pool === 'masters'
                ? 'bg-cy/15 border-cy/55 text-cy'
                : 'bg-surface border-borderSubtle text-txtMuted hover:text-txt'
            }">Masters OTB</button>
          </div>
        </div>
        <div>
          <label for="flawSectionNameInput" class="text-[10.5px] font-semibold uppercase tracking-wider text-txtMuted block mb-1">Repertoire section name</label>
          <input id="flawSectionNameInput" type="text" maxlength="60" value="${escapeHtml(ctx.sectionName)}" ${busy ? 'disabled' : ''} class="w-full px-2.5 py-1.5 rounded-md bg-surface border border-borderSubtle text-xs text-txt focus:outline-none focus:border-em" />
        </div>
      </div>
    </div>
  </div>`;
}

function renderProgressOrPreview(ctx) {
  if (ctx.stage === 'generating') {
    const pct = Math.min(
      95,
      Math.max(8, Math.round(((ctx.progress?.step || 1) / Math.max(1, ctx.progress?.totalEstimate || 16)) * 100))
    );
    return `<div class="p-3 rounded-lg bg-surface/70 border border-borderSubtle flex flex-col gap-2">
      <div class="flex items-center justify-between gap-2 text-xs">
        <span class="flex items-center gap-2 text-txt">
          <span class="w-2 h-2 rounded-full bg-em animate-pulse shrink-0"></span>
          <span id="flawGenProgressLabel">${escapeHtml(ctx.progress?.label || 'Building lines…')}</span>
        </span>
        <button type="button" id="btnFlawCancelGen" class="px-2 py-0.5 rounded bg-ro/15 hover:bg-ro/25 text-ro border border-ro/35 text-[11px] font-semibold">Cancel</button>
      </div>
      <div class="w-full h-1.5 rounded-full bg-panel overflow-hidden">
        <div id="flawGenProgressBar" class="h-full bg-em transition-all duration-200" style="width:${pct}%"></div>
      </div>
    </div>`;
  }

  const gen = ctx.generated;
  if (!gen) return '';

  return `<div class="p-3 rounded-lg bg-surface/60 border border-em/35 flex flex-col gap-2">
    <div class="flex items-center justify-between gap-2 flex-wrap">
      <div class="text-xs font-semibold text-em">Generated ${gen.stats.lines} line${gen.stats.lines === 1 ? '' : 's'} · ${gen.stats.cards} move card${gen.stats.cards === 1 ? '' : 's'} to learn</div>
      <span class="text-[10.5px] font-mono text-txtMuted">${escapeHtml(gen.poolLabel || '')}</span>
    </div>
    ${gen.explorerFallbackNote ? `<div class="text-[10.5px] text-am bg-am/10 border border-am/25 rounded px-2 py-1">${escapeHtml(gen.explorerFallbackNote)}</div>` : ''}
    <div class="max-h-48 overflow-y-auto divide-y divide-borderSubtle/50 rounded border border-borderSubtle/70 bg-panel/70">
      ${gen.linesPreview
        .map((ln) => {
          const tags = [];
          if (ln.fixedHabits?.length) {
            for (const h of ln.fixedHabits.slice(0, 2)) {
              tags.push(
                `<span class="px-1.5 py-[1px] rounded bg-am/15 text-am border border-am/30 text-[9.5px] font-semibold">Fixes ${escapeHtml(h.label)} (${h.scorePct}%, ${h.games}g)</span>`
              );
            }
          }
          if (ln.personalLosses > 0) {
            tags.push(
              `<span class="px-1.5 py-[1px] rounded bg-ro/20 text-ro text-[9.5px] font-semibold">Beat you ${ln.personalLosses}×</span>`
            );
          }
          if (ln.oppSharePct) {
            tags.push(
              `<span class="px-1.5 py-[1px] rounded bg-surface text-txtMuted text-[9.5px] font-mono">${ln.oppSharePct}% played</span>`
            );
          }
          if (ln.stoppedBy === 'repertoire') {
            tags.push(
              `<span class="px-1.5 py-[1px] rounded bg-cy/15 text-cy text-[9.5px] font-semibold">Transposes to your rep</span>`
            );
          }
          return `<div class="px-2.5 py-1.5 flex flex-col gap-0.5">
            <div class="flex items-center justify-between gap-2 flex-wrap">
              <span class="text-[11px] font-semibold text-txt">${escapeHtml(ln.name)}</span>
              <span class="flex items-center gap-1 flex-wrap">${tags.join('')}</span>
            </div>
            <div class="font-mono text-[11px] text-txtMuted break-words">${escapeHtml(ln.movesText)}</div>
          </div>`;
        })
        .join('')}
    </div>
  </div>`;
}

function renderModal(ctx) {
  const host = ensureModalMounted();
  const isOppReply = ctx.triggerType === 'opponent_reply';
  const flawLbl = triggerLabel(ctx);
  const sideLbl = ctx.color === 'b' ? 'Black' : 'White';
  const scorePct = Math.round(ctx.flawedStats?.scorePct ?? 0);
  const total = Number(ctx.flawedStats?.total) || 0;
  const busy = ctx.stage === 'diagnosing' || ctx.stage === 'generating' || ctx.saving;

  host.innerHTML = `<div class="bg-panel border border-borderBright rounded-xl w-full max-w-xl max-h-[92vh] overflow-y-auto p-4 shadow-2xl flex flex-col gap-3">
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <h2 class="font-bold text-sm text-txt">${isOppReply ? `Prepare vs ${escapeHtml(flawLbl)} → Generate Repertoire` : 'Learn from Flaw → Generate Repertoire'}</h2>
        <div class="text-[11px] text-txtMuted mt-0.5 truncate">
          ${isOppReply ? '<span>vs </span>' : ''}<span class="font-mono font-semibold text-ro">${escapeHtml(flawLbl)}</span>
          <span> as ${sideLbl}</span>
          ${total ? `<span> · ${scorePct}% over ${total} game${total === 1 ? '' : 's'}</span>` : ''}
          ${ctx.openingName ? `<span> · ${escapeHtml(ctx.openingName)}</span>` : ''}
        </div>
      </div>
      <button type="button" id="btnFlawClose" class="text-txtMuted hover:text-txt px-1.5 py-0.5 text-sm" aria-label="Close modal">✕</button>
    </div>

    ${renderDiagnosisBlock(ctx)}
    ${ctx.explorerNote && ctx.stage === 'ready' && !ctx.generated ? `<div class="text-[10.5px] text-txtMuted bg-surface/60 border border-borderSubtle rounded px-2.5 py-1.5">${escapeHtml(ctx.explorerNote)}</div>` : ''}
    ${ctx.error ? `<div class="text-xs text-ro bg-ro/10 border border-ro/35 rounded-lg px-3 py-2">${escapeHtml(ctx.error)}</div>` : ''}
    ${renderConfigBlock(ctx)}
    ${renderProgressOrPreview(ctx)}

    <div class="flex items-center justify-between gap-2 pt-2 border-t border-borderSubtle flex-wrap">
      <button type="button" id="btnFlawCancel" class="px-3 py-1.5 rounded-md bg-surface hover:bg-surfaceHover border border-borderSubtle text-xs text-txtMuted">Close</button>
      <div class="flex items-center gap-2 flex-wrap">
        ${
          ctx.stage === 'preview' && ctx.generated
            ? `<button type="button" id="btnFlawRegen" ${busy ? 'disabled' : ''} class="px-3 py-1.5 rounded-md bg-surface hover:bg-surfaceHover border border-borderSubtle text-xs font-medium text-txt">Regenerate</button>
               <button type="button" id="btnFlawSaveOnly" ${busy ? 'disabled' : ''} class="px-3 py-1.5 rounded-md bg-cy/20 hover:bg-cy/30 border border-cy/45 text-cy text-xs font-semibold">Save to Repertoire</button>
               <button type="button" id="btnFlawSaveDrill" ${busy ? 'disabled' : ''} class="px-3.5 py-1.5 rounded-md bg-em hover:bg-emerald-400 text-[#041f15] text-xs font-bold">${ctx.saving ? 'Saving…' : 'Save & Drill Now →'}</button>`
            : `<button type="button" id="btnFlawGenerate" ${busy || !ctx.diagnosis ? 'disabled' : ''} class="px-4 py-1.5 rounded-md bg-em hover:bg-emerald-400 disabled:opacity-50 text-[#041f15] text-xs font-bold">${
                ctx.stage === 'generating' ? 'Generating…' : 'Generate Repertoire'
              }</button>`
        }
      </div>
    </div>
  </div>`;

  host.classList.remove('hidden');

  host.querySelector('#btnFlawClose')?.addEventListener('click', closeFlawRepertoireModal);
  host.querySelector('#btnFlawCancel')?.addEventListener('click', closeFlawRepertoireModal);
  host.querySelector('#btnFlawCancelGen')?.addEventListener('click', () => {
    if (abortCtrl) abortCtrl.abort();
  });

  host.querySelectorAll('[data-flaw-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const m = btn.dataset.flawMode;
      if (m !== 'replace' && m !== 'repair') return;
      ctx.mode = m;
      ctx.generated = null;
      if (ctx.stage === 'preview') ctx.stage = 'ready';
      if (!ctx.sectionEdited) ctx.sectionName = defaultSectionTitle(ctx);
      renderModal(ctx);
    });
  });

  host.querySelectorAll('[data-flaw-cand]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.flawCand);
      const cand = ctx.diagnosis?.candidates?.[idx];
      if (!cand) return;
      ctx.selectedCandidate = cand;
      ctx.generated = null;
      if (ctx.stage === 'preview') ctx.stage = 'ready';
      if (!ctx.sectionEdited) ctx.sectionName = defaultSectionTitle(ctx);
      renderModal(ctx);
    });
  });

  host.querySelectorAll('[data-flaw-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.flawPreset;
      if (!FLAW_PRESETS[key]) return;
      ctx.presetKey = key;
      ctx.generated = null;
      if (ctx.stage === 'preview') ctx.stage = 'ready';
      renderModal(ctx);
    });
  });

  host.querySelectorAll('[data-flaw-pool]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.flawPool;
      if (p !== 'peers' && p !== 'masters') return;
      if (ctx.pool === p) return;
      ctx.pool = p;
      runDiagnosis(ctx);
    });
  });

  const nameInput = host.querySelector('#flawSectionNameInput');
  if (nameInput) {
    nameInput.addEventListener('input', (e) => {
      ctx.sectionName = e.target.value;
      ctx.sectionEdited = true;
    });
  }

  host.querySelector('#btnFlawGenerate')?.addEventListener('click', () => runGeneration(ctx));
  host.querySelector('#btnFlawRegen')?.addEventListener('click', () => runGeneration(ctx));
  host.querySelector('#btnFlawSaveOnly')?.addEventListener('click', () => saveGenerated(ctx, { launchDrill: false }));
  host.querySelector('#btnFlawSaveDrill')?.addEventListener('click', () => saveGenerated(ctx, { launchDrill: true }));
}

/**
 * Open the Flaw-to-Repertoire generator modal for a specific position and flawed move.
 */
export async function openFlawRepertoireModal({
  prefixMoves = null,
  pathSans = null,
  startFen = START_FEN,
  fen = '',
  color = 'w',
  flawedUci = '',
  flawedSan = '',
  flawedStats = {},
  triggerType = 'user_move',
  oppMove = null,
  openingName = '',
  rating = null,
  tc = 'all',
  personalGames = [],
  onSaved = null,
  notify = null,
}) {
  const normColor = color === 'b' || color === 'black' ? 'b' : 'w';

  let resolvedPrefix = Array.isArray(prefixMoves) ? prefixMoves : [];
  let resolvedFen = fen;
  if (!resolvedPrefix.length && Array.isArray(pathSans) && pathSans.length) {
    const built = buildPrefixMovesFromSan(pathSans, startFen);
    resolvedPrefix = built.moves;
    if (!resolvedFen) resolvedFen = built.endFen;
  }
  if (!resolvedFen) {
    resolvedFen = resolvedPrefix.length ? resolvedPrefix[resolvedPrefix.length - 1].fen : startFen;
  }

  const existingDoc = await loadRepertoire();
  const existingRepertoire = existingDoc?.repertoire || null;
  const existingMoves = findExistingRepMovesAtFen(existingRepertoire, resolvedFen);

  // Pull local Insights games if caller didn't supply a full personal game set so we catch real losses.
  let mergedPersonalGames = Array.isArray(personalGames) ? [...personalGames] : [];
  if (mergedPersonalGames.length < 15) {
    try {
      const store = await import('../insights/store.js');
      const localGames = await store.loadAllGames();
      if (Array.isArray(localGames) && localGames.length) {
        mergedPersonalGames = [...mergedPersonalGames, ...localGames];
      }
    } catch (_) {
      /* Insights store optional */
    }
  }

  const ctx = {
    prefixMoves: resolvedPrefix,
    startFen,
    fen: resolvedFen,
    ply: resolvedPrefix.length,
    color: normColor,
    flawedUci,
    flawedSan,
    flawedStats,
    triggerType: triggerType === 'opponent_reply' ? 'opponent_reply' : 'user_move',
    oppMove,
    openingName: openingName && openingName !== '—' && openingName !== 'Starting Position' ? openingName : '',
    rating: Number(rating) || inferRatingFromGames(mergedPersonalGames, normColor),
    tc: tc || 'all',
    pool: 'peers',
    presetKey: 'standard',
    mode: triggerType === 'opponent_reply' ? 'vs_opponent' : 'replace',
    selectedCandidate: null,
    sectionName: '',
    sectionEdited: false,
    diagnosis: null,
    generated: null,
    explorerNote: '',
    poolLabel: '',
    existingRepertoire,
    existingMoves,
    personalGames: mergedPersonalGames,
    stage: 'diagnosing',
    progress: null,
    error: '',
    saving: false,
    onSaved,
    notify,
  };

  activeCtx = ctx;
  ensureModalMounted();
  runDiagnosis(ctx);
}
