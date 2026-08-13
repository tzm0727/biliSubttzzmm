// biliSub Web 入口：初始化 + 事件绑定
// 依赖顺序（index.html）：core → login → download → docs → reader → ai-modal → article → app
(function () {
  const ui = window.ui;

  async function init() {
    ui.applyTheme(storage.loadTheme());
    ui.applyFont(storage.loadFontSize());
    ui.loadAiSettings();
    bindEvents();
    try {
      await api.sendCookies(storage.loadBiliCookies());
    } catch (_) {}
    await ui.refreshLoginStatus();
    await ui.refreshDocs();
    try {
      const h = await api.health();
      if (!h.ok) throw new Error("服务异常");
      ui.state.serverHasAiKey = !!h.hasAiKey;
      ui.$("server-key-hint").hidden = !h.hasAiKey;
      if (h.needsToken && !storage.loadAccessToken()) {
        const token = prompt("请输入访问口令（服务提供者会告知）：", "");
        if (token) storage.saveAccessToken(token);
      }
    } catch (e) {
      ui.appendLog("⚠ 无法连接本地服务，请先运行：node server.js");
      ui.appendLog("   （在 biliSub-web 目录下运行，然后刷新本页）");
    }
  }

  function bindEvents() {
    document.querySelectorAll(".tab").forEach((b) =>
      b.addEventListener("click", () => ui.switchView(b.dataset.view))
    );

    ui.$("login-btn").addEventListener("click", () => {
      ui.$("qr-modal").hidden = false;
      ui.startQr();
    });
    ui.$("qr-close").addEventListener("click", () => {
      ui.stopQrPolling();
      ui.$("qr-modal").hidden = true;
    });
    ui.$("qr-refresh").addEventListener("click", ui.startQr);
    ui.$("logout-btn").addEventListener("click", async () => {
      if (confirm("确定退出 B 站登录吗？")) {
        await ui.clearCookies();
      }
    });

    ui.$("article-start").addEventListener("click", ui.startArticle);
    ui.$("article-cancel").addEventListener("click", ui.cancelArticle);
    ui.$("article-open").addEventListener("click", () => {
      if (ui.state.articleSavedId) ui.openReader(ui.state.articleSavedId);
    });

    ui.$("start-btn").addEventListener("click", ui.startDownload);
    ui.$("cancel-btn").addEventListener("click", () => {
      if (ui.state.dlRunning) {
        ui.state.dlCancel = true;
        ui.$("dl-status").textContent = "正在取消…";
      }
    });

    ui.$("import-btn").addEventListener("click", () => ui.$("import-input").click());
    ui.$("import-input").addEventListener("change", async (e) => {
      await ui.importFiles(Array.from(e.target.files || []));
      e.target.value = "";
    });
    ui.$("doc-search").addEventListener(
      "input",
      ui.debounce(() => ui.refreshDocs(), 250)
    );

    ui.$("reader-back").addEventListener("click", () => {
      ui.saveReaderPos();
      ui.switchView("docs");
    });
    ui.$("reader-export").addEventListener("click", () => {
      if (ui.state.currentFile) ui.exportFile(ui.state.currentFile);
    });
    ui.$("reader-theme").addEventListener("click", () => {
      const next = document.body.classList.contains("dark") ? "light" : "dark";
      ui.applyTheme(next);
      storage.saveTheme(next);
    });
    ui.$("reader-font-plus").addEventListener("click", () => {
      const next = Math.min(28, Number(storage.loadFontSize()) + 2);
      ui.applyFont(next);
      storage.saveFontSize(next);
    });
    ui.$("reader-font-minus").addEventListener("click", () => {
      const next = Math.max(12, Number(storage.loadFontSize()) - 2);
      ui.applyFont(next);
      storage.saveFontSize(next);
    });
    window.addEventListener(
      "scroll",
      ui.debounce(ui.saveReaderPos, 300),
      { passive: true }
    );

    ui.$("save-ai-btn").addEventListener("click", () => {
      ui.saveAiSettings();
      alert("AI 设置已保存。");
    });
    ui.$("save-cookie-btn").addEventListener("click", ui.saveCookiesManually);
    ui.$("clear-cookie-btn").addEventListener("click", ui.clearCookies);

    ui.$("ai-close").addEventListener("click", () => {
      ui.$("ai-modal").hidden = true;
    });
    ui.$("ai-cancel").addEventListener("click", ui.cancelAi);
  }

  window.addEventListener("DOMContentLoaded", init);
})();
