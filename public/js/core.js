// biliSub Web 核心：全局状态 + 工具函数 + 视图切换 + 主题/字号 + AI 设置
// 该文件最先加载，定义 window.ui 命名空间，其余视图模块挂载其上。
(function () {
  const ui = (window.ui = {});

  const $ = (id) => document.getElementById(id);
  const state = {
    view: "download",
    files: [],
    currentFile: null,
    dlRunning: false,
    dlCancel: false,
    qrTimer: null,
    qrKey: "",
    aiBusy: false,
    aiAbort: null,
    aiRequestId: "",
    articleBusy: false,
    articleAbort: null,
    articleRequestId: "",
    articleSavedId: null,
    articleFinished: false,
    serverHasAiKey: false,
    shortName: true,
  };

  // ---------------- 工具 ----------------
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function sanitize(name) {
    let s = String(name || "").replace(/[\\/*?:"<>|]/g, "_");
    if (s.length > 150) s = s.slice(0, 147) + "...";
    return s || "untitled";
  }

  function formatBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function showToast(msg) {
    let el = document.querySelector(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 2600);
  }

  // ---------------- 日志/进度（下载页） ----------------
  function appendLog(msg) {
    const el = $("dl-log");
    el.textContent += msg + "\n";
    el.scrollTop = el.scrollHeight;
  }

  function setDlProgress(value, status) {
    $("dl-progress").value = value;
    $("dl-percent").textContent = Math.round(value) + "%";
    if (status) $("dl-status").textContent = status;
  }

  // ---------------- 视图切换 ----------------
  function switchView(view) {
    state.view = view;
    document.querySelectorAll(".tab").forEach((b) => {
      b.classList.toggle("active", b.dataset.view === view);
    });
    document.querySelectorAll(".view").forEach((v) => {
      v.classList.toggle("active", v.id === "view-" + view);
    });
    if (view === "docs") ui.refreshDocs();
    if (view === "reader" && !state.currentFile) {
      $("reader-name").textContent = "";
      $("reader-content").innerHTML =
        '<div class="doc-empty">还没有打开文档。请先在「文档」页选择一篇。</div>';
    }
  }

  // ---------------- 主题 / 字号 ----------------
  function applyTheme(theme) {
    const dark = theme === "dark";
    document.body.classList.toggle("dark", dark);
    $("reader-theme").textContent = dark ? "日间" : "夜间";
  }

  function applyFont(px) {
    document.documentElement.style.setProperty("--font-size", px + "px");
  }

  // ---------------- AI 设置 ----------------
  function loadAiSettings() {
    const cfg = storage.loadAiConfig();
    $("ai-key").value = cfg.apiKey || "";
    $("ai-model").value = cfg.model || "deepseek-chat";
    $("ai-chunk").value = cfg.chunkSize || 4500;
    $("ai-shortname").checked = cfg.shortName !== false;
    $("access-token").value = storage.loadAccessToken();
    state.aiKey = cfg.apiKey || "";
    state.shortName = $("ai-shortname").checked;
  }

  function saveAiSettings() {
    const cfg = {
      apiKey: $("ai-key").value.trim(),
      model: $("ai-model").value,
      chunkSize: Number($("ai-chunk").value) || 4500,
      shortName: $("ai-shortname").checked,
    };
    storage.saveAiConfig(cfg);
    storage.saveAccessToken($("access-token").value.trim());
    state.aiKey = cfg.apiKey;
    state.shortName = cfg.shortName;
  }

  function aiSettings() {
    return {
      apiKey: $("ai-key").value.trim(),
      model: $("ai-model").value,
      chunkSize: Number($("ai-chunk").value) || 4500,
    };
  }

  Object.assign(ui, {
    $,
    state,
    sleep,
    escapeHtml,
    sanitize,
    formatBytes,
    debounce,
    showToast,
    appendLog,
    setDlProgress,
    switchView,
    applyTheme,
    applyFont,
    loadAiSettings,
    saveAiSettings,
    aiSettings,
  });
})();
