const POLICY = {
  reserved: new Set(["admin","administrator","moderator","mod","developer","dev","support","staff","official","system","owner","google","googleplay","playgames","gett heflick","gettheflick","gettheflickoutmyway","bluetoes","flickgauntlet"]),
  blocked_compact: ["fuck","shit","bitch","cunt","nigger","faggot","porn","hentai","dick","pussy","cock","puta","puto","mierda","cono","pendejo","cabron","merde","putain","salope","connard","scheisse","fotze","hurensohn","cazzo","merda","puttana","porra","caralho","kurwa","chuj","kanker","kut","blyat","suka","khuy","siktir","orospu","sharmouta","caonima","chinko","manko","ssibal","madarchod","bhenchod","chutiya","putangina","kontol","memek","fack","fcuk","phuck","fuk","fuq"],
  blocked_words: ["sex","rape","nazi","kkk","drugs","cocaine","heroin","meth"]
};

const DELETION_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Get the Flick Out My Way - Account Deletion</title>
</head>
<body>
  <h1>Get the Flick Out My Way Account Deletion</h1>
  <p>To request deletion of your Get the Flick Out My Way game account and associated game data, email: <a href="mailto:whodiniloco@gmail.com">whodiniloco@gmail.com</a></p>
  <h2>What to include</h2>
  <p>Include your player name, device/platform, approximate last play date, and say that you want your Get the Flick Out My Way account and associated data deleted.</p>
  <h2>Data deleted with your account</h2>
  <p>Game profile data, saved progress, cloud save records, player name records, leaderboard/ranking data, and other game account data controlled by the game.</p>
  <h2>Data that is not deleted</h2>
  <p>This does not delete your Google account, Google Play profile, device account, store purchase history, payment records, or data controlled separately by Google or another platform provider.</p>
  <h2>Retention</h2>
  <p>Some records may be retained where required for security, fraud prevention, legal compliance, payment records, dispute handling, or platform obligations.</p>
  <h2>Local device data</h2>
  <p>You can also delete local game profile data inside the app from: Settings &gt; Account / Data &gt; Delete Account / Data.</p>
</body>
</html>`;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function response(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function compactName(value) {
  const substitutions = new Map([
    ["0", "o"], ["1", "i"], ["3", "e"], ["4", "a"], ["5", "s"],
    ["7", "t"], ["8", "b"], ["@", "a"], ["$", "s"], ["!", "i"]
  ]);
  return [...value.normalize("NFKD").toLowerCase()]
    .map((char) => substitutions.get(char) || char)
    .filter((char) => /[\p{Letter}\p{Number}]/u.test(char))
    .join("");
}

function validRequestId(value) {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

async function googlePlayer(env, authCode) {
  const tokenBody = new URLSearchParams();
  tokenBody.set("code", authCode);
  tokenBody.set("client_id", env.PLAY_GAMES_WEB_CLIENT_ID);
  tokenBody.set("client_secret", env.PLAY_GAMES_WEB_CLIENT_SECRET);
  tokenBody.set("grant_type", "authorization_code");

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody
  });
  if (!tokenResponse.ok) throw new Error("play_games_auth_failed");

  const token = await tokenResponse.json();
  const playerResponse = await fetch("https://games.googleapis.com/games/v1/players/me", {
    headers: { authorization: `Bearer ${token.access_token}` }
  });
  if (!playerResponse.ok) throw new Error("play_games_auth_failed");

  const player = await playerResponse.json();
  if (!player.playerId || String(player.playerId).length > 256) {
    throw new Error("play_games_auth_failed");
  }
  return String(player.playerId);
}

async function reserveName(request, env) {
  const body = await request.json();
  if (!body.auth_code || !body.display_name || !body.canonical_name) {
    return response(400, { detail: "invalid_request" });
  }

  const display = String(body.display_name).trim();
  const canonical = compactName(display);
  if (
    display.length < 3 ||
    display.length > 16 ||
    canonical.length < 3 ||
    canonical !== String(body.canonical_name) ||
    !/^[\p{Letter}\p{Number}_ -]+$/u.test(display)
  ) {
    return response(400, { detail: "invalid_name" });
  }

  const displayWords = display.toLowerCase().split(/\s+/);
  if (
    POLICY.reserved.has(canonical) ||
    POLICY.blocked_compact.some((word) => canonical.includes(word)) ||
    POLICY.blocked_words.some((word) => displayWords.includes(word))
  ) {
    return response(400, { detail: "blocked" });
  }

  let playerId;
  try {
    playerId = await googlePlayer(env, String(body.auth_code));
  } catch (_err) {
    return response(401, { detail: "play_games_auth_failed" });
  }

  const deleted = await env.DB.prepare("SELECT 1 FROM deleted_players WHERE player_id = ?")
    .bind(playerId)
    .first();
  if (deleted) return response(403, { detail: "account_deleted" });

  const existing = await env.DB.prepare("SELECT player_id FROM names WHERE canonical = ?")
    .bind(canonical)
    .first();
  if (existing && existing.player_id !== playerId) {
    return response(409, { detail: "taken" });
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM names WHERE player_id = ? AND canonical <> ?").bind(playerId, canonical),
    env.DB.prepare(
      "INSERT INTO names(canonical, player_id, display_name, updated_at) VALUES(?, ?, ?, CURRENT_TIMESTAMP) " +
      "ON CONFLICT(canonical) DO UPDATE SET display_name = excluded.display_name, updated_at = CURRENT_TIMESTAMP " +
      "WHERE names.player_id = excluded.player_id"
    ).bind(canonical, playerId, display)
  ]);

  return response(200, { canonical_name: canonical });
}

async function deleteAccount(request, env) {
  const body = await request.json();
  if (!body.auth_code || !validRequestId(body.request_id)) {
    return response(400, { detail: "invalid_request" });
  }

  let playerId;
  try {
    playerId = await googlePlayer(env, String(body.auth_code));
  } catch (_err) {
    return response(401, { detail: "play_games_auth_failed" });
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM names WHERE player_id = ?").bind(playerId),
    env.DB.prepare(
      "INSERT INTO deleted_players(player_id, request_id, deleted_at) VALUES(?, ?, CURRENT_TIMESTAMP) " +
      "ON CONFLICT(player_id) DO NOTHING"
    ).bind(playerId, body.request_id)
  ]);

  return response(200, { request_id: body.request_id, deleted: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(DELETION_PAGE, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300"
        }
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return response(200, { ok: true });
    }

    if (request.method !== "POST") {
      return response(405, { detail: "method_not_allowed" });
    }

    try {
      if (url.pathname === "/v1/names/reserve") return await reserveName(request, env);
      if (url.pathname === "/v1/accounts/delete") return await deleteAccount(request, env);
      return response(404, { detail: "not_found" });
    } catch (_err) {
      return response(500, { detail: "server_error" });
    }
  }
};
