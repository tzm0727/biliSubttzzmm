// 成长页：总览 / 心情日历 / 趋势 / 习惯热力图 / 专注 / 记账 / 技能 / 知识卡片 / AI 周报
(function () {
  const ui = window.ui;

  const MOOD_SCORE = {
    "😢": 1,
    "😔": 1.5,
    "😤": 2,
    "😰": 2,
    "🥱": 2.5,
    "😐": 3,
    "🙂": 4,
    "😊": 4.5,
    "😄": 5,
    "🤩": 5,
  };
  const LEVEL_TITLES = [
    [1, "成长新手"],
    [5, "持续学习者"],
    [10, "自律达人"],
    [20, "进阶玩家"],
    [50, "人生赢家"],
  ];
  const EXPENSE_CATS = ["餐饮", "交通", "购物", "居住", "娱乐", "健康", "学习", "其他"];
  const INCOME_CATS = ["工资", "兼职", "理财", "红包", "其他"];

  const gstate = {
    calYear: new Date().getFullYear(),
    calMonth: new Date().getMonth(),
    trendDays: 30,
    focusTimer: null,
    focusRemaining: 25 * 60,
    focusRunning: false,
    focusStart: "",
  };

  function levelInfo(xp) {
    const level = Math.floor(xp / 100) + 1;
    let title = LEVEL_TITLES[0][1];
    for (const [min, t] of LEVEL_TITLES) {
      if (level >= min) title = t;
    }
    return { level, title, xp };
  }

  async function collectRecordDays() {
    const days = new Set();
    const [moods, checks, focus, reviews, life, diary, tasks] = await Promise.all([
      storage.listMoodLogs(),
      storage.listHabitChecks(),
      storage.listFocusSessions(),
      storage.listReviews(),
      storage.listLifeLogs(),
      storage.listDiary(),
      storage.listTasks(),
    ]);
    for (const m of moods) if (m.date) days.add(m.date);
    for (const c of checks) if (c.done && c.date) days.add(c.date);
    for (const f of focus) if (f.date) days.add(f.date);
    for (const r of reviews) if (r.date) days.add(r.date);
    for (const l of life) if (l.date) days.add(l.date);
    for (const d of diary) if (d.date) days.add(d.date);
    for (const t of tasks) if (t.done && t.date) days.add(t.date);
    return days;
  }

  function consecutiveDays(days) {
    let streak = 0;
    const d = new Date();
    if (!days.has(storage.todayStr())) d.setDate(d.getDate() - 1);
    while (days.has(storage.dateStr(d))) {
      streak++;
      d.setDate(d.getDate() - 1);
    }
    return streak;
  }

  async function renderOverview() {
    const el = ui.$("growth-overview");
    if (!el) return;
    const today = storage.todayStr();
    const month = today.slice(0, 7);
    const [moods, stats, diary, reviews, focusMonth, tasks, goals] =
      await Promise.all([
        storage.listMoodLogs(),
        storage.habitStats(),
        storage.listDiary(),
        storage.listReviews(),
        storage.listFocusSessions({ from: month + "-01", to: today }),
        storage.listTasks(),
        storage.listGoals(),
      ]);
    const days = await collectRecordDays();
    const streak = consecutiveDays(days);
    let xp = 0;
    xp += moods.length * 5;
    xp += diary.length * 10;
    xp += stats.reduce((s, x) => s + x.total, 0) * 5;
    xp += focusMonth.reduce((s, f) => s + (Number(f.minutes) || 0), 0) * 0.2;
    xp += reviews.length * 15;
    xp += tasks.filter((t) => t.done).length * 2;
    xp += goals.length * 10;
    const li = levelInfo(Math.round(xp));
    ui.$("growth-level").textContent = "Lv." + li.level + " · " + li.title;
    ui.$("growth-level-progress").textContent =
      "记录 " + days.size + " 天 · " + Math.round(xp) + " XP · 连续 " + streak + " 天";

    const monthMoods = moods.filter((m) => m.date && m.date.startsWith(month));
    const avg = monthMoods.length
      ? monthMoods.reduce((s, m) => s + (MOOD_SCORE[m.mood] || 3), 0) /
        monthMoods.length
      : null;
    ui.$("ov-mood").textContent = avg === null ? "—" : avg.toFixed(1);

    const daysElapsed = new Date().getDate();
    const expected = stats.reduce(
      (s, x) =>
        s + (x.habit.frequency === "daily" ? daysElapsed : daysElapsed * 0.7),
      0
    );
    const done = stats.reduce((s, x) => s + x.total, 0);
    ui.$("ov-habit").textContent =
      stats.length && expected > 0 ? Math.round((done / expected) * 100) + "%" : "—";
    ui.$("ov-focus").textContent = String(
      focusMonth.reduce((s, f) => s + (Number(f.minutes) || 0), 0)
    );
    ui.$("ov-streak").textContent = streak + "天";
  }

  // ---------------- 心情日历 ----------------
  async function renderCalendar() {
    const grid = ui.$("cal-grid");
    if (!grid) return;
    const y = gstate.calYear;
    const m = gstate.calMonth;
    ui.$("cal-title").textContent = y + "年" + (m + 1) + "月";
    const from = y + "-" + String(m + 1).padStart(2, "0") + "-01";
    const next = new Date(y, m + 1, 1);
    const to = storage.dateStr(next);
    const [moods, checks, diary] = await Promise.all([
      storage.listMoodLogs({ from, to: to === from ? "" : to }),
      storage.listHabitChecks({ from, to: to === from ? "" : to }),
      storage.listDiary(),
    ]);
    const diaryDates = new Set(diary.map((d) => d.date));
    const moodByDate = {};
    for (const mlog of moods) {
      if (!moodByDate[mlog.date]) moodByDate[mlog.date] = [];
      moodByDate[mlog.date].push(mlog);
    }
    const checkCount = {};
    for (const c of checks) {
      if (c.done) checkCount[c.date] = (checkCount[c.date] || 0) + 1;
    }
    const firstDay = new Date(y, m, 1);
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    grid.innerHTML = "";
    for (let i = 0; i < firstDay.getDay(); i++) {
      const blank = document.createElement("div");
      blank.className = "cal-cell blank";
      grid.appendChild(blank);
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = y + "-" + String(m + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0");
      const cell = document.createElement("div");
      cell.className = "cal-cell";
      const list = moodByDate[dateStr] || [];
      const score = list.length
        ? list.reduce((s, x) => s + (MOOD_SCORE[x.mood] || 3), 0) / list.length
        : null;
      if (score !== null) {
        const color = score >= 4 ? "good" : score >= 3 ? "ok" : score >= 2 ? "low" : "bad";
        cell.classList.add("mood-" + color);
      }
      if (checkCount[dateStr]) cell.classList.add("has-check");
      if (diaryDates.has(dateStr)) cell.classList.add("has-diary");
      const num = document.createElement("span");
      num.className = "cal-num";
      num.textContent = day;
      cell.appendChild(num);
      if (list.length || checkCount[dateStr]) {
        const dots = document.createElement("span");
        dots.className = "cal-dots";
        dots.textContent = (list.length ? "♥" : "") + (checkCount[dateStr] ? " ✓" : "");
        cell.appendChild(dots);
      }
      const recordCount =
        (list.length ? 1 : 0) + (checkCount[dateStr] || 0) + (diaryDates.has(dateStr) ? 1 : 0);
      cell.title = dateStr + " · " + recordCount + " 条记录";
      grid.appendChild(cell);
    }
  }

  // ---------------- 心情趋势 ----------------
  async function renderTrend() {
    const canvas = ui.$("mood-trend");
    if (!canvas) return;
    const n = gstate.trendDays;
    const from = storage.offsetDateStr(-(n - 1));
    const moods = await storage.listMoodLogs({ from, to: storage.todayStr() });
    const hint = ui.$("mood-trend-hint");
    const byDate = {};
    for (const m of moods) {
      if (!byDate[m.date]) byDate[m.date] = [];
      byDate[m.date].push(m);
    }
    const points = [];
    for (let i = 0; i < n; i++) {
      const ds = storage.offsetDateStr(-(n - 1 - i));
      const list = byDate[ds] || [];
      const avg = list.length
        ? list.reduce((s, x) => s + (MOOD_SCORE[x.mood] || 3), 0) / list.length
        : null;
      points.push({ date: ds, v: avg });
    }
    if (hint) {
      hint.textContent = points.filter((p) => p.v !== null).length < 2
        ? "记录心情后这里会出现趋势图"
        : "最近 " + n + " 天心情均值（1 低落 → 5 开心）";
    }
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 320;
    const h = 160;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const pad = { l: 28, r: 12, t: 12, b: 22 };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;
    const yAt = (v) => pad.t + plotH - ((v - 1) / 4) * plotH;
    ctx.strokeStyle = "rgba(120,120,128,0.25)";
    ctx.fillStyle = "rgba(120,120,128,0.55)";
    ctx.font = "10px -apple-system, sans-serif";
    ctx.lineWidth = 1;
    for (const v of [1, 3, 5]) {
      const y = yAt(v);
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(w - pad.r, y);
      ctx.stroke();
      ctx.fillText(String(v), 4, y + 3);
    }
    const vals = points.map((p, i) => ({ x: pad.l + (i / Math.max(1, n - 1)) * plotW, y: yAt(p.v === null ? 0 : p.v), v: p.v }));
    const real = vals.filter((p) => p.v !== null);
    if (real.length < 2) return;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = "#0071e3";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    let started = false;
    for (const p of vals) {
      if (p.v === null) {
        started = false;
        continue;
      }
      if (!started) {
        ctx.moveTo(p.x, p.y);
        started = true;
      } else {
        ctx.lineTo(p.x, p.y);
      }
    }
    ctx.stroke();
    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + plotH);
    grad.addColorStop(0, "rgba(0,113,227,0.22)");
    grad.addColorStop(1, "rgba(0,113,227,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    let started2 = false;
    for (const p of vals) {
      if (p.v === null) {
        started2 = false;
        continue;
      }
      if (!started2) {
        ctx.moveTo(p.x, pad.t + plotH);
        ctx.lineTo(p.x, p.y);
        started2 = true;
      } else {
        ctx.lineTo(p.x, p.y);
      }
    }
    ctx.lineTo(vals[vals.length - 1].x, pad.t + plotH);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#0071e3";
    for (const p of real) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---------------- 习惯热力图 ----------------
  async function renderHeatmap() {
    const el = ui.$("habit-heatmap");
    if (!el) return;
    const days = 84;
    const from = storage.offsetDateStr(-(days - 1));
    const checks = await storage.listHabitChecks({ from, to: storage.todayStr() });
    const countByDate = {};
    for (const c of checks) {
      if (c.done) countByDate[c.date] = (countByDate[c.date] || 0) + 1;
    }
    el.innerHTML = "";
    el.style.gridTemplateRows = "repeat(7, 1fr)";
    for (let i = 0; i < days; i++) {
      const ds = storage.offsetDateStr(-(days - 1 - i));
      const n = countByDate[ds] || 0;
      const cell = document.createElement("div");
      cell.className = "heat-cell";
      if (n > 0) {
        const level = n >= 7 ? 4 : n >= 5 ? 3 : n >= 3 ? 2 : 1;
        cell.dataset.level = level;
      }
      cell.title = ds + " · " + n + " 次打卡";
      el.appendChild(cell);
    }
  }

  // ---------------- 目标进度（复用目标卡片） ----------------
  async function renderGrowthGoals() {
    const el = ui.$("growth-goals");
    if (!el) return;
    await ui.renderGoals(el);
  }

  // ---------------- 专注 ----------------
  function fmtTime(sec) {
    const m = String(Math.floor(sec / 60)).padStart(2, "0");
    const s = String(sec % 60).padStart(2, "0");
    return m + ":" + s;
  }

  function stopFocusTick() {
    if (gstate.focusTimer) {
      clearInterval(gstate.focusTimer);
      gstate.focusTimer = null;
    }
    gstate.focusRunning = false;
  }

  function updateFocusBtn() {
    const b = ui.$("focus-start");
    if (b) b.textContent = gstate.focusRunning ? "暂停" : "开始";
  }

  async function focusTick() {
    gstate.focusRemaining--;
    ui.$("focus-time").textContent = fmtTime(Math.max(0, gstate.focusRemaining));
    if (gstate.focusRemaining <= 0) {
      const end = new Date().toTimeString().slice(0, 5);
      await storage.saveFocusSession({
        date: storage.todayStr(),
        start: gstate.focusStart || end,
        end,
        minutes: 25,
      });
      stopFocusTick();
      ui.$("focus-time").textContent = fmtTime(25 * 60);
      gstate.focusRemaining = 25 * 60;
      gstate.focusStart = "";
      ui.showToast("专注完成，已记录 25 分钟");
      updateFocusBtn();
      await renderGrowth();
    }
  }

  function toggleFocus() {
    if (gstate.focusRunning) {
      stopFocusTick();
    } else {
      if (!gstate.focusStart) gstate.focusStart = new Date().toTimeString().slice(0, 5);
      gstate.focusRunning = true;
      gstate.focusTimer = setInterval(focusTick, 1000);
    }
    updateFocusBtn();
  }

  function resetFocus() {
    stopFocusTick();
    gstate.focusRemaining = 25 * 60;
    gstate.focusStart = "";
    ui.$("focus-time").textContent = fmtTime(gstate.focusRemaining);
    updateFocusBtn();
  }

  async function renderFocusSessions() {
    const el = ui.$("focus-sessions");
    if (!el) return;
    const today = storage.todayStr();
    const list = (await storage.listFocusSessions({ from: today, to: today })).sort(
      (a, b) => (a.start || "").localeCompare(b.start || "")
    );
    const total = list.reduce((s, f) => s + (Number(f.minutes) || 0), 0);
    el.innerHTML = "";
    const head = document.createElement("div");
    head.className = "focus-head";
    head.textContent = list.length
      ? "今日已完成 " + list.length + " 次 · 共 " + total + " 分钟"
      : "今天还没有专注记录，点「开始」进入番茄钟";
    el.appendChild(head);
    for (const f of list) {
      const row = document.createElement("div");
      row.className = "focus-row";
      row.innerHTML =
        `<span class="focus-time-range">${f.start || "—"} → ${f.end || "—"}</span>` +
        `<span class="focus-minutes">${f.minutes} 分钟</span>`;
      const del = document.createElement("button");
      del.className = "diary-item-del";
      del.textContent = "删除";
      del.addEventListener("click", async () => {
        await storage.deleteFocusSession(f.id);
        await renderFocusSessions();
        await renderOverview();
      });
      row.appendChild(del);
      el.appendChild(row);
    }
  }

  // ---------------- 记账 ----------------
  async function renderFinance() {
    const el = ui.$("finance-summary");
    if (!el) return;
    const sum = await storage.financeSummary();
    const list = (await storage.listFinance()).sort(
      (a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0)
    );
    el.innerHTML =
      `<div class="finance-grid">` +
      `<div class="finance-tile"><div class="k">收入</div><div class="v in">¥${sum.income.toFixed(2)}</div></div>` +
      `<div class="finance-tile"><div class="k">支出</div><div class="v out">¥${sum.expense.toFixed(2)}</div></div>` +
      `<div class="finance-tile"><div class="k">结余</div><div class="v">¥${sum.balance.toFixed(2)}</div></div>` +
      `</div>`;
    if (!list.length) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "本月还没有记账";
      el.appendChild(hint);
      return;
    }
    for (const f of list.slice(0, 8)) {
      const row = document.createElement("div");
      row.className = "finance-row";
      const sign = f.type === "income" ? "+" : "-";
      row.innerHTML =
        `<span class="finance-cat">${f.type === "income" ? "↑" : "↓"} ${f.category}</span>` +
        `<span class="finance-note">${ui.escapeHtml(f.note || f.date)}</span>` +
        `<span class="finance-amount ${f.type === "income" ? "in" : "out"}">${sign}¥${(Number(f.amount) || 0).toFixed(2)}</span>`;
      const del = document.createElement("button");
      del.className = "diary-item-del";
      del.textContent = "删除";
      del.addEventListener("click", async () => {
        if (!confirm("删除这笔记录？")) return;
        await storage.deleteFinance(f.id);
        await renderFinance();
        await renderOverview();
      });
      row.appendChild(del);
      el.appendChild(row);
    }
  }

  let financeType = "expense";

  function renderFinanceCats() {
    const el = ui.$("finance-category-pick");
    if (!el) return;
    const cats = financeType === "income" ? INCOME_CATS : EXPENSE_CATS;
    el.innerHTML = "";
    for (const c of cats) {
      const b = document.createElement("button");
      b.className = "chip";
      b.textContent = c;
      b.addEventListener("click", () => {
        el.querySelectorAll(".chip").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
      });
      el.appendChild(b);
    }
    const first = el.querySelector(".chip");
    if (first) first.classList.add("active");
  }

  function openFinanceModal() {
    financeType = "expense";
    ui.$("finance-amount").value = "";
    ui.$("finance-note").value = "";
    ui.$("finance-type-seg").querySelectorAll(".seg-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.type === "expense");
    });
    renderFinanceCats();
    ui.$("finance-modal").hidden = false;
  }

  async function saveFinance() {
    const amount = Number(ui.$("finance-amount").value);
    if (!(amount > 0)) {
      alert("请输入金额");
      return;
    }
    const catEl = ui.$("finance-category-pick");
    const active = catEl.querySelector(".chip.active");
    await storage.saveFinance({
      date: storage.todayStr(),
      type: financeType,
      category: active ? active.textContent : "其他",
      amount,
      note: ui.$("finance-note").value.trim(),
    });
    ui.$("finance-modal").hidden = true;
    await renderFinance();
    await renderOverview();
  }

  // ---------------- 技能投入 ----------------
  async function renderSkills() {
    const el = ui.$("skill-list");
    if (!el) return;
    const list = await storage.listSkills();
    if (!list.length) {
      el.innerHTML = '<div class="empty-hint">记录你投入时间学习的技能</div>';
      return;
    }
    const byName = {};
    for (const s of list) {
      if (!byName[s.name]) byName[s.name] = { name: s.name, hours: 0, count: 0, last: "" };
      const g = byName[s.name];
      g.hours += Number(s.hours) || 0;
      g.count++;
      if (!g.last) g.last = s.note || s.date;
    }
    const agg = Object.values(byName).sort((a, b) => b.hours - a.hours);
    const head = document.createElement("div");
    head.className = "skill-head";
    head.textContent = "共 " + list.length + " 次投入 · " + agg.reduce((s, x) => s + x.hours, 0).toFixed(1) + " 小时";
    el.appendChild(head);
    for (const g of agg.slice(0, 8)) {
      const row = document.createElement("div");
      row.className = "skill-row";
      row.innerHTML =
        `<span class="skill-name">${ui.escapeHtml(g.name)}</span>` +
        `<span class="skill-meta">${g.count} 次 · ${g.last ? ui.escapeHtml(g.last) : ""}</span>` +
        `<span class="skill-hours">${g.hours.toFixed(1)}h</span>`;
      el.appendChild(row);
    }
  }

  async function saveSkill() {
    const name = ui.$("skill-name").value.trim();
    const hours = Number(ui.$("skill-hours").value);
    if (!name) {
      alert("请输入技能名称");
      return;
    }
    if (!(hours > 0)) {
      alert("请输入投入时长");
      return;
    }
    await storage.saveSkill({
      date: storage.todayStr(),
      name,
      category: ui.$("skill-category").value,
      hours,
      note: ui.$("skill-note").value.trim(),
    });
    ui.$("skill-modal").hidden = true;
    await renderSkills();
    await renderOverview();
  }

  // ---------------- 知识卡片 ----------------
  async function renderCards() {
    const el = ui.$("card-list");
    if (!el) return;
    const list = await storage.listCards();
    if (!list.length) {
      el.innerHTML = '<div class="empty-hint">摘抄一句让你记住的话</div>';
      return;
    }
    el.innerHTML = "";
    for (const c of list.slice(0, 10)) {
      const item = document.createElement("div");
      item.className = "card-item";
      const del = document.createElement("button");
      del.className = "diary-item-del";
      del.textContent = "删除";
      del.addEventListener("click", async () => {
        await storage.deleteCard(c.id);
        await renderCards();
      });
      const text = document.createElement("p");
      text.className = "card-text";
      text.textContent = c.text;
      const src = document.createElement("div");
      src.className = "card-source";
      src.textContent = c.source || c.date;
      item.append(del, text, src);
      el.appendChild(item);
    }
  }

  async function saveCard() {
    const text = ui.$("card-text").value.trim();
    if (!text) {
      alert("请输入摘抄内容");
      return;
    }
    await storage.saveCard({
      source: ui.$("card-source").value.trim(),
      text,
    });
    ui.$("card-modal").hidden = true;
    await renderCards();
  }

  // ---------------- AI 周报 ----------------
  async function generateWeekly() {
    const btn = ui.$("ai-weekly");
    const resultEl = ui.$("ai-weekly-result");
    btn.disabled = true;
    btn.textContent = "生成中…";
    resultEl.innerHTML = '<p class="hint">正在汇总数据并生成周报…</p>';
    try {
      const to = storage.todayStr();
      const from = storage.offsetDateStr(-6);
      const [moods, stats, focus, reviews, goals, life] = await Promise.all([
        storage.listMoodLogs({ from, to }),
        storage.habitStats(),
        storage.focusTotal({ from, to }),
        storage.listReviews({ from, to }),
        storage.listGoals(),
        storage.lifeSummary(to),
      ]);
      const moodText = moods.length
        ? moods
            .map(
              (m) =>
                `${m.date} ${m.time} ${m.mood}${m.label ? "（" + m.label + "）" : ""} 强度${m.intensity}` +
                (m.triggers && m.triggers.length ? " 触发:" + m.triggers.join("/") : "") +
                (m.note ? " 备注:" + m.note : "")
            )
            .join("\n")
        : "（无）";
      const habitText =
        stats
          .map((s) => `${s.habit.name}：连续 ${s.streak} 天，共 ${s.total} 次`)
          .join("\n") || "（无）";
      const reviewText =
        reviews
          .map(
            (r) =>
              `${r.date} [${r.type}] 好事:${r.good || "无"} 收获:${r.learn || "无"} 计划:${r.plan || "无"}`
          )
          .join("\n") || "（无）";
      const lifeText =
        `睡眠 ${life.sleep === null ? "—" : life.sleep + "h"} · 运动 ${life.exercise}分 · ` +
        `喝水 ${life.water}杯 · 冥想 ${life.meditation}分 · 阅读 ${life.reading}分 · 精力 ${life.energy === null ? "—" : life.energy + "/5"}`;
      const system =
        "你是温和、具体、不说教的个人成长教练。请基于用户提供的一周数据写一份 300 字以内的中文周报：" +
        "先总结亮点与趋势，再指出 1-2 个可改进点，最后给出明天就能做的一个小行动。使用 Markdown 短段落，避免空话。";
      const user =
        `本周（${from} 至 ${to}）数据：\n\n【心情】\n${moodText}\n\n` +
        `【习惯】\n${habitText}\n\n【专注】\n本周 ${focus} 分钟\n\n【生活】\n${lifeText}\n\n` +
        `【复盘】\n${reviewText}\n\n【目标】\n${
          goals.map((g) => g.title + "（截止 " + g.endDate + "）").join("\n") || "（无）"
        }\n\n请生成周报。`;
      const settings = ui.aiSettings();
      const data = await api.aiChat({
        apiKey: settings.apiKey,
        model: settings.model || "deepseek-chat",
        system,
        user,
        maxTokens: 1200,
        temperature: 0.6,
      });
      if (data.error) throw new Error(data.error);
      const content = data.content || "";
      resultEl.innerHTML =
        '<h4 class="ai-title">本周周报</h4>' +
        (typeof marked !== "undefined" && marked.parse
          ? marked.parse(content)
          : content.replace(/\n/g, "<br>"));
    } catch (e) {
      resultEl.innerHTML =
        '<p class="hint">生成失败：' +
        ui.escapeHtml(String((e && e.message) || e)) +
        "（请先在设置里配置 DeepSeek Key）</p>";
    } finally {
      btn.disabled = false;
      btn.textContent = "生成本周周报";
    }
  }

  async function renderGrowth() {
    await renderOverview();
    await renderCalendar();
    await renderTrend();
    await renderHeatmap();
    await renderGrowthGoals();
    await renderFocusSessions();
    if (ui.renderReviewList) await ui.renderReviewList();
    await renderFinance();
    await renderSkills();
    await renderCards();
    if (ui.renderAutomationList) await ui.renderAutomationList();
    if (ui.renderReportList) await ui.renderReportList();
    if (ui.renderBadgeWall) await ui.renderBadgeWall();
    if (ui.renderCorrelation) await ui.renderCorrelation();
    if (ui.checkBadges) ui.checkBadges();
  }

  function bindEvents() {
    ui.$("cal-prev").addEventListener("click", () => {
      gstate.calMonth--;
      if (gstate.calMonth < 0) {
        gstate.calMonth = 11;
        gstate.calYear--;
      }
      renderCalendar();
    });
    ui.$("cal-next").addEventListener("click", () => {
      gstate.calMonth++;
      if (gstate.calMonth > 11) {
        gstate.calMonth = 0;
        gstate.calYear++;
      }
      renderCalendar();
    });
    ui.$("trend-range").addEventListener("click", () => {
      gstate.trendDays = gstate.trendDays === 30 ? 7 : 30;
      ui.$("trend-range").textContent =
        gstate.trendDays === 30 ? "近 30 天" : "近 7 天";
      renderTrend();
    });
    ui.$("focus-start").addEventListener("click", toggleFocus);
    ui.$("focus-reset").addEventListener("click", resetFocus);
    ui.$("ai-weekly").addEventListener("click", generateWeekly);
    ui.$("finance-add").addEventListener("click", openFinanceModal);
    ui.$("finance-close").addEventListener("click", () => {
      ui.$("finance-modal").hidden = true;
    });
    ui.$("finance-save").addEventListener("click", saveFinance);
    ui.$("finance-type-seg").querySelectorAll(".seg-btn").forEach((b) => {
      b.addEventListener("click", () => {
        financeType = b.dataset.type;
        ui.$("finance-type-seg").querySelectorAll(".seg-btn").forEach((x) =>
          x.classList.toggle("active", x === b)
        );
        renderFinanceCats();
      });
    });
    ui.$("skill-add").addEventListener("click", () => {
      ui.$("skill-name").value = "";
      ui.$("skill-hours").value = "";
      ui.$("skill-note").value = "";
      ui.$("skill-modal").hidden = false;
    });
    ui.$("skill-close").addEventListener("click", () => {
      ui.$("skill-modal").hidden = true;
    });
    ui.$("skill-save").addEventListener("click", saveSkill);
    ui.$("card-add").addEventListener("click", () => {
      ui.$("card-source").value = "";
      ui.$("card-text").value = "";
      ui.$("card-modal").hidden = false;
    });
    ui.$("card-close").addEventListener("click", () => {
      ui.$("card-modal").hidden = true;
    });
    ui.$("card-save").addEventListener("click", saveCard);
  }

  Object.assign(ui, {
    renderGrowth,
    bindGrowth: bindEvents,
  });
})();
