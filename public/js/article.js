// biliSub Web 议题成文：SSE 事件处理、进度展示、保存与阅读
(function () {
  const ui = window.ui;

  function appendArticleLog(msg) {
    const el = ui.$("article-log");
    el.textContent += msg + "\n";
    el.scrollTop = el.scrollHeight;
  }

  function setArticleProgress(value, status) {
    ui.$("article-progress").value = value;
    ui.$("article-percent").textContent = Math.round(value) + "%";
    if (status) ui.$("article-status").textContent = status;
  }

  async function handleArticleEvent(ev) {
    if (!ev || !ev.type) return;
    if (ev.type === "stage") {
      appendArticleLog("▸ " + (ev.message || "处理中…"));
      ui.$("article-status").textContent = ev.message || "处理中…";
    } else if (ev.type === "outline") {
      const n = (ev.sections || []).length;
      appendArticleLog(`▸ 大纲已生成（${n} 章）：${ev.title}`);
      ui.$("article-status").textContent = `大纲已生成，共 ${n} 章`;
    } else if (ev.type === "progress") {
      const done = Number(ev.done) || 0;
      const total = Number(ev.total) || 1;
      let pct = 0;
      if (ev.stage === "search") pct = 8 + Math.round((done / total) * 32);
      else if (ev.stage === "write") pct = 40 + Math.round((done / total) * 32);
      else if (ev.stage === "lead") pct = 72 + Math.round((done / total) * 6);
      else if (ev.stage === "review") pct = 78 + Math.round((done / total) * 8);
      else if (ev.stage === "revise") pct = 86 + Math.round((done / total) * 10);
      setArticleProgress(pct, ev.message || "");
    } else if (ev.type === "done") {
      try {
        const settings = ui.aiSettings();
        let short = "";
        try {
          short = await ai.shortFileName(ev.title, settings);
        } catch (_) {}
        if (!short) short = ai.fallbackShortName(ev.title);
        const name = `${short}-文章.md`;
        const saved = await storage.saveFile({
          name,
          ext: "md",
          content: ev.content || "",
          bvid: "",
          lang: "",
          meta: {
            from: "议题成文",
            topic: ui.$("article-topic").value.trim(),
            sources: (ev.sources || []).length,
          },
        });
        ui.state.articleSavedId = saved.id;
        ui.$("article-result-name").textContent =
          name +
          `（${(ev.charCount || 0).toLocaleString()} 字，${
            (ev.sources || []).length
          } 个参考来源）`;
        try {
          ui.$("article-preview").innerHTML = window.marked
            ? marked.parse(ev.content, { breaks: true, gfm: true })
            : "<pre>" + ui.escapeHtml(ev.content) + "</pre>";
        } catch (_) {
          ui.$("article-preview").innerHTML =
            "<pre>" + ui.escapeHtml(ev.content) + "</pre>";
        }
        ui.$("article-result-card").hidden = false;
        ui.$("article-progress").value = 100;
        ui.$("article-percent").textContent = "100%";
        ui.$("article-status").textContent = "生成完成";
        appendArticleLog(
          `✔ 已保存：${name}（${(ev.charCount || 0).toLocaleString()} 字）`
        );
        await ui.refreshDocs();
        ui.openReader(saved.id);
      } catch (e) {
        appendArticleLog("✘ 保存失败：" + e.message);
        ui.$("article-status").textContent = "生成完成，但保存失败";
      }
    } else if (ev.type === "cancelled") {
      ui.state.articleFinished = true;
      appendArticleLog("已取消。");
      ui.$("article-status").textContent = "已取消";
    } else if (ev.type === "error") {
      ui.state.articleFinished = true;
      appendArticleLog("✘ 失败：" + (ev.message || "未知错误"));
      ui.$("article-status").textContent = "生成失败";
    }
    if (ev.type === "done") ui.state.articleFinished = true;
  }

  async function startArticle() {
    if (ui.state.articleBusy) return;
    const apiKey = ui.$("ai-key").value.trim();
    if (!apiKey && !ui.state.serverHasAiKey) {
      alert("请先在「设置」页填写 DeepSeek API Key，或由服务端配置。");
      ui.switchView("settings");
      return;
    }
    const topic = ui.$("article-topic").value.trim();
    if (!topic) {
      alert("请输入议题。");
      return;
    }
    const extra = ui.$("article-extra").value.trim();
    const targetChars = Number(ui.$("article-length").value) || 6000;
    const style = ui.$("article-style").value;
    ui.state.articleBusy = true;
    ui.state.articleAbort = new AbortController();
    ui.state.articleRequestId =
      "art_" +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 8);
    ui.state.articleSavedId = null;
    ui.state.articleFinished = false;
    ui.$("article-start").disabled = true;
    ui.$("article-cancel").disabled = false;
    ui.$("article-progress-card").hidden = false;
    ui.$("article-result-card").hidden = true;
    ui.$("article-progress").value = 0;
    ui.$("article-percent").textContent = "0%";
    ui.$("article-log").textContent = "";
    ui.$("article-status").textContent = "准备中…";
    appendArticleLog("议题：" + topic);
    if (extra) appendArticleLog("补充要求：" + extra);
    appendArticleLog(`目标篇幅：约 ${targetChars} 字 · 风格：${style}`);
    const settings = ui.aiSettings();
    try {
      await api.articleGenerate(
        {
          apiKey: settings.apiKey,
          topic,
          extra,
          targetChars,
          style,
          requestId: ui.state.articleRequestId,
        },
        handleArticleEvent,
        ui.state.articleAbort.signal
      );
      if (!ui.state.articleFinished) {
        appendArticleLog("✘ 连接中断，未收到生成结果，请重试。");
        ui.$("article-status").textContent = "连接中断";
      }
    } catch (e) {
      if (ai.isCancelled(e)) {
        appendArticleLog("已取消。");
        ui.$("article-status").textContent = "已取消";
      } else {
        appendArticleLog("✘ 失败：" + e.message);
        ui.$("article-status").textContent = "生成失败";
      }
    } finally {
      ui.state.articleBusy = false;
      ui.state.articleAbort = null;
      ui.state.articleRequestId = "";
      ui.$("article-start").disabled = false;
      ui.$("article-cancel").disabled = true;
    }
  }

  async function cancelArticle() {
    if (!ui.state.articleBusy) return;
    if (ui.state.articleAbort) ui.state.articleAbort.abort();
    if (ui.state.articleRequestId) {
      try {
        await api.articleCancel(ui.state.articleRequestId);
      } catch (_) {}
    }
    appendArticleLog("正在取消…");
  }

  Object.assign(ui, {
    appendArticleLog,
    setArticleProgress,
    handleArticleEvent,
    startArticle,
    cancelArticle,
  });
})();
