// 生活维度记录：睡眠 / 运动 / 喝水 / 冥想 / 阅读 / 精力 / 专注
(function () {
  const ui = window.ui;
  const TYPES = [
    { t: "sleep", label: "睡眠", emoji: "🛌", unit: "小时", placeholder: "如 7.5" },
    { t: "exercise", label: "运动", emoji: "🏃", unit: "分钟", placeholder: "如 30" },
    { t: "water", label: "喝水", emoji: "💧", unit: "杯", placeholder: "如 8" },
    { t: "meditation", label: "冥想", emoji: "🧘", unit: "分钟", placeholder: "如 10" },
    { t: "reading", label: "阅读", emoji: "📚", unit: "分钟", placeholder: "如 45" },
    { t: "energy", label: "精力", emoji: "⚡", unit: "1-5", placeholder: "如 4" },
    { t: "focus", label: "专注", emoji: "🎯", unit: "分钟", placeholder: "如 60" },
  ];
  let lifeType = "exercise";

  const EMOJI_MAP = {
    sleep: "🛌",
    exercise: "🏃",
    water: "💧",
    meditation: "🧘",
    reading: "📚",
    energy: "⚡",
    focus: "🎯",
  };
  const QUICK_VALUES = {
    sleep: [7, 7.5, 8],
    exercise: [15, 30, 60],
    water: [1, 3, 8],
    meditation: [5, 10, 20],
    reading: [15, 30, 60],
    energy: [3, 4, 5],
    focus: [25, 45, 60],
  };

  async function renderLifeToday() {
    const el = ui.$("life-today");
    if (!el) return;
    const sum = await storage.lifeSummary(storage.todayStr());
    el.innerHTML = "";
    const tiles = [
      { k: "sleep", label: "睡眠", v: sum.sleep === null ? "—" : sum.sleep, u: "h" },
      { k: "exercise", label: "运动", v: sum.exercise || "—", u: "分" },
      { k: "water", label: "喝水", v: sum.water || "—", u: "杯" },
      { k: "meditation", label: "冥想", v: sum.meditation || "—", u: "分" },
      { k: "reading", label: "阅读", v: sum.reading || "—", u: "分" },
      { k: "energy", label: "精力", v: sum.energy === null ? "—" : sum.energy, u: "/5" },
      { k: "focus", label: "专注", v: sum.focus || "—", u: "分" },
    ];
    for (const t of tiles) {
      const d = document.createElement("div");
      d.className = "life-tile";
      d.innerHTML =
        `<div class="life-emoji">${EMOJI_MAP[t.k] || "📝"}</div>` +
        `<div class="life-num">${ui.escapeHtml(String(t.v))}<span class="life-unit">${t.u}</span></div>` +
        `<div class="life-label">${t.label}</div>`;
      d.addEventListener("click", () => openLifeModal(t.k));
      el.appendChild(d);
    }
  }

  function renderTypePick() {
    const el = ui.$("life-type-pick");
    if (!el) return;
    el.innerHTML = "";
    for (const t of TYPES) {
      const b = document.createElement("button");
      b.className = "chip" + (lifeType === t.t ? " active" : "");
      b.textContent = t.emoji + " " + t.label;
      b.addEventListener("click", () => {
        lifeType = t.t;
        renderTypePick();
        updateLabel();
        renderQuickValues();
      });
      el.appendChild(b);
    }
  }

  function updateLabel() {
    const t = TYPES.find((x) => x.t === lifeType);
    const labelEl = ui.$("life-amount-label");
    const inputEl = ui.$("life-amount");
    if (labelEl) labelEl.textContent = t ? t.label + "（" + t.unit + "）" : "数值";
    if (inputEl) inputEl.placeholder = t ? t.placeholder : "";
  }

  function renderQuickValues() {
    const el = ui.$("life-quick-values");
    if (!el) return;
    const t = TYPES.find((x) => x.t === lifeType);
    const vals = QUICK_VALUES[lifeType] || [];
    el.innerHTML = "";
    for (const v of vals) {
      const b = document.createElement("button");
      b.className = "chip";
      b.textContent = String(v) + (t ? t.unit.replace("1-5", "") : "");
      b.addEventListener("click", async () => {
        await storage.saveLifeLog({
          date: storage.todayStr(),
          type: lifeType,
          amount: v,
          unit: t ? t.unit : "分钟",
          note: "",
        });
        ui.$("life-modal").hidden = true;
        if (ui.renderToday) await ui.renderToday();
        if (ui.renderGrowth) ui.renderGrowth();
      });
      el.appendChild(b);
    }
  }

  function openLifeModal(type) {
    if (type) lifeType = type;
    const inputEl = ui.$("life-amount");
    if (inputEl) inputEl.value = "";
    const noteEl = ui.$("life-note");
    if (noteEl) noteEl.value = "";
    renderTypePick();
    updateLabel();
    renderQuickValues();
    ui.$("life-modal").hidden = false;
  }

  async function saveLife() {
    const t = TYPES.find((x) => x.t === lifeType);
    const amount = Number(ui.$("life-amount").value);
    if (!(amount >= 0)) {
      alert("请输入数值");
      return;
    }
    await storage.saveLifeLog({
      date: storage.todayStr(),
      type: lifeType,
      amount,
      unit: t ? t.unit : "分钟",
      note: ui.$("life-note").value.trim(),
    });
    ui.$("life-modal").hidden = true;
    if (ui.renderToday) await ui.renderToday();
    if (ui.renderGrowth) ui.renderGrowth();
  }

  function bindEvents() {
    ui.$("life-add").addEventListener("click", () => openLifeModal(""));
    ui.$("life-save").addEventListener("click", saveLife);
    ui.$("life-close").addEventListener("click", () => {
      ui.$("life-modal").hidden = true;
    });
  }

  Object.assign(ui, {
    renderLifeToday,
    bindLife: bindEvents,
  });
})();
