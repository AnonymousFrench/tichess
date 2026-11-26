export async function fetchChessComArchives(username) {
  const resp = await fetch(
    `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}/games/archives`
  );
  if (!resp.ok) throw new Error(`Player "${username}" not found on Chess.com`);
  const data = await resp.json();
  return data.archives || [];
}

export async function fetchChessComMonthGames(archiveUrl) {
  const resp = await fetch(archiveUrl);
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.games || [];
}
