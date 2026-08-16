// 习惯追踪：新建/编辑/删除、每日打卡、连续天数
(function () {
  const ui = window.ui;
  const EMOJIS = ["✅", "📚", "🏃", "💪", "🧘", "💧", "🛌", "🥗", "✍️", "🧠", "🎯", "🌅", "🚭", "💊"];
  let editingId = "";
  let emojiPick = "✅";
  let habitFreq = "daily";
  let weeklyPick = 3;
  let patchHabitId = "";
  let patchHabitName = "";

  function renderForgivenessCount() {
    const el = ui.$("forgiveness-count");
    if (!el) return;
    const f = storage.loadForgiveness();
    el.textContent = "宽恕卡 " + f.left;
  }

  async function renderHabitsToday() {
    const el = ui.$("habit-today");
    if (!el) return;
    const stats = await storage.habitStats();
    if (!stats.length) {
      el.innerHTML = '<div class="empty-hint">还没有习惯，点「＋ 新建」开始每天打卡</div>';
      return;
    }
    el.innerHTML = "";
    for (const s of stats) {
      const h = s.habit;
      const row = document.createElement("div");
      row.className = "habit-row" + (s.doneToday ? " done" : "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = s.doneToday;
      cb.addEventListener("change", async () => {
        await storage.toggleHabitCheck(h.id, storage.todayStr());
        await renderHabitsToday();
        if (ui.renderGrowth) ui.renderGrowth();
      });
      const emoji = document.createElement("span");
      emoji.className = "habit-emoji";
      emoji.textContent = h.emoji || "✅";
      const body = document.createElement("div");
      body.className = "habit-body";
      const name = document.createElement("div");
      name.className = "habit-name";
      name.textContent = h.name;
      const meta = document.createElement("div");
      meta.className = "habit-meta";
      meta.textContent = "连续 " + s.streak + " 天 · 共 " + s.total + " 次";
      body.append(name, meta);
      const edit = document.createElement("button");
      edit.className = "habit-edit";
      edit.textContent = "⋯";
      edit.addEventListener("click", (e) => {
        e.stopPropagation();
        openHabitModal(h.id);
      });
      const patch = document.createElement("button");
      patch.className = "habit-edit";
      patch.textContent = "补";
      patch.title = "补打卡（消耗宽恕卡）";
      patch.addEventListener("click", (e) => {
        e.stopPropagation();
        openPatchModal(h.id, h.name);
      });
      row.append(cb, emoji, body, patch, edit);
      el.appendChild(row);
    }
    renderForgivenessCount();
  }

  function openPatchModal(habitId, name) {
    patchHabitId = habitId;
    patchHabitName = name || "";
    ui.$("habit-patch-name").textContent = "习惯：" + patchHabitName;
    const d = new Date();
    d.setDate(d.getDate() - 1);
    ui.$("habit-patch-date").value =
      d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    ui.$("habit-patch-modal").hidden = false;
  }

  async function savePatch() {
    if (!patchHabitId) return;
    const date = ui.$("habit-patch-date").value;
    if (!date) {
      alert("请选择日期");
      return;
    }
    const cur = await storage.getHabitCheck(patchHabitId, date);
    if (cur && cur.done) {
      alert("这一天已经打过卡了");
      return;
    }
    if (!storage.useForgiveness()) {
      alert("本月宽恕卡已用完，下个月自动恢复 3 张");
      return;
    }
    await storage.setHabitCheck(patchHabitId, date, true);
    ui.$("habit-patch-modal").hidden = true;
    ui.showToast("补打卡成功，消耗 1 张宽恕卡");
    await renderHabitsToday();
    if (ui.renderGrowth) ui.renderGrowth();
  }

  function suggestEmoji(name) {
    const map = [
      ["运动", "🏃"], ["跑步", "🏃"], ["健身", "💪"], ["读书", "📚"], ["阅读", "📚"],
      ["冥想", "🧘"], ["喝水", "💧"], ["早起", "🌅"], ["睡眠", "🛌"], ["英语", "✍️"],
      ["写作", "✍️"], ["编程", "🧠"], ["学习", "🧠"], ["日记", "📖"], ["饮食", "🥗"],
    ];
    for (const [k, e] of map) {
      if (String(name || "").includes(k)) return e;
    }
    return "✅";
  }

  function renderEmojiBtn() {
    const b = ui.$("habit-emoji");
    if (b) b.textContent = emojiPick;
  }

  function cycleEmoji() {
    const idx = EMOJIS.indexOf(emojiPick);
    emojiPick = EMOJIS[(idx + 1) % EMOJIS.length];
    renderEmojiBtn();
  }

  function renderFreqSeg() {
    const seg = ui.$("habit-freq-seg");
    if (!seg) return;
    seg.querySelectorAll(".seg-mini-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.freq === habitFreq);
    });
    const wrap = ui.$("habit-weekly-wrap");
    if (wrap) wrap.hidden = habitFreq !== "weekly";
  }

  function renderDigitPick() {
    const el = ui.$("habit-weekly-pick");
    if (!el) return;
    el.innerHTML = "";
    for (let i = 1; i <= 7; i++) {
      const b = document.createElement("button");
      b.className = "digit-btn" + (weeklyPick === i ? " active" : "");
      b.textContent = i;
      b.addEventListener("click", () => {
        weeklyPick = i;
        renderDigitPick();
      });
      el.appendChild(b);
    }
    const hidden = ui.$("habit-weekly");
    if (hidden) hidden.value = weeklyPick;
  }

  async function openHabitModal(id) {
    editingId = id || "";
    const h = id
      ? (await storage.listHabits()).find((x) => x.id === id)
      : null;
    ui.$("habit-modal-title").textContent = h ? "编辑习惯" : "新建习惯";
    ui.$("habit-name").value = h ? h.name : "";
    habitFreq = h ? h.frequency || "daily" : "daily";
    weeklyPick = h ? h.targetPerWeek || 3 : 3;
    emojiPick = h ? h.emoji || "✅" : suggestEmoji(ui.$("habit-name").value);
    renderFreqSeg();
    renderDigitPick();
    renderEmojiBtn();
    ui.$("habit-delete").hidden = !h;
    ui.$("habit-modal").hidden = false;
  }

  async function saveHabit() {
    const name = ui.$("habit-name").value.trim();
    if (!name) {
      alert("请输入习惯名称");
      return;
    }
    const freq = habitFreq;
    const existing = editingId
      ? (await storage.listHabits()).find((x) => x.id === editingId)
      : null;
    await storage.saveHabit({
      id: editingId || undefined,
      name,
      emoji: emojiPick,
      frequency: freq,
      targetPerWeek: freq === "weekly" ? weeklyPick : 0,
      archived: existing ? existing.archived : false,
    });
    ui.$("habit-modal").hidden = true;
    if (ui.renderToday) await ui.renderToday();
    else await renderHabitsToday();
    if (ui.renderGrowth) ui.renderGrowth();
  }

  async function deleteHabit() {
    if (!editingId) return;
    if (!confirm("删除这个习惯及其全部打卡记录？")) return;
    await storage.deleteHabit(editingId);
    ui.$("habit-modal").hidden = true;
    if (ui.renderToday) await ui.renderToday();
    if (ui.renderGrowth) ui.renderGrowth();
  }

  function bindEvents() {
    ui.$("habit-add").addEventListener("click", () => openHabitModal(""));
    ui.$("habit-open").addEventListener("click", () => openHabitModal(""));
    ui.$("habit-save").addEventListener("click", saveHabit);
    ui.$("habit-delete").addEventListener("click", deleteHabit);
    ui.$("habit-close").addEventListener("click", () => {
      ui.$("habit-modal").hidden = true;
    });
    ui.$("habit-freq-seg").querySelectorAll(".seg-mini-btn").forEach((b) => {
      b.addEventListener("click", () => {
        habitFreq = b.dataset.freq;
        renderFreqSeg();
      });
    });
    ui.$("habit-emoji").addEventListener("click", cycleEmoji);
    ui.$("habit-name").addEventListener("input", () => {
      if (!editingId) {
        emojiPick = suggestEmoji(ui.$("habit-name").value);
        renderEmojiBtn();
      }
    });
    ui.$("habit-patch-save").addEventListener("click", savePatch);
    ui.$("habit-patch-close").addEventListener("click", () => {
      ui.$("habit-patch-modal").hidden = true;
    });
    renderForgivenessCount();
  }

  Object.assign(ui, {
    renderHabitsToday,
    bindHabits: bindEvents,
  });
})();
