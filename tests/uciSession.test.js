import { describe, it, expect } from 'vitest';
import { createUciSession } from '../src/engines/uciSession.js';

const FEN_1 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const FEN_2 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
const FEN_3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';

describe('createUciSession search synchronization', () => {
  it('drops stale info lines after stop and waits for bestmove before starting the next search', () => {
    const sent = [];
    const receivedInfo = [];
    const session = createUciSession((cmd) => sent.push(cmd));
    session.onInfo((line, fen) => receivedInfo.push({ line, fen }));

    // First search starts immediately while idle
    session.analyze(FEN_1, 'go depth 18');
    expect(sent).toEqual([`position fen ${FEN_1}`, 'go depth 18']);

    // Normal info line during first search is delivered with FEN_1
    session.onLine('info depth 10 multipv 1 score cp 20 pv e7e5');
    expect(receivedInfo).toHaveLength(1);
    expect(receivedInfo[0].fen).toBe(FEN_1);

    // Move to FEN_2 while engine is still searching FEN_1
    session.analyze(FEN_2, 'go depth 18');
    expect(sent).toEqual([`position fen ${FEN_1}`, 'go depth 18', 'stop']);

    // Engine emits 2 stale info lines from FEN_1 before bestmove — BOTH must be dropped
    session.onLine('info depth 11 multipv 1 score cp 22 pv c7c5');
    session.onLine('info depth 12 multipv 1 score cp 25 pv e7e6');
    expect(receivedInfo).toHaveLength(1);

    // Engine finishes old search with bestmove -> now FEN_2 is dispatched
    session.onLine('bestmove e7e5');
    expect(sent).toEqual([
      `position fen ${FEN_1}`,
      'go depth 18',
      'stop',
      `position fen ${FEN_2}`,
      'go depth 18',
    ]);

    // Info for FEN_2 is delivered tagged with FEN_2
    session.onLine('info depth 8 multipv 1 score cp 30 pv g1f3');
    expect(receivedInfo).toHaveLength(2);
    expect(receivedInfo[1].fen).toBe(FEN_2);
  });

  it('sends preCmds (e.g. Lc0 Contempt) only after engine becomes idle and coalesces rapid requests', () => {
    const sent = [];
    const session = createUciSession((cmd) => sent.push(cmd));

    session.analyze(FEN_1, 'go infinite', ['setoption name Contempt value 0']);
    // Rapidly move twice before bestmove arrives
    session.analyze(FEN_2, 'go infinite', ['setoption name Contempt value 20']);
    session.analyze(FEN_3, 'go infinite', ['setoption name Contempt value 40']);

    // Only one `stop` sent and no mid-search setoption
    expect(sent).toEqual([
      'setoption name Contempt value 0',
      `position fen ${FEN_1}`,
      'go infinite',
      'stop',
    ]);

    // Once bestmove arrives, only the latest pending job (FEN_3 + Contempt 40) is sent
    session.onLine('bestmove e7e5');
    expect(sent.slice(4)).toEqual([
      'setoption name Contempt value 40',
      `position fen ${FEN_3}`,
      'go infinite',
    ]);
  });

  it('cancels pending jobs and suppresses stale info when stop() is called', () => {
    const sent = [];
    const received = [];
    const session = createUciSession((cmd) => sent.push(cmd));
    session.onInfo((line, fen) => received.push({ line, fen }));

    session.analyze(FEN_1, 'go depth 18');
    session.stop();
    session.onLine('info depth 14 multipv 1 score cp 15 pv e7e5');
    session.onLine('bestmove e7e5');

    expect(received).toHaveLength(0);
    expect(session.getStatus().status).toBe('idle');
  });
});
