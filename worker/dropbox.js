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

// Dropbox-API-Arg do /2/files/upload. Só o "add" leva autorename; com overwrite ele não faria
// sentido (e o nome tem que ser exatamente o pedido).
export function argUpload(caminhoCompleto, modo = "add") {
  if (modo === "overwrite") return { path: caminhoCompleto, mode: "overwrite" };
  return { path: caminhoCompleto, mode: "add", autorename: true };
}

// modo: "add" (padrão; comprovantes e /patrimonio) sobe com autorename — nunca apaga um arquivo
// que já existe, ganha "(1)". "overwrite" (C4, extrato/fatura original) substitui o arquivo do
// mesmo período: reimportar não pode deixar cópias.
export async function subirDropbox(env, caminhoCompleto, bytes, fetchImpl = fetch, modo = "add") {
  const tok = await accessToken(env, fetchImpl);
  const r = await fetchImpl("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tok}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify(argUpload(caminhoCompleto, modo)),
    },
    body: bytes,
  });
  if (!r.ok) throw new Error(`dropbox upload ${r.status}`);
  return (await r.json()).path_display;
}
