// 情绪系统 2.0：情绪库 + 强度 + 触发因素 + 多次打卡
(function () {
  const ui = window.ui;
  const QUICK = ["😄", "😊", "🙂", "😐", "😔"];

  let editing = { mood: "😐", label: "一般", intensity: 3, triggers: [] };

  function renderQuick() {
    const el = ui.$("mood-quick");
    if (!el) return;
    el.innerHTML = "";
    for (const e of QUICK) {
      const opt = ui.MOOD_OPTIONS.find((o) => o.e === e);
      const b = document.createElement("button");
      b.className = "mood-quick-btn";
      b.innerHTML = `<span class="e">${e}</span><span class="l">${opt ? opt.label : ""}</span>`;
      b.addEventListener("click", async () => {
        await storage.saveMoodLog({
          date: storage.todayStr(),
          time: new Date().toTimeString().slice(0, 5),
          mood: e,
          label: opt ? opt.label : "",
          intensity: 3,
          triggers: [],
          note: "",
        });
        ui.$("mood-modal").hidden = true;
        if (ui.renderToday) await ui.renderToday();
        else if (ui.renderMoodCard) await ui.renderMoodCard();
      });
      el.appendChild(b);
    }
  }

  function showQuickMode() {
    const detail = ui.$("mood-detail-wrap");
    const quick = ui.$("mood-quick");
    if (detail) detail.hidden = true;
    if (quick) quick.hidden = false;
    const save = ui.$("mood-save");
    const back = ui.$("mood-back");
    const more = ui.$("mood-quick-more");
    if (save) save.hidden = true;
    if (back) back.hidden = true;
    if (more) more.hidden = false;
  }

  function showDetailMode() {
    const detail = ui.$("mood-detail-wrap");
    const quick = ui.$("mood-quick");
    if (detail) detail.hidden = false;
    if (quick) quick.hidden = true;
    const save = ui.$("mood-save");
    const back = ui.$("mood-back");
    const more = ui.$("mood-quick-more");
    if (save) save.hidden = false;
    if (back) back.hidden = false;
    if (more) more.hidden = true;
  }

  function renderOptions() {
    const el = ui.$("mood-options");
    if (!el) return;
    el.innerHTML = "";
    for (const opt of ui.MOOD_OPTIONS) {
      const b = document.createElement("button");
      b.className = "mood-opt" + (editing.mood === opt.e ? " active" : "");
      b.innerHTML = `<span class="e">${opt.e}</span><span class="l">${opt.label}</span>`;
      b.addEventListener("click", () => {
        editing.mood = opt.e;
        editing.label = opt.label;
        renderOptions();
      });
      el.appendChild(b);
    }
  }

  function renderIntensity() {
    const el = ui.$("mood-intensity");
    if (!el) return;
    el.innerHTML = "";
    for (let i = 1; i <= 5; i++) {
      const b = document.createElement("button");
      b.className = "intensity-dot" + (editing.intensity === i ? " active" : "");
      b.textContent = i;
      b.title = "强度 " + i;
      b.addEventListener("click", () => {
        editing.intensity = i;
        renderIntensity();
      });
      el.appendChild(b);
    }
  }

  function renderTriggers() {
    const el = ui.$("mood-triggers");
    if (!el) return;
    el.innerHTML = "";
    for (const t of ui.MOOD_TRIGGERS) {
      const b = document.createElement("button");
      b.className = "chip" + (editing.triggers.includes(t) ? " active" : "");
      b.textContent = t;
      b.addEventListener("click", () => {
        const idx = editing.triggers.indexOf(t);
        if (idx >= 0) editing.triggers.splice(idx, 1);
        else editing.triggers.push(t);
        renderTriggers();
      });
      el.appendChild(b);
    }
  }

  function openMoodModal(preset) {
    const p = preset
      ? ui.MOOD_OPTIONS.find((o) => o.e === preset)
      : null;
    editing = {
      mood: p ? p.e : "😐",
      label: p ? p.label : "一般",
      intensity: 3,
      triggers: [],
    };
    const note = ui.$("mood-note");
    if (note) note.value = "";
    if (preset) {
      renderQuick();
      showQuickMode();
    } else {
      renderOptions();
      renderIntensity();
      renderTriggers();
      showDetailMode();
    }
    ui.$("mood-modal").hidden = false;
  }

  async function saveMood() {
    await storage.saveMoodLog({
      date: storage.todayStr(),
      time: new Date().toTimeString().slice(0, 5),
      mood: editing.mood,
      label: editing.label,
      intensity: editing.intensity,
      triggers: editing.triggers.slice(),
      note: ui.$("mood-note").value.trim(),
    });
    ui.$("mood-modal").hidden = true;
    if (ui.renderToday) await ui.renderToday();
    else if (ui.renderMoodCard) await ui.renderMoodCard();
  }

  async function renderMoodCard() {
    const el = ui.$("mood-row");
    if (!el) return;
    const today = storage.todayStr();
    const logs = await storage.listMoodLogs({ from: today, to: today });
    const latest = logs.length ? logs[logs.length - 1] : null;
    const titleEl = ui.$("mood-title");
    if (titleEl) {
      titleEl.textContent = latest
        ? "今天" + (latest.label || "已记录") +
          (latest.intensity ? " · 强度 " + latest.intensity : "")
        : "今天感觉怎么样？";
    }
    const moreEl = ui.$("mood-more");
    if (moreEl) {
      moreEl.textContent = logs.length
        ? "已记录 " + logs.length + " 次 · 详情"
        : "记录详情与原因";
    }
    el.innerHTML = "";
    for (const m of ui.MOOD_OPTIONS) {
      const b = document.createElement("button");
      b.className = "mood-btn";
      b.textContent = m.e;
      b.title = m.label;
      b.addEventListener("click", () => openMoodModal(m.e));
      el.appendChild(b);
    }
  }

  function bindEvents() {
    ui.$("mood-save").addEventListener("click", saveMood);
    ui.$("mood-close").addEventListener("click", () => {
      ui.$("mood-modal").hidden = true;
    });
    ui.$("mood-more").addEventListener("click", () => openMoodModal(""));
    ui.$("mood-quick-more").addEventListener("click", () => {
      renderOptions();
      renderIntensity();
      renderTriggers();
      showDetailMode();
    });
    ui.$("mood-back").addEventListener("click", () => {
      renderQuick();
      showQuickMode();
    });
  }

  Object.assign(ui, {
    openMoodModal,
    renderMoodCard,
    bindMood: bindEvents,
  });
})();
