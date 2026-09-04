export function parseUpdate(update) {
  if (update.callback_query) {
    const cq = update.callback_query;
    return { tipo: "callback", chatId: cq.message.chat.id, data: cq.data, messageId: cq.message.message_id };
  }
  const m = update.message;
  if (!m) return { tipo: "ignorar" };
  const chatId = m.chat.id;
  if (Array.isArray(m.photo) && m.photo.length) {
    const maior = m.photo.reduce((a, b) => (b.width > a.width ? b : a));
    return { tipo: "imagem", chatId, fileId: maior.file_id, mime: "image/jpeg", messageId: m.message_id, caption: m.caption || null };
  }
  if (m.document) {
    const mime = m.document.mime_type || "";
    if (mime.startsWith("image/")) return { tipo: "imagem", chatId, fileId: m.document.file_id, mime, messageId: m.message_id, caption: m.caption || null };
    if (mime === "application/pdf") return { tipo: "pdf", chatId, fileId: m.document.file_id, mime, messageId: m.message_id, caption: m.caption || null };
    return { tipo: "ignorar", chatId };
  }
  if (m.text) return { tipo: "texto", chatId, texto: m.text, messageId: m.message_id };
  return { tipo: "ignorar", chatId };
}

export async function downloadArquivo(token, fileId, fetchImpl = fetch) {
  const info = await (await fetchImpl(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`)).json();
  const path = info.result.file_path;
  const mime = path.endsWith(".pdf") ? "application/pdf" : path.endsWith(".png") ? "image/png" : "image/jpeg";
  const resp = await fetchImpl(`https://api.telegram.org/file/bot${token}/${path}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  return { bytes, mime };
}

export async function responder(token, chatId, texto, fetchImpl = fetch) {
  await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: texto }),
  });
}

export async function enviarConfirmacao(token, chatId, texto, transacaoId, fetchImpl = fetch) {
  await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId, text: texto,
      reply_markup: { inline_keyboard: [[{ text: "🗑 Apagar", callback_data: `del:${transacaoId}` }]] },
    }),
  });
}
