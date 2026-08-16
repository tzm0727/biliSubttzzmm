// 趣味功能：每日一句、记忆回顾、月度 Wrapped
(function () {
  const ui = window.ui;

  const QUOTES = [
    ["种一棵树最好的时间是十年前，其次是现在。", "非洲谚语"],
    ["真正的自由，是拥有选择的自由。", "佚名"],
    ["你不需要很厉害才能开始，但你需要开始才能很厉害。", "佚名"],
    ["生活的意义在于折腾，在于不断成为更好的自己。", "佚名"],
    ["每天进步 1%，一年后你会强大 37 倍。", "复利思维"],
    ["健康是 1，其他都是后面的 0。", "佚名"],
    ["自律给我自由。", "Keep"],
    ["先完成，再完美。", "佚名"],
    ["不要等待完美时机，把握现在就是最好的时机。", "佚名"],
    ["读书是为了遇见更好的自己。", "杨绛"],
    ["日拱一卒，功不唐捐。", "胡适"],
    ["把每一天当作余生第一天。", "佚名"],
    ["坚持不是长跑，而是一连串的重新开始。", "佚名"],
    ["你的注意力在哪里，你的人生就在哪里。", "佚名"],
    ["睡眠是最好的投资。", "佚名"],
    ["简单的事情重复做，重复的事情用心做。", "佚名"],
    ["心情不是人生的全部，却能左右人生的全部。", "佚名"],
    ["记录，是对抗遗忘的唯一方式。", "佚名"],
    ["少即是多，慢即是快。", "佚名"],
    ["愿你今天也有好好照顾自己。", "佚名"],
  ];

  function renderDailyQuote() {
    const el = ui.$("quote-card");
    if (!el) return;
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 0);
    const dayOfYear = Math.floor((now - start) / 86400000);
    const [text, author] = QUOTES[dayOfYear % QUOTES.length];
    el.innerHTML =
      `<div class="quote-text">“${text}”</div>` +
      `<div class="quote-author">— ${author}</div>`;
  }

  function dateOf(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  async function pickMemory(kind) {
    const [diary, cards] = await Promise.all([storage.listDiary(), storage.listCards()]);
    const items = [];
    for (const d of diary) {
      items.push({ type: "日记", date: d.date, mood: d.mood || "", text: d.content || "" });
    }
    for (const c of cards) {
      items.push({ type: "知识卡片", date: dateOf(c.createdAt), text: c.text, source: c.source || "" });
    }
    let picked = null;
    if (kind === "yesterday") {
      const now = new Date();
      const lastYear = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
      const target =
        lastYear.getFullYear() + "-" + String(lastYear.getMonth() + 1).padStart(2, "0") + "-" + String(lastYear.getDate()).padStart(2, "0");
      const matches = items.filter((x) => x.date === target);
      if (matches.length) picked = matches[matches.length - 1];
    } else {
      if (items.length) picked = items[Math.floor(Math.random() * items.length)];
    }
    if (!picked) {
      ui.showToast(kind === "yesterday" ? "去年今天还没有记录" : "还没有可回顾的记录");
      return;
    }
    ui.$("memory-title").textContent = picked.type;
    ui.$("memory-date").textContent = picked.date + (picked.mood ? " · " + picked.mood : "");
    ui.$("memory-content").textContent =
      (picked.source ? "【" + picked.source + "】\n" : "") + (picked.text || "（无内容）");
    ui.$("memory-modal").hidden = false;
  }

  async function openWrapped() {
    const today = storage.todayStr();
    const month = today.slice(0, 7);
    const monthStart = month + "-01";
    const [moods, stats, diary, reviews, life, focus, cards] = await Promise.all([
      storage.listMoodLogs({ from: monthStart, to: today }),
      storage.habitStats(),
      storage.listDiary(),
      storage.listReviews({ from: monthStart, to: today }),
      storage.listLifeLogs({ from: monthStart, to: today }),
      storage.listFocusSessions({ from: monthStart, to: today }),
      storage.listCards(),
    ]);
    const days = new Set();
    for (const m of moods) days.add(m.date);
    for (const d of diary) days.add(d.date);
    for (const r of reviews) days.add(r.date);
    for (const l of life) days.add(l.date);
    for (const f of focus) days.add(f.date);
    const bestHabit = stats.slice().sort((a, b) => b.total - a.total)[0];
    const focusMin = focus.reduce((s, f) => s + (Number(f.minutes) || 0), 0);
    const moodAvg = moods.length
      ? moods.reduce((s, m) => s + ({ "😢": 1, "😔": 1.5, "😤": 2, "😰": 2, "🥱": 2.5, "😐": 3, "🙂": 4, "😊": 4.5, "😄": 5, "🤩": 5 }[m.mood] || 3), 0) / moods.length
      : null;
    const y = Number(month.slice(0, 4));
    const m = Number(month.slice(5, 7));
    ui.$("wrapped-title").textContent = y + " 年 " + m + " 月 Wrapped";
    ui.$("wrapped-card").innerHTML =
      `<h4>我的 ${m} 月成长</h4>` +
      `<div class="wrapped-sub">${y} 年 · 属于你的成长报告</div>` +
      `<div class="wrapped-stats">` +
      `<div class="wrapped-stat"><div class="v">${days.size}</div><div class="k">记录天数</div></div>` +
      `<div class="wrapped-stat"><div class="v">${moodAvg === null ? "—" : moodAvg.toFixed(1)}</div><div class="k">平均心情</div></div>` +
      `<div class="wrapped-stat"><div class="v">${stats.reduce((s, x) => s + x.total, 0)}</div><div class="k">习惯打卡</div></div>` +
      `<div class="wrapped-stat"><div class="v">${focusMin}</div><div class="k">专注分钟</div></div>` +
      `</div>` +
      `<p class="wrapped-line">${bestHabit ? "本月最佳习惯：" + bestHabit.habit.name + "（" + bestHabit.total + " 次）" : "本月还没有稳定习惯"}` +
      ` · 日记 ${diary.length} 篇 · 复盘 ${reviews.length} 次 · 卡片 ${cards.length} 张</p>`;
    ui.$("wrapped-modal").hidden = false;
  }

  function exportWrapped() {
    const title = ui.$("wrapped-title").textContent;
    const content = ui.$("wrapped-card").textContent.replace(/\s+/g, " ").trim();
    const md = `# ${title}\n\n${content}\n`;
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = title.replace(/\s+/g, "-") + ".md";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 3000);
  }

  function bindEvents() {
    ui.$("memory-yesterday").addEventListener("click", () => pickMemory("yesterday"));
    ui.$("memory-random").addEventListener("click", () => pickMemory("random"));
    ui.$("memory-close").addEventListener("click", () => {
      ui.$("memory-modal").hidden = true;
    });
    ui.$("wrapped-open").addEventListener("click", openWrapped);
    ui.$("wrapped-export").addEventListener("click", exportWrapped);
    ui.$("wrapped-close").addEventListener("click", () => {
      ui.$("wrapped-modal").hidden = true;
    });
  }

  Object.assign(ui, {
    renderDailyQuote,
    bindFun: bindEvents,
  });
})();
