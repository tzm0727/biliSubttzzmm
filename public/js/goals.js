// biliSub 目标管理：目标卡片 + 倒计时 + 每日事项打卡
(function () {
  const ui = window.ui;

  let editingGoalId = "";

  function defaultEndDate() {
    const d = new Date(Date.now() + 30 * 86400000);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // 渲染「今天」页的目标横向卡片
  async function renderGoals(containerEl) {
    const goals = await storage.listGoals();
    const strip = containerEl || ui.$("goal-strip");
    if (!strip) return;
    if (!goals.length) {
      strip.innerHTML = '<div class="empty-hint">还没有目标，点「＋ 新目标」开始</div>';
      return;
    }
    strip.innerHTML = "";
    const today = storage.todayStr();
    for (const g of goals) {
      const days = storage.daysUntil(g.endDate);
      const items = g.dailyItems || [];
      const checks = (g.checks && g.checks[today]) || [];
      const doneCount = items.filter((_, i) => checks[i]).length;
      const card = document.createElement("div");
      card.className = "goal-card";
      let numHtml = "";
      if (g.unit && (g.current !== "" && g.current !== null && g.current !== undefined || g.target !== "")) {
        const cur = g.current === "" || g.current === null || g.current === undefined ? "—" : g.current;
        numHtml = `<div class="goal-card-num">${ui.escapeHtml(String(cur))} → ${ui.escapeHtml(String(g.target))} ${ui.escapeHtml(g.unit)}</div>`;
      }
      card.innerHTML =
        `<div class="goal-card-title">${ui.escapeHtml(g.title || "未命名目标")}</div>` +
        `<div class="goal-card-days ${days < 0 ? "over" : ""}">${days < 0 ? "已到期" : "剩 " + days + " 天"}</div>` +
        numHtml +
        (items.length ? `<div class="goal-card-check">今日打卡 ${doneCount}/${items.length}</div>` : "") +
        (g.milestones && g.milestones.length
          ? `<div class="goal-card-check">里程碑 ${(g.milestoneDone || []).filter(Boolean).length}/${g.milestones.length}</div>`
          : "");
      card.addEventListener("click", () => openGoalModal(g.id));
      strip.appendChild(card);
    }
  }

  // 打开目标弹层（新建或编辑）
  async function openGoalModal(goalId) {
    editingGoalId = goalId || "";
    const g = goalId ? (await storage.listGoals()).find((x) => x.id === goalId) : null;
    ui.$("goal-modal-title").textContent = g ? "编辑目标" : "新目标";
    ui.$("goal-title").value = g ? g.title || "" : "";
    ui.$("goal-current").value = g ? (g.current ?? "") : "";
    ui.$("goal-target").value = g ? (g.target ?? "") : "";
    ui.$("goal-unit").value = g ? g.unit || "" : "";
    ui.$("goal-enddate").value = g ? g.endDate || "" : defaultEndDate();
    ui.$("goal-daily").value = g ? (g.dailyItems || []).join("\n") : "";
    ui.$("goal-milestones").value = g ? (g.milestones || []).join("\n") : "";
    ui.$("goal-history-wrap").hidden = !(g && g.history && g.history.length >= 2);
    if (g && g.history && g.history.length >= 2) {
      renderGoalHistory(g.history);
    }
    ui.$("goal-delete").hidden = !g;
    // 编辑模式显示今日打卡区
    ui.$("goal-checks-wrap").hidden = !g;
    ui.$("goal-milestones-wrap").hidden = !g;
    if (g) {
      await renderGoalChecks(goalId, "goal-checks");
      await renderMilestoneChecks(goalId, "goal-milestone-checks");
    }
    ui.$("goal-modal").hidden = false;
  }

  function closeGoalModal() {
    ui.$("goal-modal").hidden = true;
    editingGoalId = "";
  }

  async function saveGoalFromModal() {
    const title = ui.$("goal-title").value.trim();
    const endDate = ui.$("goal-enddate").value;
    if (!title) {
      alert("请输入目标名称");
      return;
    }
    if (!endDate) {
      alert("请选择截止日期");
      return;
    }
    const current = ui.$("goal-current").value.trim();
    const target = ui.$("goal-target").value.trim();
    const dailyItems = ui.$("goal-daily").value
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const milestones = ui.$("goal-milestones").value
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const existing = editingGoalId ? (await storage.listGoals()).find((x) => x.id === editingGoalId) : null;
    const history = (existing && Array.isArray(existing.history) ? existing.history : []).slice();
    const curNum = current === "" || current === null || current === undefined ? null : Number(current);
    const oldNum =
      existing && existing.current !== "" && existing.current !== null && existing.current !== undefined
        ? Number(existing.current)
        : null;
    if (curNum !== null && curNum !== oldNum) {
      history.push({ date: storage.todayStr(), value: curNum });
      if (history.length > 50) history.splice(0, history.length - 50);
    }
    await storage.saveGoal({
      id: editingGoalId || undefined,
      title,
      endDate,
      current: current === "" ? null : Number(current),
      target: target === "" ? null : Number(target),
      unit: ui.$("goal-unit").value.trim(),
      dailyItems,
      milestones,
      milestoneDone: normalizeMilestoneDone(
        existing ? existing.milestoneDone || [] : [],
        milestones.length
      ),
      checks: existing ? existing.checks || {} : {},
      history,
      createdAt: existing ? existing.createdAt : Date.now(),
    });
    closeGoalModal();
    await renderGoals();
    if (ui.renderToday) ui.renderToday();
  }

  async function deleteGoal() {
    if (!editingGoalId) return;
    if (!confirm("确定删除这个目标吗？")) return;
    await storage.deleteGoal(editingGoalId);
    closeGoalModal();
    await renderGoals();
    if (ui.renderToday) ui.renderToday();
  }

  // 打卡：切换某个目标某项每日事项今天的完成状态
  async function toggleGoalCheck(goalId, itemIndex) {
    const goals = await storage.listGoals();
    const g = goals.find((x) => x.id === goalId);
    if (!g) return;
    const today = storage.todayStr();
    const checks = Object.assign({}, g.checks || {});
    const arr = (checks[today] || []).slice();
    arr[itemIndex] = !arr[itemIndex];
    checks[today] = arr;
    g.checks = checks;
    await storage.saveGoal(g);
    if (ui.renderToday) ui.renderToday();
  }

  function normalizeMilestoneDone(old, len) {
    const arr = Array.isArray(old) ? old.slice() : [];
    while (arr.length < len) arr.push(false);
    return arr.slice(0, len);
  }

  // 里程碑打卡（不限当天，可跨天推进）
  async function toggleMilestone(goalId, idx) {
    const goals = await storage.listGoals();
    const g = goals.find((x) => x.id === goalId);
    if (!g) return;
    const done = normalizeMilestoneDone(
      g.milestoneDone || [],
      (g.milestones || []).length
    );
    done[idx] = !done[idx];
    g.milestoneDone = done;
    await storage.saveGoal(g);
    await renderMilestoneChecks(goalId, "goal-milestone-checks");
    if (ui.renderGoals) ui.renderGoals();
    if (ui.renderToday) ui.renderToday();
  }

  function renderGoalHistory(history) {
    const el = ui.$("goal-history");
    if (!el) return;
    if (!history || history.length < 2) {
      el.innerHTML = "";
      return;
    }
    const vals = history.map((h) => Number(h.value) || 0);
    const min = Math.min.apply(null, vals);
    const max = Math.max.apply(null, vals);
    const range = max - min || 1;
    const w = 100;
    const h = 40;
    const pad = 4;
    const pts = vals
      .map((v, i) => {
        const x = pad + (i / Math.max(1, vals.length - 1)) * (w - pad * 2);
        const y = h - pad - ((v - min) / range) * (h - pad * 2);
        return x.toFixed(1) + "," + y.toFixed(1);
      })
      .join(" ");
    const last = vals[vals.length - 1];
    const first = vals[0];
    const lx = pad + ((vals.length - 1) / Math.max(1, vals.length - 1)) * (w - pad * 2);
    const ly = h - pad - ((last - min) / range) * (h - pad * 2);
    el.innerHTML =
      `<svg class="goal-history-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
      `<polyline points="${pts}" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2.6" fill="var(--primary)"/>` +
      `</svg>` +
      `<p class="hint">${first} → ${last}（记录 ${vals.length} 次）</p>`;
  }

  async function renderMilestoneChecks(goalId, containerId) {
    const el = ui.$(containerId);
    if (!el) return;
    const g = (await storage.listGoals()).find((x) => x.id === goalId);
    if (!g) {
      el.innerHTML = "";
      return;
    }
    const milestones = g.milestones || [];
    const done = normalizeMilestoneDone(
      g.milestoneDone || [],
      milestones.length
    );
    if (!milestones.length) {
      el.innerHTML = '<div class="empty-hint">无里程碑</div>';
      return;
    }
    el.innerHTML = "";
    milestones.forEach((text, i) => {
      const row = document.createElement("label");
      row.className = "check-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!done[i];
      cb.addEventListener("change", () => toggleMilestone(goalId, i));
      const span = document.createElement("span");
      span.textContent = text;
      row.append(cb, span);
      el.appendChild(row);
    });
  }

  // 渲染目标详情里的每日事项打卡列表（供 today 页扩展的目标详情区使用）
  async function renderGoalChecks(goalId, containerId) {
    const el = ui.$(containerId);
    if (!el) return;
    const g = (await storage.listGoals()).find((x) => x.id === goalId);
    if (!g) { el.innerHTML = ""; return; }
    const items = g.dailyItems || [];
    const today = storage.todayStr();
    const checks = (g.checks && g.checks[today]) || [];
    if (!items.length) { el.innerHTML = '<div class="empty-hint">无每日事项</div>'; return; }
    el.innerHTML = "";
    items.forEach((it, i) => {
      const row = document.createElement("label");
      row.className = "check-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!checks[i];
      cb.addEventListener("change", () => toggleGoalCheck(goalId, i));
      const span = document.createElement("span");
      span.textContent = it;
      row.append(cb, span);
      el.appendChild(row);
    });
  }

  function bindEvents() {
    ui.$("goal-add").addEventListener("click", () => openGoalModal(""));
    ui.$("goal-close").addEventListener("click", closeGoalModal);
    ui.$("goal-save").addEventListener("click", saveGoalFromModal);
    ui.$("goal-delete").addEventListener("click", deleteGoal);
  }

  Object.assign(ui, {
    renderGoals,
    openGoalModal,
    closeGoalModal,
    renderGoalChecks,
    toggleGoalCheck,
    bindGoals: bindEvents,
  });
})();
