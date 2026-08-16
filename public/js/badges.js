// 成就徽章：基于真实数据自动解锁
(function () {
  const ui = window.ui;

  const BADGES = [
    { id: "first_mood", emoji: "🎭", name: "情绪入门", desc: "第一次记录心情" },
    { id: "first_diary", emoji: "📖", name: "动笔了", desc: "写下第一篇日记" },
    { id: "first_habit", emoji: "🌱", name: "习惯萌芽", desc: "创建第一个习惯" },
    { id: "streak_7", emoji: "🔥", name: "七日连击", desc: "任一习惯连续 7 天" },
    { id: "streak_30", emoji: "⚡", name: "月度坚持", desc: "任一习惯连续 30 天" },
    { id: "habit_100", emoji: "🏆", name: "习惯大师", desc: "任一习惯累计 100 次" },
    { id: "goal_done", emoji: "🎯", name: "目标达成", desc: "完成一个目标" },
    { id: "focus_100h", emoji: "⏳", name: "专注百时", desc: "累计专注 100 小时" },
    { id: "cards_10", emoji: "💡", name: "灵感收集", desc: "收藏 10 张知识卡片" },
    { id: "cards_100", emoji: "🧠", name: "知识宝库", desc: "收藏 100 张知识卡片" },
    { id: "reviews_10", emoji: "🪞", name: "复盘达人", desc: "完成 10 次复盘" },
    { id: "life_50", emoji: "🌈", name: "生活观察家", desc: "累计 50 条生活记录" },
    { id: "all_round", emoji: "🌍", name: "全维生活", desc: "一周内记录心情/习惯/生活/专注" },
    { id: "xp_1000", emoji: "🚀", name: "千分成长", desc: "累计 1000 XP" },
  ];

  async function collect() {
    const today = storage.todayStr();
    const weekAgo = storage.offsetDateStr(-6);
    const [moods, diary, stats, goals, life, focus, cards, reviews] = await Promise.all([
      storage.listMoodLogs(),
      storage.listDiary(),
      storage.habitStats(),
      storage.listGoals(),
      storage.listLifeLogs(),
      storage.listFocusSessions(),
      storage.listCards(),
      storage.listReviews(),
    ]);
    const maxStreak = stats.reduce((s, x) => Math.max(s, x.streak), 0);
    const maxTotal = stats.reduce((s, x) => Math.max(s, x.total), 0);
    const focusMin = focus.reduce((s, f) => s + (Number(f.minutes) || 0), 0);
    const goalDone = goals.some(
      (g) =>
        (g.milestones && g.milestones.length &&
          g.milestoneDone && g.milestoneDone.filter(Boolean).length === g.milestones.length) ||
        (g.target !== null && g.target !== undefined && g.current !== null && g.current !== undefined &&
          Number(g.current) >= Number(g.target))
    );
    const xp =
      moods.length * 5 +
      diary.length * 10 +
      stats.reduce((s, x) => s + x.total, 0) * 5 +
      focusMin * 0.2 +
      reviews.length * 15 +
      goals.length * 10;
    const weekMoods = moods.some((m) => m.date >= weekAgo);
    const weekChecks = (await storage.listHabitChecks({ from: weekAgo, to: today })).some((c) => c.done);
    const weekLife = life.some((l) => l.date >= weekAgo);
    const weekFocus = focus.some((f) => f.date >= weekAgo);
    return {
      moods: moods.length,
      diary: diary.length,
      habits: stats.length,
      maxStreak,
      maxTotal,
      goalDone,
      focusMin,
      cards: cards.length,
      reviews: reviews.length,
      life: life.length,
      weekMoods,
      weekChecks,
      weekLife,
      weekFocus,
      xp: Math.round(xp),
    };
  }

  function condition(b, c) {
    switch (b.id) {
      case "first_mood": return c.moods >= 1;
      case "first_diary": return c.diary >= 1;
      case "first_habit": return c.habits >= 1;
      case "streak_7": return c.maxStreak >= 7;
      case "streak_30": return c.maxStreak >= 30;
      case "habit_100": return c.maxTotal >= 100;
      case "goal_done": return c.goalDone;
      case "focus_100h": return c.focusMin >= 6000;
      case "cards_10": return c.cards >= 10;
      case "cards_100": return c.cards >= 100;
      case "reviews_10": return c.reviews >= 10;
      case "life_50": return c.life >= 50;
      case "all_round": return c.weekMoods && c.weekChecks && c.weekLife && c.weekFocus;
      case "xp_1000": return c.xp >= 1000;
      default: return false;
    }
  }

  async function checkBadges() {
    const c = await collect();
    for (const b of BADGES) {
      if (condition(b, c) && storage.addBadge(b.id)) {
        ui.showToast("🏅 解锁徽章：" + b.name);
      }
    }
  }

  async function renderBadgeWall() {
    const el = ui.$("badge-wall");
    if (!el) return;
    const unlocked = new Set(storage.listBadges());
    const c = await collect();
    el.innerHTML = "";
    for (const b of BADGES) {
      const item = document.createElement("div");
      const isUnlocked = unlocked.has(b.id);
      item.className = "badge-item" + (isUnlocked ? "" : " locked");
      item.title = b.desc;
      item.innerHTML =
        `<div class="badge-emoji">${isUnlocked ? b.emoji : "🔒"}</div>` +
        `<div class="badge-name">${b.name}</div>` +
        `<div class="badge-desc">${isUnlocked ? b.desc : condition(b, c) ? "即将解锁" : "未解锁"}</div>`;
      el.appendChild(item);
    }
  }

  Object.assign(ui, {
    BADGES,
    checkBadges,
    renderBadgeWall,
  });
})();
