// biliSub Web AI 弹窗：字幕润色 / 生成科普文章 的进度弹窗与调用
(function () {
  const ui = window.ui;

  function openAiModal(kind, file) {
    ui.$("ai-modal").hidden = false;
    ui.$("ai-title").textContent =
      kind === "polish" ? "字幕润色中…" : "生成科普文章中…";
    ui.$("ai-progress").value = 0;
    ui.$("ai-percent").textContent = "0%";
    ui.$("ai-log").textContent = "";
    ui.$("ai-close").hidden = true;
    ui.$("ai-cancel").hidden = false;
    appendAiLog("源文件：" + file.name);
  }

  function appendAiLog(msg) {
    const el = ui.$("ai-log");
    el.textContent += msg + "\n";
    el.scrollTop = el.scrollHeight;
  }

  async function startAi(kind, file) {
    if (ui.state.aiBusy) return;
    const apiKey = ui.$("ai-key").value.trim();
    if (!apiKey && !ui.state.serverHasAiKey) {
      alert("请先在「设置」页填写 DeepSeek API Key，或由服务端配置。");
      ui.switchView("settings");
      return;
    }
    if (!file) return;
    ui.state.aiBusy = true;
    ui.state.aiAbort = new AbortController();
    ui.state.aiRequestId =
      "ai_" +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 8);
    openAiModal(kind, file);
    try {
      const settings = ui.aiSettings();
      const fn = kind === "polish" ? ai.runPolish : ai.runArticle;
      const out = await fn(
        file,
        settings,
        appendAiLog,
        (p) => {
          ui.$("ai-progress").value = p;
          ui.$("ai-percent").textContent = Math.round(p) + "%";
        },
        { signal: ui.state.aiAbort.signal, requestId: ui.state.aiRequestId }
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
      ui.$("ai-title").textContent = "AI 处理完成";
      ui.$("ai-close").hidden = false;
      ui.$("ai-cancel").hidden = true;
      await ui.refreshDocs();
    } catch (e) {
      const cancelled = ai.isCancelled(e);
      appendAiLog(cancelled ? "已取消。" : "✘ 失败：" + e.message);
      ui.$("ai-title").textContent = cancelled ? "已取消" : "AI 处理失败";
      ui.$("ai-close").hidden = false;
      ui.$("ai-cancel").hidden = true;
    } finally {
      ui.state.aiBusy = false;
      ui.state.aiAbort = null;
      ui.state.aiRequestId = "";
    }
  }

  async function cancelAi() {
    if (!ui.state.aiBusy) return;
    if (ui.state.aiAbort) ui.state.aiAbort.abort();
    if (ui.state.aiRequestId) {
      try {
        await api.cancelAi(ui.state.aiRequestId);
      } catch (_) {}
    }
    appendAiLog("正在取消…");
  }

  Object.assign(ui, {
    openAiModal,
    appendAiLog,
    startAi,
    cancelAi,
  });
})();
