// biliSub 今天主页：日期问候 + 心情打卡 + 今日时间链（聚合目标/日记）
(function () {
  const ui = window.ui;
  const MOODS = ["😄", "😊", "😐", "😔", "😢"];

  function greetByHour() {
    const h = new Date().getHours();
    if (h < 6) return "夜深了";
    if (h < 12) return "早上好";
    if (h < 18) return "下午好";
    return "晚上好";
  }

  function formatDateCn() {
    const d = new Date();
    const week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
    return d.getMonth() + 1 + "月" + d.getDate() + "日 · 星期" + week;
  }

  function renderDate() {
    const el = ui.$("topbar-date");
    if (el) el.textContent = formatDateCn();
  }

  async function renderMood() {
    if (ui.renderMoodCard) {
      await ui.renderMoodCard();
      return;
    }
    const el = ui.$("mood-row");
    if (!el) return;
    const today = storage.todayStr();
    const cur = storage.loadMood(today);
    const titleEl = ui.$("mood-title");
    if (titleEl) {
      const label = { "😄": "今天心情很好！", "😊": "今天挺开心", "😐": "平平淡淡的一天", "😔": "有点低落", "😢": "今天不太好" };
      titleEl.textContent = label[cur] || "今天感觉怎么样？";
    }
    el.innerHTML = "";
    MOODS.forEach((m) => {
      const b = document.createElement("button");
      b.className = "mood-btn" + (cur === m ? " active" : "");
      b.textContent = m;
      b.addEventListener("click", () => {
        storage.saveMood(today, m === cur ? "" : m);
        renderMood();
      });
      el.appendChild(b);
    });
  }

  async function renderTimeline() {
    const el = ui.$("timeline");
    if (!el) return;
    const today = storage.todayStr();
    const goals = await storage.listGoals();
    const tasks = (await storage.listTasks()).filter((t) => t.date === today);
    tasks.sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));
    const done = tasks.filter((t) => t.done).length;
    ui.$("task-progress").textContent = tasks.length ? done + "/" + tasks.length + " 完成" : "";
    el.innerHTML = "";
    if (!tasks.length) {
      el.innerHTML = '<div class="empty-hint">今天还没有安排，点下方「添加事项」</div>';
      return;
    }
    for (const t of tasks) {
      el.appendChild(renderTaskItem(t, goals));
    }
  }

  function renderTaskItem(t, goals) {
    const row = document.createElement("div");
    row.className = "timeline-item" + (t.done ? " done" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!t.done;
    cb.addEventListener("change", async () => {
      t.done = cb.checked;
      await storage.saveTask(t);
      renderTimeline();
    });
    const dot = document.createElement("span");
    dot.className = "timeline-dot";
    const time = document.createElement("span");
    time.className = "timeline-time";
    time.textContent = t.time || "全天";
    const body = document.createElement("div");
    body.className = "timeline-body";
    const title = document.createElement("div");
    title.className = "timeline-title";
    title.textContent = t.title;
    body.appendChild(title);
    if (t.priority === "high") {
      const tag = document.createElement("span");
      tag.className = "priority-tag";
      tag.textContent = "重要";
      body.appendChild(tag);
    }
    if (t.goalId) {
      const g = goals.find((x) => x.id === t.goalId);
      if (g) {
        const tag = document.createElement("span");
        tag.className = "timeline-tag";
        tag.textContent = "🎯 " + g.title;
        body.appendChild(tag);
      }
    }
    const del = document.createElement("button");
    del.className = "timeline-del";
    del.textContent = "×";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      await storage.deleteTask(t.id);
      renderTimeline();
    });
    row.append(cb, dot, time, body, del);
    return row;
  }

  async function openTaskModal() {
    ui.$("task-title").value = "";
    ui.$("task-time").value = "";
    ui.$("task-priority").value = "normal";
    const sel = ui.$("task-goal");
    const goals = await storage.listGoals();
    sel.innerHTML = '<option value="">不关联</option>';
    for (const g of goals) {
      const opt = document.createElement("option");
      opt.value = g.id;
      opt.textContent = g.title;
      sel.appendChild(opt);
    }
    ui.$("task-modal").hidden = false;
    setTimeout(() => ui.$("task-title").focus(), 50);
  }

  async function saveTask() {
    const title = ui.$("task-title").value.trim();
    if (!title) {
      alert("请输入事项内容");
      return;
    }
    await storage.saveTask({
      title,
      date: storage.todayStr(),
      time: ui.$("task-time").value || "",
      priority: ui.$("task-priority").value || "normal",
      goalId: ui.$("task-goal").value || "",
      done: false,
    });
    ui.$("task-modal").hidden = true;
    await renderTimeline();
  }

  async function renderToday() {
    renderDate();
    if (ui.renderDailyQuote) ui.renderDailyQuote();
    await renderMood();
    if (ui.renderHabitsToday) await ui.renderHabitsToday();
    if (ui.renderGoals) await ui.renderGoals();
    await renderTimeline();
    if (ui.renderLifeToday) await ui.renderLifeToday();
    if (ui.renderDiaryQuick) await ui.renderDiaryQuick();
  }

  function bindEvents() {
    ui.$("task-add").addEventListener("click", openTaskModal);
    ui.$("task-close").addEventListener("click", () => {
      ui.$("task-modal").hidden = true;
    });
    ui.$("task-save").addEventListener("click", saveTask);
  }

  Object.assign(ui, {
    renderToday,
    renderTimeline,
    bindToday: bindEvents,
  });
})();
