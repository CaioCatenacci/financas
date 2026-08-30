// Sobe bytes pro Dropbox. Refresh token -> access token curto -> /2/files/upload.
async function accessToken(env, fetchImpl) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: env.DROPBOX_REFRESH,
    client_id: env.DROPBOX_APP_KEY,
    client_secret: env.DROPBOX_APP_SECRET,
  });
  const r = await fetchImpl("https://api.dropbox.com/oauth2/token", { method: "POST", body });
  if (!r.ok) throw new Error(`dropbox token ${r.status}`);
  return (await r.json()).access_token;
}

export async function subirDropbox(env, caminhoCompleto, bytes, fetchImpl = fetch) {
  const tok = await accessToken(env, fetchImpl);
  const r = await fetchImpl("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tok}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ path: caminhoCompleto, mode: "add", autorename: true }),
    },
    body: bytes,
  });
  if (!r.ok) throw new Error(`dropbox upload ${r.status}`);
  return (await r.json()).path_display;
}
