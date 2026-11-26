import { fetchJson } from './http.js';

export async function fetchChessComArchives(username, { signal } = {}) {
  try {
    const data = await fetchJson(
      `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}/games/archives`,
      { signal }
    );
    return data?.archives || [];
  } catch (err) {
    if (err.status === 404) {
      throw new Error(`Player "${username}" not found on Chess.com`);
    }
    throw err;
  }
}

export async function fetchChessComMonthGames(archiveUrl, { signal } = {}) {
  try {
    const data = await fetchJson(archiveUrl, { signal, allow404: true });
    return data?.games || [];
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'RateLimitError') throw err;
    return [];
  }
}
