// biliSub Web 主逻辑
(function () {
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

  // ---------------- 日志/进度 ----------------
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
    if (view === "docs") refreshDocs();
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

  // ---------------- 初始化 ----------------
  async function init() {
    applyTheme(storage.loadTheme());
    applyFont(storage.loadFontSize());
    loadAiSettings();
    bindEvents();
    try {
      await api.sendCookies(storage.loadBiliCookies());
    } catch (_) {}
    await refreshLoginStatus();
    await refreshDocs();
    try {
      const h = await api.health();
      if (!h.ok) throw new Error("服务异常");
      state.serverHasAiKey = !!h.hasAiKey;
      $("server-key-hint").hidden = !h.hasAiKey;
      if (h.needsToken && !storage.loadAccessToken()) {
        const token = prompt("请输入访问口令（服务提供者会告知）：", "");
        if (token) storage.saveAccessToken(token);
      }
    } catch (e) {
      appendLog("⚠ 无法连接本地服务，请先运行：node server.js");
      appendLog("   （在 biliSub-web 目录下运行，然后刷新本页）");
    }
  }

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

  // ---------------- 登录 ----------------
  async function refreshLoginStatus() {
    try {
      const data = await api.nav();
      const isLogin = !!(data.json && data.json.data && data.json.data.isLogin);
      const badge = $("login-status");
      badge.textContent = isLogin ? "已登录" : "未登录";
      badge.classList.toggle("on", isLogin);
      badge.classList.toggle("off", !isLogin);
      $("login-btn").hidden = isLogin;
      $("logout-btn").hidden = !isLogin;
    } catch (_) {
      const badge = $("login-status");
      badge.textContent = "服务未连接";
      badge.classList.add("off");
      badge.classList.remove("on");
    }
  }

  function stopQrPolling() {
    if (state.qrTimer) {
      clearInterval(state.qrTimer);
      state.qrTimer = null;
    }
  }

  async function startQr() {
    stopQrPolling();
    $("qr-status").textContent = "正在获取二维码…";
    try {
      const data = await api.qrGenerate();
      if (data.code !== 0 || !data.data || !data.data.url) {
        throw new Error(data.message || "生成二维码失败");
      }
      state.qrKey = data.data.qrcode_key;
      if (window.QRCode) {
        await QRCode.toCanvas($("qr-canvas"), data.data.url, {
          width: 240,
          margin: 1,
        });
      } else {
        throw new Error("二维码组件缺失");
      }
      $("qr-status").textContent = "请用 B 站 App 扫码";
      const direct = $("qr-direct");
      direct.href = data.data.url;
      direct.hidden = false;
      state.qrTimer = setInterval(pollQr, 2000);
    } catch (e) {
      $("qr-status").textContent = "二维码获取失败：" + e.message;
    }
  }

  async function pollQr() {
    try {
      const data = await api.qrPoll(state.qrKey);
      const result = data.result || {};
      if (result.code !== 0) throw new Error(result.message || "登录接口异常");
      const d = result.data || {};
      const code = d.code;
      if (code === 86101) {
        $("qr-status").textContent = "已扫码，请在手机上确认";
      } else if (code === 86090) {
        $("qr-status").textContent = "请在手机上点击确认";
      } else if (code === 86038 || code === -2) {
        $("qr-status").textContent = "二维码已过期/失效，请刷新";
        stopQrPolling();
      } else if (code === 0) {
        stopQrPolling();
        $("qr-modal").hidden = true;
        appendLog("登录成功，凭据已保存在本机。");
        await refreshLoginStatus();
      } else {
        $("qr-status").textContent = "登录状态异常（code=" + code + "），请刷新";
      }
    } catch (e) {
      $("qr-status").textContent = "轮询失败：" + e.message;
    }
  }

  function parseCookieText(text) {
    const arr = [];
    for (const part of String(text || "").split(";")) {
      const idx = part.indexOf("=");
      if (idx <= 0) continue;
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (name) arr.push({ name, value, domain: ".bilibili.com", path: "/" });
    }
    return arr;
  }

  async function saveCookiesManually() {
    const arr = parseCookieText($("cookie-text").value);
    if (!arr.length) {
      alert("没有解析到 Cookie，请按 SESSDATA=...; bili_jct=... 的格式填写。");
      return;
    }
    storage.saveBiliCookies(arr);
    await api.sendCookies(arr);
    await refreshLoginStatus();
    appendLog("已保存 " + arr.length + " 条 Cookie。");
  }

  async function clearCookies() {
    storage.clearBiliCookies();
    await api.sendCookies([]);
    $("cookie-text").value = "";
    await refreshLoginStatus();
    appendLog("已清除 B 站登录凭据。");
  }

  // ---------------- 下载 ----------------
  function langRank(lan) {
    let lang = (lan || "").toLowerCase().replace(/_/g, "-");
    if (lang.startsWith("ai-")) lang = lang.slice(3);
    if (lang.startsWith("zh")) return 0;
    if (lang.startsWith("en")) return 1;
    return 2;
  }

  function selectPreferred(list) {
    return [...list].sort(
      (a, b) => langRank(a.lan) - langRank(b.lan)
    )[0];
  }

  function parseSubtitleBody(json) {
    const body = (json && json.body) || [];
    const out = [];
    for (const item of body) {
      const text = String(item.content || "").trim();
      if (!text) continue;
      out.push({
        start: Number(item.from) || 0,
        end: Number(item.to) || 0,
        content: text,
        lang: (json && json.lang) || "zh",
      });
    }
    return out;
  }

  function cleanSegments(segments) {
    const cleaned = [];
    for (let s of segments) {
      let content = s.content
        .replace(/关注.*?获取更多精彩内容/g, "")
        .replace(/#.*?#/g, "")
        .replace(/\s*——{2,}\s*/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!content) continue;
      cleaned.push(Object.assign({}, s, { content }));
    }
    if (cleaned.length > 1) {
      const merged = [cleaned[0]];
      for (const cur of cleaned.slice(1)) {
        const prev = merged[merged.length - 1];
        const timeDiff = cur.start - prev.end;
        if (
          timeDiff < 0.5 &&
          prev.content.length < 20 &&
          cur.content.length < 20
        ) {
          prev.content = prev.content + " " + cur.content;
          prev.end = cur.end;
        } else {
          merged.push(cur);
        }
      }
      return merged;
    }
    return cleaned;
  }

  function fmtSrtTime(sec) {
    const ms = Math.floor((sec % 1) * 1000);
    const s = Math.floor(sec % 60);
    const m = Math.floor((sec / 60) % 60);
    const h = Math.floor(sec / 3600);
    return (
      String(h).padStart(2, "0") +
      ":" +
      String(m).padStart(2, "0") +
      ":" +
      String(s).padStart(2, "0") +
      "," +
      String(ms).padStart(3, "0")
    );
  }

  function fmtVttTime(sec) {
    return fmtSrtTime(sec).replace(",", ".");
  }

  function fmtLrcTime(sec) {
    const ms = Math.floor((sec % 1) * 100);
    const s = Math.floor(sec % 60);
    const m = Math.floor(sec / 60);
    return (
      String(m).padStart(2, "0") +
      ":" +
      String(s).padStart(2, "0") +
      "." +
      String(ms).padStart(2, "0")
    );
  }

  function generateFormat(segments, fmt, info) {
    if (fmt === "txt") {
      return segments.map((s) => s.content).join("\n") + "\n";
    }
    if (fmt === "srt") {
      return segments
        .map(
          (s, i) =>
            `${i + 1}\n${fmtSrtTime(s.start)} --> ${fmtSrtTime(s.end)}\n${s.content}\n`
        )
        .join("\n");
    }
    if (fmt === "vtt") {
      return (
        "WEBVTT\n\n" +
        segments
          .map(
            (s, i) =>
              `${i + 1}\n${fmtVttTime(s.start)} --> ${fmtVttTime(s.end)}\n${s.content}\n`
          )
          .join("\n")
      );
    }
    if (fmt === "json") {
      return JSON.stringify(
        {
          title: info.title || "",
          bvid: info.bvid || "",
          lang: info.lang || "",
          subtitles: segments.map((s) => ({
            from: s.start,
            to: s.end,
            content: s.content,
          })),
        },
        null,
        2
      );
    }
    if (fmt === "lrc") {
      const total = segments.reduce((a, s) => a + (s.end - s.start), 0);
      return (
        "[ti:Bilibili Subtitle]\n" +
        "[length:" +
        total.toFixed(2) +
        "]\n" +
        segments.map((s) => `[${fmtLrcTime(s.start)}]${s.content}`).join("\n") +
        "\n"
      );
    }
    if (fmt === "ass") {
      const header = `[Script Info]
; Script generated by BiliSub
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
Collisions: Normal
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Microsoft YaHei,50,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,2,10,10,20,0
Style: ZH,Microsoft YaHei,50,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,2,10,10,20,0
Style: EN,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,2,10,10,60,0

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
      const lines = segments.map((s) => {
        const st = fmtSrtTime(s.start);
        const et = fmtSrtTime(s.end);
        if (s.content.includes("\n")) {
          const parts = s.content.split("\n");
          const zh = (parts[0] || "").trim();
          const en = (parts.slice(1).join("\n") || "").trim();
          let out = "";
          if (zh) out += `Dialogue: 0,${st},${et},ZH,,0,0,0,,${zh}\n`;
          if (en) out += `Dialogue: 0,${st},${et},EN,,0,0,0,,${en}\n`;
          return out;
        }
        const style = String(s.lang).toLowerCase().startsWith("en") ? "EN" : "ZH";
        return `Dialogue: 0,${st},${et},${style},,0,0,0,,${s.content}`;
      });
      return header + lines.join("\n") + "\n";
    }
    throw new Error("不支持的格式：" + fmt);
  }

  async function startDownload() {
    if (state.dlRunning) return;
    const urls = $("links").value
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!urls.length) {
      alert("请先粘贴至少一个 B 站视频链接。");
      return;
    }
    const formats = Array.from(
      document.querySelectorAll(".fmt-row input:checked")
    ).map((i) => i.value);
    if (!formats.length) formats.push("txt");

    let loggedIn = false;
    try {
      const nav = await api.nav();
      loggedIn = !!(nav.json && nav.json.data && nav.json.data.isLogin);
    } catch (_) {}
    if (!loggedIn) {
      const ok = confirm(
        "尚未登录 B 站，可能下载不到字幕。\n\n继续吗？（建议先点右上角「扫码登录」）"
      );
      if (!ok) return;
    }

    state.dlRunning = true;
    state.dlCancel = false;
    $("start-btn").disabled = true;
    $("cancel-btn").disabled = false;
    setDlProgress(0, "正在解析链接…");
    appendLog("========== 开始下载 ==========");

    let ok = 0;
    let fail = 0;
    for (let i = 0; i < urls.length; i++) {
      if (state.dlCancel) break;
      const url = urls[i];
      appendLog(`[${i + 1}/${urls.length}] 解析链接：${url}`);
      try {
        const r = await api.resolve(url);
        if (r.error) throw new Error(r.error);
        const bvid = r.bvid;
        const page = r.page || 1;
        setDlProgress((i / urls.length) * 100, `获取视频信息… ${bvid}`);

        const view = await api.view(bvid);
        const vj = view.json || {};
        if (vj.code !== 0) throw new Error(vj.message || "获取视频信息失败");
        const vdata = vj.data || {};
        const pages = vdata.pages || [];
        const idx = Math.min(Math.max(page - 1, 0), pages.length - 1);
        const pinfo = pages[idx] || {};
        const cid = pinfo.cid || vdata.cid;
        const title = pinfo.part ? `${vdata.title}_${pinfo.part}` : vdata.title || bvid;
        appendLog(`视频：${title}`);

        const subs = await api.subtitles(bvid, cid);
        const sj = subs.json || {};
        if (sj.code !== 0) throw new Error(sj.message || "获取字幕列表失败");
        const list = (sj.data && sj.data.subtitle && sj.data.subtitle.subtitles) || [];
        appendLog(`获取到 ${list.length} 条字幕`);
        if (!list.length) {
          appendLog("没有找到字幕（可能需要登录，或该视频没有官方字幕）。");
          fail++;
          continue;
        }

        const preferred = selectPreferred(list);
        const lan = preferred.lan || "";
        appendLog(
          `选择字幕语言：${lan}${preferred.lan_doc ? "（" + preferred.lan_doc + "）" : ""}`
        );
        let subUrl = preferred.subtitle_url || "";
        if (!/^https?:/i.test(subUrl)) subUrl = "https:" + subUrl;
        const sc = await api.subtitle(subUrl);
        if (!sc.json) throw new Error("字幕内容解析失败");
        const segments = cleanSegments(parseSubtitleBody(sc.json));
        if (!segments.length) {
          appendLog("字幕内容为空。");
          fail++;
          continue;
        }

        let cleanTitle = sanitize(title);
        if (state.shortName) {
          try {
            const short = await ai.shortFileName(title, aiSettings());
            if (short) cleanTitle = sanitize(short);
          } catch (_) {
            cleanTitle = ai.fallbackShortName(title);
          }
        }
        for (const fmt of formats) {
          const content = generateFormat(segments, fmt, {
            title,
            bvid,
            lang: lan,
          });
          const name = `${cleanTitle}.${fmt}`;
          await storage.saveFile({
            name,
            ext: fmt,
            content,
            bvid,
            lang: lan,
            meta: { title, cid, page, lang: lan },
          });
        }
        appendLog(`✔ 已保存：${cleanTitle}.${formats.join(", ")}`);
        ok++;
        await sleep(800);
      } catch (e) {
        appendLog(`✘ 失败：${e.message}`);
        fail++;
      }
      setDlProgress(((i + 1) / urls.length) * 100, `已完成 ${i + 1}/${urls.length}`);
    }

    const msg = state.dlCancel
      ? "已取消下载"
      : `下载完成：成功 ${ok} 个，失败 ${fail} 个`;
    setDlProgress(state.dlCancel ? 0 : 100, msg);
    appendLog(msg);
    state.dlRunning = false;
    $("start-btn").disabled = false;
    $("cancel-btn").disabled = true;
    await refreshDocs();
  }

  // ---------------- 文档管理 ----------------
  async function refreshDocs() {
    state.files = await storage.listFiles();
    const q = $("doc-search").value.trim().toLowerCase();
    const list = q
      ? state.files.filter((f) => f.name.toLowerCase().includes(q))
      : state.files;
    const el = $("doc-list");
    if (!list.length) {
      el.innerHTML =
        '<div class="doc-empty">还没有文档。去「下载」页粘贴链接，或点击「导入文件」添加本地字幕。</div>';
      return;
    }
    el.innerHTML = "";
    for (const f of list) {
      const item = document.createElement("div");
      item.className = "doc-item";

      const icon = document.createElement("div");
      const ext = String(f.ext || "other").toLowerCase();
      icon.className = "doc-icon " + (["txt", "srt", "ass", "vtt", "json", "lrc", "md"].includes(ext) ? ext : "other");
      icon.textContent = ext.slice(0, 4).toUpperCase();

      const main = document.createElement("div");
      main.className = "doc-main";
      const name = document.createElement("div");
      name.className = "doc-name";
      name.textContent = f.name;
      name.title = "点击阅读";
      name.addEventListener("click", (e) => {
        e.stopPropagation();
        openReader(f.id);
      });
      const meta = document.createElement("div");
      meta.className = "doc-meta";
      meta.textContent =
        formatBytes(f.size || 0) +
        " · " +
        new Date(f.updatedAt || Date.now()).toLocaleString() +
        (f.lang ? " · " + f.lang : "");
      main.append(name, meta);

      const expand = document.createElement("div");
      expand.className = "doc-expand";
      expand.hidden = true;
      if (f.meta && f.meta.from) {
        const src = document.createElement("div");
        src.className = "doc-source";
        src.textContent = "来源：" + f.meta.from;
        expand.appendChild(src);
      }
      const actions = document.createElement("div");
      actions.className = "doc-actions";
      actions.append(
        actionBtn("阅读", () => openReader(f.id)),
        actionBtn("润色", () => startAi("polish", f), !["txt", "srt", "vtt"].includes(ext)),
        actionBtn("生成文章", () => startAi("article", f), !["txt", "srt", "vtt"].includes(ext)),
        actionBtn("导出", () => exportFile(f)),
        actionBtn("重命名", () => renameFile(f)),
        actionBtn("删除", () => deleteFile(f))
      );
      expand.appendChild(actions);

      item.addEventListener("click", (e) => {
        if (e.target.closest(".doc-actions") || e.target.closest(".doc-name")) {
          return;
        }
        const show = expand.hidden;
        expand.hidden = !show;
        item.classList.toggle("expanded", show);
      });

      item.append(icon, main, expand);
      el.appendChild(item);
    }
  }

  function actionBtn(label, fn, disabled) {
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = label;
    b.disabled = !!disabled;
    b.addEventListener("click", fn);
    return b;
  }

  async function exportFile(f) {
    const type =
      String(f.ext).toLowerCase() === "md"
        ? "text/markdown;charset=utf-8"
        : "text/plain;charset=utf-8";
    const blob = new Blob([f.content], { type });
    const file = new File([blob], f.name, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ title: f.name, files: [file] });
        showToast("已分享/导出");
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return; // 用户取消分享
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    }, 1000);
    showToast("已导出：" + f.name);
  }

  async function renameFile(f) {
    const name = prompt("新的文件名：", f.name);
    if (!name || name === f.name) return;
    await storage.renameFile(f.id, name);
    await refreshDocs();
  }

  async function deleteFile(f) {
    if (!confirm(`确定删除「${f.name}」吗？删除后无法恢复。`)) return;
    await storage.deleteFile(f.id);
    if (state.currentFile && state.currentFile.id === f.id) {
      state.currentFile = null;
      $("reader-name").textContent = "";
      $("reader-content").innerHTML =
        '<div class="doc-empty">文档已删除。</div>';
    }
    await refreshDocs();
  }

  function readFileText(file) {
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => {
        try {
          const buf = new Uint8Array(fr.result);
          let text = new TextDecoder("utf-8").decode(buf);
          if ((text.match(/\uFFFD/g) || []).length > 2) {
            try {
              text = new TextDecoder("gb18030").decode(buf);
            } catch (_) {}
          }
          resolve(text);
        } catch (_) {
          resolve(null);
        }
      };
      fr.onerror = () => resolve(null);
      fr.readAsArrayBuffer(file);
    });
  }

  async function importFiles(fileList) {
    for (const file of fileList) {
      const text = await readFileText(file);
      if (text === null) continue;
      const dot = file.name.lastIndexOf(".");
      const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "txt";
      await storage.saveFile({ name: file.name, ext, content: text });
    }
    await refreshDocs();
  }

  // ---------------- 阅读器 ----------------
  async function openReader(id) {
    let f = state.files.find((x) => x.id === id);
    if (!f) f = await storage.getFile(id);
    if (!f) return;
    state.currentFile = f;
    $("reader-name").textContent = f.name;
    const el = $("reader-content");
    try {
      if (String(f.ext).toLowerCase() === "md") {
        el.innerHTML = window.marked
          ? marked.parse(f.content, { breaks: true, gfm: true })
          : "<pre>" + escapeHtml(f.content) + "</pre>";
      } else {
        el.innerHTML = "<pre>" + escapeHtml(f.content) + "</pre>";
      }
    } catch (_) {
      el.innerHTML = "<pre>" + escapeHtml(f.content) + "</pre>";
    }
    const textOnly =
      String(f.ext).toLowerCase() === "md"
        ? f.content.replace(/[#>*`\[\]()!-]/g, "")
        : f.content;
    const charCount = textOnly.replace(/\s/g, "").length;
    $("reader-stats").textContent = charCount.toLocaleString() + " 字";
    switchView("reader");
    requestAnimationFrame(() => {
      const ratio = storage.loadReaderPos(f.id);
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, Math.max(0, ratio * Math.max(max, 0)));
    });
  }

  function saveReaderPos() {
    if (!state.currentFile) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    storage.saveReaderPos(
      state.currentFile.id,
      max > 0 ? window.scrollY / max : 0
    );
  }

  // ---------------- AI ----------------
  function openAiModal(kind, file) {
    $("ai-modal").hidden = false;
    $("ai-title").textContent =
      kind === "polish" ? "字幕润色中…" : "生成科普文章中…";
    $("ai-progress").value = 0;
    $("ai-percent").textContent = "0%";
    $("ai-log").textContent = "";
    $("ai-close").hidden = true;
    $("ai-cancel").hidden = false;
    appendAiLog("源文件：" + file.name);
  }

  function appendAiLog(msg) {
    const el = $("ai-log");
    el.textContent += msg + "\n";
    el.scrollTop = el.scrollHeight;
  }

  async function startAi(kind, file) {
    if (state.aiBusy) return;
    const apiKey = $("ai-key").value.trim();
    if (!apiKey && !state.serverHasAiKey) {
      alert("请先在「设置」页填写 DeepSeek API Key，或由服务端配置。");
      switchView("settings");
      return;
    }
    if (!file) return;
    state.aiBusy = true;
    state.aiAbort = new AbortController();
    state.aiRequestId =
      "ai_" +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 8);
    openAiModal(kind, file);
    try {
      const settings = aiSettings();
      const fn = kind === "polish" ? ai.runPolish : ai.runArticle;
      const out = await fn(
        file,
        settings,
        appendAiLog,
        (p) => {
          $("ai-progress").value = p;
          $("ai-percent").textContent = Math.round(p) + "%";
        },
        { signal: state.aiAbort.signal, requestId: state.aiRequestId }
      );
      await storage.saveFile({
        name: out.name,
        ext: "md",
        content: out.content,
        bvid: file.bvid || "",
        lang: "",
        meta: { from: file.name },
      });
      appendAiLog("✔ 已生成：" + out.name);
      $("ai-title").textContent = "AI 处理完成";
      $("ai-close").hidden = false;
      $("ai-cancel").hidden = true;
      await refreshDocs();
    } catch (e) {
      const cancelled = ai.isCancelled(e);
      appendAiLog(cancelled ? "已取消。" : "✘ 失败：" + e.message);
      $("ai-title").textContent = cancelled ? "已取消" : "AI 处理失败";
      $("ai-close").hidden = false;
      $("ai-cancel").hidden = true;
    } finally {
      state.aiBusy = false;
      state.aiAbort = null;
      state.aiRequestId = "";
    }
  }

  async function cancelAi() {
    if (!state.aiBusy) return;
    if (state.aiAbort) state.aiAbort.abort();
    if (state.aiRequestId) {
      try {
        await api.cancelAi(state.aiRequestId);
      } catch (_) {}
    }
    appendAiLog("正在取消…");
  }

  // ---------------- 事件绑定 ----------------
  function bindEvents() {
    document.querySelectorAll(".tab").forEach((b) =>
      b.addEventListener("click", () => switchView(b.dataset.view))
    );

    $("login-btn").addEventListener("click", () => {
      $("qr-modal").hidden = false;
      startQr();
    });
    $("qr-close").addEventListener("click", () => {
      stopQrPolling();
      $("qr-modal").hidden = true;
    });
    $("qr-refresh").addEventListener("click", startQr);
    $("logout-btn").addEventListener("click", async () => {
      if (confirm("确定退出 B 站登录吗？")) {
        await clearCookies();
      }
    });

    $("start-btn").addEventListener("click", startDownload);
    $("cancel-btn").addEventListener("click", () => {
      if (state.dlRunning) {
        state.dlCancel = true;
        $("dl-status").textContent = "正在取消…";
      }
    });

    $("import-btn").addEventListener("click", () => $("import-input").click());
    $("import-input").addEventListener("change", async (e) => {
      await importFiles(Array.from(e.target.files || []));
      e.target.value = "";
    });
    $("doc-search").addEventListener(
      "input",
      debounce(() => refreshDocs(), 250)
    );

    $("reader-back").addEventListener("click", () => {
      saveReaderPos();
      switchView("docs");
    });
    $("reader-export").addEventListener("click", () => {
      if (state.currentFile) exportFile(state.currentFile);
    });
    $("reader-theme").addEventListener("click", () => {
      const next = document.body.classList.contains("dark") ? "light" : "dark";
      applyTheme(next);
      storage.saveTheme(next);
    });
    $("reader-font-plus").addEventListener("click", () => {
      const next = Math.min(28, Number(storage.loadFontSize()) + 2);
      applyFont(next);
      storage.saveFontSize(next);
    });
    $("reader-font-minus").addEventListener("click", () => {
      const next = Math.max(12, Number(storage.loadFontSize()) - 2);
      applyFont(next);
      storage.saveFontSize(next);
    });
    window.addEventListener(
      "scroll",
      debounce(saveReaderPos, 300),
      { passive: true }
    );

    $("save-ai-btn").addEventListener("click", () => {
      saveAiSettings();
      alert("AI 设置已保存。");
    });
    $("save-cookie-btn").addEventListener("click", saveCookiesManually);
    $("clear-cookie-btn").addEventListener("click", clearCookies);

    $("ai-close").addEventListener("click", () => {
      $("ai-modal").hidden = true;
    });
    $("ai-cancel").addEventListener("click", cancelAi);
  }

  window.addEventListener("DOMContentLoaded", init);
})();
