// AI 教练问答 + 情绪相关性分析
(function () {
  const ui = window.ui;
  const SCORE = { "😢": 1, "😔": 1.5, "😤": 2, "😰": 2, "🥱": 2.5, "😐": 3, "🙂": 4, "😊": 4.5, "😄": 5, "🤩": 5 };

  function avg(list) {
    if (!list.length) return null;
    return list.reduce((s, x) => s + x, 0) / list.length;
  }

  async function renderCorrelation() {
    const el = ui.$("correlation");
    if (!el) return;
    const from = storage.offsetDateStr(-29);
    const to = storage.todayStr();
    const [moods, life] = await Promise.all([
      storage.listMoodLogs({ from, to }),
      storage.listLifeLogs({ from, to }),
    ]);
    const dayMap = {};
    for (const m of moods) {
      if (!dayMap[m.date]) dayMap[m.date] = { scores: [], sleep: null, exercise: 0 };
      dayMap[m.date].scores.push(SCORE[m.mood] || 3);
    }
    for (const l of life) {
      if (!dayMap[l.date]) dayMap[l.date] = { scores: [], sleep: null, exercise: 0 };
      if (l.type === "sleep") dayMap[l.date].sleep = Number(l.amount) || 0;
      if (l.type === "exercise") dayMap[l.date].exercise = (dayMap[l.date].exercise || 0) + (Number(l.amount) || 0);
    }
    const days = Object.values(dayMap).filter((d) => d.scores.length);
    if (days.length < 3) {
      el.innerHTML = '<p class="hint">再记录几天心情和生活数据，就能看到“睡眠/运动对心情的影响”了。</p>';
      return;
    }
    const sleepOK = days.filter((d) => d.sleep !== null && d.sleep >= 7).map((d) => avg(d.scores));
    const sleepBad = days.filter((d) => d.sleep !== null && d.sleep < 7).map((d) => avg(d.scores));
    const exOK = days.filter((d) => d.exercise >= 20).map((d) => avg(d.scores));
    const exNo = days.filter((d) => d.exercise < 20).map((d) => avg(d.scores));

    function block(title, a, b, la, lb) {
      const div = document.createElement("div");
      div.className = "corr-block";
      const h = document.createElement("div");
      h.className = "corr-title";
      h.textContent = title;
      const bars = document.createElement("div");
      bars.className = "corr-bars";
      for (const [v, label] of [[a, la], [b, lb]]) {
        const col = document.createElement("div");
        col.className = "corr-bar-col";
        const val = document.createElement("div");
        val.className = "corr-bar-value";
        val.textContent = v === null ? "—" : v.toFixed(1) + "/5";
        const track = document.createElement("div");
        track.className = "corr-bar-track";
        const fill = document.createElement("div");
        fill.className = "corr-bar-fill";
        fill.style.width = (v === null ? 0 : Math.max(4, (v / 5) * 100)) + "%";
        track.appendChild(fill);
        const lbl = document.createElement("div");
        lbl.className = "corr-bar-label";
        lbl.textContent = label;
        col.append(val, track, lbl);
        bars.appendChild(col);
      }
      div.append(h, bars);
      return div;
    }

    el.innerHTML = "";
    el.appendChild(
      block("睡眠充足（≥7h）vs 不足 的平均心情", avg(sleepOK), avg(sleepBad), "睡够", "睡不够")
    );
    el.appendChild(
      block("运动 ≥20 分钟 vs 不足 的平均心情", avg(exOK), avg(exNo), "运动了", "没运动")
    );
    if (avg(sleepOK) !== null && avg(sleepBad) !== null) {
      const diff = avg(sleepOK) - avg(sleepBad);
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent =
        diff >= 0.3
          ? "看起来睡够的日子心情平均高出 " + diff.toFixed(1) + " 分，睡眠对你很重要。"
          : "目前睡眠与心情差异不大，继续记录观察。";
      el.appendChild(p);
    }
  }

  async function askCoach() {
    const q = ui.$("coach-question").value.trim();
    if (!q) {
      alert("先输入你想问的问题");
      return;
    }
    const btn = ui.$("coach-ask");
    const result = ui.$("coach-result");
    btn.disabled = true;
    btn.textContent = "思考中…";
    result.innerHTML = '<p class="hint">AI 教练正在阅读你的数据…</p>';
    try {
      const to = storage.todayStr();
      const from = storage.offsetDateStr(-29);
      const [moods, stats, focus, reviews, life, goals] = await Promise.all([
        storage.listMoodLogs({ from, to }),
        storage.habitStats(),
        storage.focusTotal({ from, to }),
        storage.listReviews({ from, to }),
        storage.lifeSummary(to),
        storage.listGoals(),
      ]);
      const moodText = moods.length
        ? moods.map((m) => `${m.date} ${m.mood}${m.label ? "(" + m.label + ")" : ""} 强度${m.intensity}${m.triggers && m.triggers.length ? " 触发:" + m.triggers.join("/") : ""}`).join("\n")
        : "（无）";
      const habitText = stats.map((s) => `${s.habit.name}：连续${s.streak}天，共${s.total}次`).join("\n") || "（无）";
      const system =
        "你是温和、具体、不说教的个人成长教练。用户会提供最近 30 天的真实数据和一个问题。" +
        "请基于数据回答，先给结论，再给 1-2 个可执行建议；不知道的就说不确定。用 Markdown，300 字以内。";
      const user =
        `最近 30 天数据：\n【心情】\n${moodText}\n【习惯】\n${habitText}\n【专注】${focus} 分钟\n` +
        `【生活】睡眠 ${life.sleep === null ? "—" : life.sleep + "h"} 运动 ${life.exercise}分 喝水 ${life.water}杯 冥想 ${life.meditation}分 阅读 ${life.reading}分\n` +
        `【复盘】\n${reviews.map((r) => r.date + " " + (r.learn || r.good || "")).join("\n") || "（无）"}\n` +
        `【目标】${goals.map((g) => g.title).join("、") || "（无）"}\n\n用户的问题：${q}`;
      const settings = ui.aiSettings();
      const data = await api.aiChat({
        apiKey: settings.apiKey,
        model: settings.model || "deepseek-chat",
        system,
        user,
        maxTokens: 900,
        temperature: 0.6,
      });
      if (data.error) throw new Error(data.error);
      result.innerHTML =
        typeof marked !== "undefined" && marked.parse
          ? marked.parse(data.content || "")
          : (data.content || "").replace(/\n/g, "<br>");
    } catch (e) {
      result.innerHTML =
        '<p class="hint">教练回答失败：' +
        ui.escapeHtml(String((e && e.message) || e)) +
        "（请先在设置里配置 DeepSeek Key）</p>";
    } finally {
      btn.disabled = false;
      btn.textContent = "问 AI 教练";
    }
  }

  function bindEvents() {
    ui.$("coach-ask").addEventListener("click", askCoach);
  }

  Object.assign(ui, {
    renderCorrelation,
    bindCoach: bindEvents,
  });
})();
