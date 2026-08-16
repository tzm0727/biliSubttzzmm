// 自动化：规则设置、定时调度、AI 报告生成、报告收件箱
(function () {
  const ui = window.ui;
  const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
  const TEMPLATES = {
    morning: {
      name: "晨间 AI 新闻简报",
      time: "09:00",
      task: "news",
      topic: "只关注 AI 行业，选 5 条最重要的新闻，每条 3 句话",
      style: "reuters",
      styleLevel: 2,
      length: "standard",
      frequency: "daily",
      customStyle: "",
    },
    evening: {
      name: "晚间生活复盘",
      time: "22:00",
      task: "personal",
      topic: "总结今天亮点、心情与明天计划",
      style: "custom",
      customStyle: "温和、具体、不说教，像朋友聊天一样",
      styleLevel: 2,
      length: "short",
      frequency: "daily",
    },
    bedtime: {
      name: "睡前一句话",
      time: "23:00",
      task: "custom",
      topic: "用一句话鼓励明天的我",
      style: "custom",
      customStyle: "简短、温暖、有诗意",
      styleLevel: 1,
      length: "short",
      frequency: "daily",
    },
    custom: {
      name: "",
      time: "09:00",
      task: "news",
      topic: "",
      style: "reuters",
      styleLevel: 2,
      length: "standard",
      frequency: "daily",
      customStyle: "",
    },
  };
  let editingId = "";
  let weekPick = [];
  let templatePick = "morning";
  let stylePick = "reuters";
  let currentReport = null;
  let schedulerTimer = null;

  function renderTemplates() {
    const el = ui.$("auto-templates");
    if (!el) return;
    el.querySelectorAll(".template-chip").forEach((b) => {
      b.classList.toggle("active", b.dataset.template === templatePick);
    });
  }

  function renderStylePick() {
    const el = ui.$("auto-style-pick");
    if (!el) return;
    const styles = [
      ["reuters", "路透"],
      ["bloomberg", "彭博"],
      ["nyt", "纽时"],
      ["custom", "自定义"],
    ];
    el.innerHTML = "";
    for (const [key, label] of styles) {
      const b = document.createElement("button");
      b.className = "chip" + (stylePick === key ? " active" : "");
      b.textContent = label;
      b.addEventListener("click", () => {
        stylePick = key;
        renderStylePick();
        ui.$("auto-custom-style-wrap").hidden = key !== "custom";
      });
      el.appendChild(b);
    }
  }

  function applyTemplate(key) {
    templatePick = key;
    const t = TEMPLATES[key] || TEMPLATES.custom;
    renderTemplates();
    ui.$("auto-name").value = t.name;
    ui.$("auto-time").value = t.time;
    ui.$("auto-topic").value = t.topic;
    ui.$("auto-frequency").value = t.frequency || "daily";
    ui.$("auto-weekdays-wrap").hidden = t.frequency !== "weekly";
    ui.$("auto-once-wrap").hidden = t.frequency !== "once";
    ui.$("auto-task").value = t.task || "news";
    ui.$("auto-sources").value = "";
    stylePick = t.style || "reuters";
    renderStylePick();
    ui.$("auto-custom-style").value = t.customStyle || "";
    ui.$("auto-custom-style-wrap").hidden = stylePick !== "custom";
    ui.$("auto-style-level").value = String(t.styleLevel || 2);
    ui.$("auto-length").value = t.length || "standard";
    ui.$("auto-retention").value = "30";
    ui.$("auto-enabled").checked = true;
    ui.$("auto-notify").checked = true;
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function nowStr() {
    const d = new Date();
    return (
      d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) + ":" + pad(d.getMinutes())
    );
  }

  function parseHM(time) {
    const p = String(time || "09:00").split(":");
    return [Number(p[0]) || 9, Number(p[1]) || 0];
  }

  function computeNextRun(rule, from) {
    const s = rule.schedule || {};
    const start = from ? new Date(from) : new Date();
    const [h, m] = parseHM(s.time);
    if (s.type === "once" && s.date) {
      return s.date + "T" + pad(h) + ":" + pad(m);
    }
    const cursor = new Date(start);
    for (let i = 0; i < 60; i++) {
      const day = new Date(cursor);
      day.setHours(h, m, 0, 0);
      if (day > start && dayMatches(day, s)) {
        return (
          day.getFullYear() + "-" + pad(day.getMonth() + 1) + "-" + pad(day.getDate()) +
          "T" + pad(h) + ":" + pad(m)
        );
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return nowStr();
  }

  function dayMatches(day, s) {
    const type = s.type || "daily";
    if (type === "daily") return true;
    if (type === "weekdays") {
      const wd = day.getDay();
      return wd >= 1 && wd <= 5;
    }
    if (type === "once") {
      const ds =
        day.getFullYear() + "-" + pad(day.getMonth() + 1) + "-" + pad(day.getDate());
      return s.date === ds;
    }
    const wanted = Array.isArray(s.weekdays) && s.weekdays.length ? s.weekdays : [0];
    return wanted.includes(day.getDay());
  }

  function scheduleText(s) {
    if (!s) return "";
    const t = s.time || "09:00";
    if (s.type === "weekdays") return "工作日 " + t;
    if (s.type === "weekly") {
      const days = (s.weekdays && s.weekdays.length ? s.weekdays : [0])
        .map((d) => "周" + WEEK[d])
        .join("/");
      return "每周 " + days + " " + t;
    }
    if (s.type === "once") return "单次 " + (s.date || "") + " " + t;
    return "每天 " + t;
  }

  // ---------------- 规则列表 ----------------
  async function renderAutomationList() {
    const el = ui.$("automation-list");
    if (!el) return;
    const list = await storage.listAutomations();
    if (!list.length) {
      el.innerHTML = '<div class="empty-hint">还没有自动化，点「＋ 新建」创建你的第一个 AI 报告</div>';
      return;
    }
    el.innerHTML = "";
    for (const a of list) {
      const item = document.createElement("div");
      item.className = "auto-item";
      const head = document.createElement("div");
      head.className = "auto-head";
      const name = document.createElement("div");
      name.className = "auto-name";
      name.textContent = a.name;
      const sw = document.createElement("button");
      sw.className = "auto-switch" + (a.enabled ? " on" : "");
      sw.title = a.enabled ? "已启用" : "已停用";
      sw.addEventListener("click", async () => {
        a.enabled = !a.enabled;
        a.nextRun = a.enabled ? computeNextRun(a) : a.nextRun;
        await storage.saveAutomation(a);
        await syncToServer();
        await renderAutomationList();
      });
      head.append(name, sw);
      item.appendChild(head);
      const meta = document.createElement("div");
      meta.className = "auto-meta";
      const chips = [
        { text: scheduleText(a.schedule), cls: "primary" },
        { text: a.task === "news" ? "新闻" : a.task === "personal" ? "个人" : "自定义" },
        { text: "风格:" + (a.style || "reuters") },
        { text: a.enabled && a.nextRun ? "下次 " + a.nextRun.slice(5).replace("T", " ") : "已停用" },
      ];
      for (const c of chips) {
        const span = document.createElement("span");
        span.className = "auto-chip" + (c.cls ? " " + c.cls : "");
        span.textContent = c.text;
        meta.appendChild(span);
      }
      item.appendChild(meta);
      const actions = document.createElement("div");
      actions.className = "auto-actions";
      const runBtn = document.createElement("button");
      runBtn.className = "btn small";
      runBtn.textContent = "立即运行";
      runBtn.addEventListener("click", () => runAutomation(a.id));
      const editBtn = document.createElement("button");
      editBtn.className = "btn small";
      editBtn.textContent = "编辑";
      editBtn.addEventListener("click", () => openAutomationModal(a.id));
      const delBtn = document.createElement("button");
      delBtn.className = "btn small ghost";
      delBtn.textContent = "删除";
      delBtn.addEventListener("click", async () => {
        if (!confirm("删除这条自动化？已生成的报告会保留。")) return;
        await storage.deleteAutomation(a.id);
        await syncToServer();
        await renderAutomationList();
      });
      actions.append(runBtn, editBtn, delBtn);
      item.appendChild(actions);
      el.appendChild(item);
    }
  }

  // ---------------- 编辑弹层 ----------------
  function renderWeekdays() {
    const el = ui.$("auto-weekdays");
    if (!el) return;
    el.innerHTML = "";
    WEEK.forEach((label, i) => {
      const b = document.createElement("button");
      b.className = "chip" + (weekPick.includes(i) ? " active" : "");
      b.textContent = "周" + label;
      b.addEventListener("click", () => {
        const idx = weekPick.indexOf(i);
        if (idx >= 0) weekPick.splice(idx, 1);
        else weekPick.push(i);
        renderWeekdays();
      });
      el.appendChild(b);
    });
  }

  async function openAutomationModal(id) {
    editingId = id || "";
    const a = id ? (await storage.listAutomations()).find((x) => x.id === id) : null;
    if (!a) {
      templatePick = "morning";
      applyTemplate("morning");
      ui.$("automation-modal-title").textContent = "新建自动化";
      ui.$("auto-run").hidden = true;
      ui.$("auto-delete").hidden = true;
      ui.$("automation-modal").hidden = false;
      return;
    }
    templatePick = a ? "custom" : "morning";
    ui.$("automation-modal-title").textContent = a ? "编辑自动化" : "新建自动化";
    ui.$("auto-name").value = a ? a.name : "";
    const s = (a && a.schedule) || {};
    ui.$("auto-frequency").value = s.type || "daily";
    ui.$("auto-time").value = s.time || "09:00";
    ui.$("auto-once-date").value = s.date || "";
    weekPick = Array.isArray(s.weekdays) ? s.weekdays.slice() : [];
    renderWeekdays();
    ui.$("auto-weekdays-wrap").hidden = ui.$("auto-frequency").value !== "weekly";
    ui.$("auto-once-wrap").hidden = ui.$("auto-frequency").value !== "once";
    ui.$("auto-task").value = a ? a.task || "news" : "news";
    ui.$("auto-topic").value = a ? a.topic || "" : "";
    ui.$("auto-sources").value = a && a.sources && a.sources.length
      ? a.sources.map((x) => x.url).join("\n")
      : "";
    stylePick = a ? a.style || "reuters" : "reuters";
    ui.$("auto-custom-style").value = a ? a.customStyle || "" : "";
    ui.$("auto-custom-style-wrap").hidden = stylePick !== "custom";
    ui.$("auto-style-level").value = a ? String(a.styleLevel || 2) : "2";
    ui.$("auto-length").value = a ? a.length || "standard" : "standard";
    ui.$("auto-retention").value = String(a ? a.retentionDays || 30 : 30);
    ui.$("auto-enabled").checked = a ? a.enabled !== false : true;
    ui.$("auto-notify").checked = a ? (a.notify && a.notify.browser) !== false : true;
    ui.$("auto-run").hidden = !a;
    ui.$("auto-delete").hidden = !a;
    renderTemplates();
    renderStylePick();
    ui.$("automation-modal").hidden = false;
  }

  async function saveAutomationFromModal() {
    const name = ui.$("auto-name").value.trim();
    if (!name) {
      alert("请输入自动化名称");
      return;
    }
    const freq = ui.$("auto-frequency").value;
    const rule = {
      id: editingId || undefined,
      name,
      enabled: ui.$("auto-enabled").checked,
      schedule: {
        type: freq,
        time: ui.$("auto-time").value || "09:00",
        weekdays: freq === "weekly" ? weekPick.slice() : [],
        date: freq === "once" ? ui.$("auto-once-date").value : "",
      },
      task: ui.$("auto-task").value,
      topic: ui.$("auto-topic").value.trim(),
      sources: ui
        .$("auto-sources")
        .value.split(/\r?\n/)
        .map((u) => u.trim())
        .filter(Boolean)
        .map((url) => ({ label: url, url })),
      style: stylePick,
      styleLevel: Number(ui.$("auto-style-level").value) || 2,
      customStyle: ui.$("auto-custom-style").value.trim(),
      length: ui.$("auto-length").value,
      includeSources: true,
      notify: { browser: ui.$("auto-notify").checked, inApp: true },
      retentionDays: Number(ui.$("auto-retention").value) || 30,
    };
    const existing = editingId
      ? (await storage.listAutomations()).find((x) => x.id === editingId)
      : null;
    rule.createdAt = existing ? existing.createdAt : Date.now();
    rule.lastRun = existing ? existing.lastRun || "" : "";
    rule.nextRun = rule.enabled ? computeNextRun(rule) : "";
    const saved = await storage.saveAutomation(rule);
    ui.$("automation-modal").hidden = true;
    await syncToServer();
    await renderAutomationList();
    if (rule.notify.browser && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
    ui.showToast("自动化已保存：" + saved.name);
  }

  async function deleteAutomationFromModal() {
    if (!editingId) return;
    if (!confirm("删除这条自动化？")) return;
    await storage.deleteAutomation(editingId);
    ui.$("automation-modal").hidden = true;
    await syncToServer();
    await renderAutomationList();
  }

  // ---------------- 运行 ----------------
  async function buildDataText() {
    const to = storage.todayStr();
    const from = storage.offsetDateStr(-6);
    const [moods, stats, focus, reviews, life] = await Promise.all([
      storage.listMoodLogs({ from, to }),
      storage.habitStats(),
      storage.focusTotal({ from, to }),
      storage.listReviews({ from, to }),
      storage.lifeSummary(to),
    ]);
    const moodText = moods.length
      ? moods.map((m) => `${m.date} ${m.mood}${m.label ? "(" + m.label + ")" : ""} 强度${m.intensity}${m.triggers && m.triggers.length ? " 触发:" + m.triggers.join("/") : ""}`).join("\n")
      : "（无）";
    const habitText = stats.map((s) => `${s.habit.name}：连续${s.streak}天，共${s.total}次`).join("\n") || "（无）";
    const reviewText = reviews.map((r) => `${r.date} [${r.type}] 好事:${r.good || "无"} 收获:${r.learn || "无"}`).join("\n") || "（无）";
    return (
      `最近 7 天（${from} 至 ${to}）：\n【心情】\n${moodText}\n【习惯】\n${habitText}\n` +
      `【专注】${focus} 分钟\n【生活】睡眠 ${life.sleep === null ? "—" : life.sleep + "h"} 运动 ${life.exercise}分 喝水 ${life.water}杯 冥想 ${life.meditation}分 阅读 ${life.reading}分\n【复盘】\n${reviewText}`
    );
  }

  async function runAutomation(id) {
    const rule = (await storage.listAutomations()).find((x) => x.id === id);
    if (!rule) return;
    ui.showToast("正在生成「" + rule.name + "」…");
    try {
      const settings = ui.aiSettings();
      const dataText = rule.task === "news" ? "" : await buildDataText();
      const data = await api.post("/api/automation/run", {
        automation: rule,
        apiKey: settings.apiKey,
        model: settings.model || "deepseek-chat",
        dataText,
      });
      if (data.error) throw new Error(data.error);
      const report = data.report;
      await storage.saveReport(report);
      rule.lastRun = report.date + "T" + (new Date().toTimeString().slice(0, 5));
      rule.nextRun = computeNextRun(rule);
      await storage.saveAutomation(rule);
      await syncToServer();
      await renderAutomationList();
      await renderReportList();
      if (rule.notify && rule.notify.browser && "Notification" in window && Notification.permission === "granted") {
        try {
          new Notification("报告已生成：" + rule.name, { body: report.title });
        } catch (_) {}
      }
      if (report.status === "error") {
        ui.showToast("生成失败：" + (report.content || "").slice(0, 60));
      } else {
        ui.showToast("报告已生成");
        openReportModal(report.id);
      }
    } catch (e) {
      ui.showToast("生成失败：" + String((e && e.message) || e).slice(0, 60));
    }
  }

  // ---------------- 报告列表与阅读 ----------------
  async function renderReportList() {
    const el = ui.$("report-list");
    if (!el) return;
    const list = await storage.listReports();
    if (!list.length) {
      el.innerHTML = '<div class="empty-hint">还没有报告。点规则的「立即运行」试一次，或等定时自动生成。</div>';
      return;
    }
    el.innerHTML = "";
    for (const r of list.slice(0, 20)) {
      const item = document.createElement("div");
      item.className = "report-item";
      const body = document.createElement("div");
      body.className = "report-body";
      const title = document.createElement("div");
      title.className = "report-title";
      title.textContent = r.title;
      const date = document.createElement("div");
      date.className = "report-date";
      date.textContent = r.date + (r.style ? " · " + r.style : "") + (r.status === "error" ? " · 失败" : "");
      body.append(title, date);
      body.addEventListener("click", () => openReportModal(r.id));
      const st = document.createElement("span");
      st.className = "report-status " + (r.status || "ok");
      st.textContent = r.status === "error" ? "失败" : "完成";
      const del = document.createElement("button");
      del.className = "diary-item-del";
      del.textContent = "删除";
      del.addEventListener("click", async () => {
        await storage.deleteReport(r.id);
        await renderReportList();
      });
      item.append(body, st, del);
      el.appendChild(item);
    }
  }

  async function openReportModal(id) {
    const r = await storage.getReport(id);
    if (!r) return;
    currentReport = r;
    ui.$("report-modal-title").textContent = r.title || "报告";
    ui.$("report-modal-meta").textContent = r.date + " · 风格 " + (r.style || "—");
    const contentEl = ui.$("report-modal-content");
    if (typeof marked !== "undefined" && marked.parse) {
      contentEl.innerHTML = marked.parse(r.content || "");
    } else {
      contentEl.textContent = r.content || "";
    }
    ui.$("report-modal").hidden = false;
  }

  function downloadBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 3000);
  }

  function exportMarkdown(r) {
    const md =
      `# ${r.title || "AI 报告"}\n\n> 生成时间：${r.date} · 风格：${r.style || "—"}\n\n` +
      (r.content || "") +
      (r.sources && r.sources.length
        ? "\n\n## 来源\n" + r.sources.map((s) => `- [${s.title}](${s.link})`).join("\n")
        : "");
    downloadBlob(new Blob([md], { type: "text/markdown;charset=utf-8" }), (r.title || "report").replace(/[\\/:*?"<>|]/g, "_") + ".md");
  }

  async function exportEpub(r) {
    try {
      const blob = await api.exportEpub(r.title || "AI 报告", r.content || "");
      downloadBlob(blob, (r.title || "report").replace(/[\\/:*?"<>|]/g, "_") + ".epub");
    } catch (e) {
      alert("EPUB 导出失败：" + ((e && e.message) || e));
    }
  }

  // ---------------- 服务端同步 / 定时调度 ----------------
  async function syncToServer() {
    try {
      const list = await storage.listAutomations();
      await api.post("/api/automation/sync", { automations: list });
    } catch (_) {}
  }

  async function importServerReports() {
    try {
      const data = await api.get("/api/automation/reports");
      const serverList = data.reports || [];
      const local = await storage.listReports();
      const have = new Set(local.map((r) => r.id));
      let added = 0;
      for (const r of serverList) {
        if (!have.has(r.id)) {
          await storage.saveReport(r);
          added++;
        }
      }
      if (added > 0) await renderReportList();
    } catch (_) {}
  }

  async function schedulerTick() {
    const now = nowStr();
    const list = await storage.listAutomations();
    for (const a of list) {
      if (a.enabled && a.nextRun && a.nextRun <= now) {
        a.nextRun = computeNextRun(a);
        await storage.saveAutomation(a);
        await runAutomation(a.id);
      }
    }
  }

  function startScheduler() {
    if (schedulerTimer) return;
    schedulerTimer = setInterval(schedulerTick, 30000);
  }

  function bindEvents() {
    ui.$("automation-add").addEventListener("click", () => openAutomationModal(""));
    ui.$("auto-templates").querySelectorAll(".template-chip").forEach((b) =>
      b.addEventListener("click", () => applyTemplate(b.dataset.template))
    );
    ui.$("auto-close").addEventListener("click", () => {
      ui.$("automation-modal").hidden = true;
    });
    ui.$("auto-save").addEventListener("click", saveAutomationFromModal);
    ui.$("auto-run").addEventListener("click", async () => {
      if (editingId) {
        const a = (await storage.listAutomations()).find((x) => x.id === editingId);
        ui.$("automation-modal").hidden = true;
        if (a) await runAutomation(a.id);
      }
    });
    ui.$("auto-delete").addEventListener("click", deleteAutomationFromModal);
    ui.$("auto-frequency").addEventListener("change", () => {
      const f = ui.$("auto-frequency").value;
      ui.$("auto-weekdays-wrap").hidden = f !== "weekly";
      ui.$("auto-once-wrap").hidden = f !== "once";
    });
    ui.$("report-refresh").addEventListener("click", async () => {
      await renderReportList();
      ui.showToast("报告已刷新");
    });
    ui.$("report-close").addEventListener("click", () => {
      ui.$("report-modal").hidden = true;
    });
    ui.$("report-export-md").addEventListener("click", () => {
      if (currentReport) exportMarkdown(currentReport);
    });
    ui.$("report-export-epub").addEventListener("click", () => {
      if (currentReport) exportEpub(currentReport);
    });
    ui.$("report-delete").addEventListener("click", async () => {
      if (!currentReport) return;
      await storage.deleteReport(currentReport.id);
      ui.$("report-modal").hidden = true;
      await renderReportList();
    });
  }

  Object.assign(ui, {
    renderAutomationList,
    renderReportList,
    bindAutomation: bindEvents,
    startAutomationScheduler: startScheduler,
    syncAutomationsToServer: syncToServer,
    importServerReports,
    runAutomation,
  });
})();
