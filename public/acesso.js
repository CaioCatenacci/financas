// Token na URL -> cookie -> segue pro app. Sem login, sem conta.
(function () {
  const url = new URL(location.href);
  const t = url.searchParams.get("token");
  if (t) {
    document.cookie = `token=${t}; path=/; max-age=31536000; samesite=strict`;
    url.searchParams.delete("token");
    location.replace(url.pathname + url.search);
  }
})();
