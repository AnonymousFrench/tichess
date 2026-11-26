/**
 * Synchronized UCI search session controller.
 *
 * Prevents stale `info` lines from a previous search from leaking into a new
 * position and ensures `setoption` / `position` / `go` commands are only sent
 * once the engine is idle (after `bestmove` from any previous search).
 */
export function createUciSession(send, { stopTimeoutMs = 3000 } = {}) {
  let status = 'idle'; // 'idle' | 'searching' | 'stopping'
  let activeFen = null;
  let pending = null;
  let stopTimer = null;

  const infoListeners = new Set();
  const bestmoveListeners = new Set();

  function clearStopTimer() {
    if (stopTimer !== null) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
  }

  function dispatch(job) {
    clearStopTimer();
    activeFen = job.fen;
    status = 'searching';
    if (Array.isArray(job.preCmds)) {
      for (const cmd of job.preCmds) {
        if (cmd) send(cmd);
      }
    }
    send(`position fen ${job.fen}`);
    send(job.goCmd);
  }

  function armStopTimeout() {
    clearStopTimer();
    stopTimer = setTimeout(() => {
      stopTimer = null;
      if (status !== 'stopping') return;
      status = 'idle';
      activeFen = null;
      send('isready');
      if (pending) {
        const next = pending;
        pending = null;
        dispatch(next);
      }
    }, stopTimeoutMs);
  }

  return {
    analyze(fen, goCmd, preCmds = []) {
      const job = { fen, goCmd, preCmds };
      if (status === 'idle') {
        dispatch(job);
        return;
      }
      pending = job;
      if (status === 'searching') {
        status = 'stopping';
        activeFen = null;
        send('stop');
        armStopTimeout();
      }
    },

    stop() {
      pending = null;
      if (status === 'searching') {
        status = 'stopping';
        activeFen = null;
        send('stop');
        armStopTimeout();
      } else if (status === 'stopping') {
        activeFen = null;
      }
    },

    onLine(rawLine) {
      const line = typeof rawLine === 'string' ? rawLine.trim() : '';
      if (!line) return;

      if (line.startsWith('bestmove')) {
        clearStopTimer();
        const finishedFen = activeFen;
        const wasSearching = status === 'searching';
        activeFen = null;
        status = 'idle';

        if (wasSearching && finishedFen) {
          for (const cb of bestmoveListeners) {
            cb(line, finishedFen);
          }
        }

        if (pending) {
          const next = pending;
          pending = null;
          dispatch(next);
        }
        return;
      }

      if (line.startsWith('info ') && status === 'searching' && activeFen) {
        for (const cb of infoListeners) {
          cb(line, activeFen);
        }
      }
    },

    onInfo(cb) {
      infoListeners.add(cb);
      return () => infoListeners.delete(cb);
    },

    onBestmove(cb) {
      bestmoveListeners.add(cb);
      return () => bestmoveListeners.delete(cb);
    },

    reset() {
      clearStopTimer();
      status = 'idle';
      activeFen = null;
      pending = null;
    },

    getStatus() {
      return { status, activeFen, hasPending: Boolean(pending) };
    },
  };
}
