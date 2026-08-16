// 文件库 + 生活模块（目标/任务/日记）的 IndexedDB 与本地设置
(function () {
  const DB_NAME = "biliSubWeb";
  const DB_VERSION = 4;
  const LS_COOKIES = "biliSub_cookies";
  const LS_AI = "biliSub_ai";
  const LS_TOKEN = "biliSub_access_token";
  const LS_THEME = "biliSub_theme";
  const LS_FONT = "biliSub_font";
  const LS_MOOD = "biliSub_mood_"; // 每天的心情，键后缀 YYYY-MM-DD

  let dbPromise = null;

  function openDB() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("files")) {
            const store = db.createObjectStore("files", { keyPath: "id" });
            store.createIndex("updatedAt", "updatedAt");
          }
          // v2 新增：生活模块
          if (!db.objectStoreNames.contains("goals")) {
            db.createObjectStore("goals", { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains("tasks")) {
            const ts = db.createObjectStore("tasks", { keyPath: "id" });
            ts.createIndex("date", "date");
          }
          if (!db.objectStoreNames.contains("diary")) {
            const ds = db.createObjectStore("diary", { keyPath: "id" });
            ds.createIndex("date", "date");
          }
          // v3 新增：个人成长模块
          if (!db.objectStoreNames.contains("mood_logs")) {
            const ms = db.createObjectStore("mood_logs", { keyPath: "id" });
            ms.createIndex("date", "date");
          }
          if (!db.objectStoreNames.contains("habits")) {
            db.createObjectStore("habits", { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains("habit_checks")) {
            const hc = db.createObjectStore("habit_checks", { keyPath: "id" });
            hc.createIndex("habitId", "habitId");
            hc.createIndex("date", "date");
          }
          if (!db.objectStoreNames.contains("life_logs")) {
            const ll = db.createObjectStore("life_logs", { keyPath: "id" });
            ll.createIndex("date", "date");
            ll.createIndex("type", "type");
          }
          if (!db.objectStoreNames.contains("focus")) {
            const fs = db.createObjectStore("focus", { keyPath: "id" });
            fs.createIndex("date", "date");
          }
          if (!db.objectStoreNames.contains("reviews")) {
            const rs = db.createObjectStore("reviews", { keyPath: "id" });
            rs.createIndex("date", "date");
          }
          if (!db.objectStoreNames.contains("finance")) {
            const fn = db.createObjectStore("finance", { keyPath: "id" });
            fn.createIndex("date", "date");
          }
          if (!db.objectStoreNames.contains("skills")) {
            db.createObjectStore("skills", { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains("cards")) {
            db.createObjectStore("cards", { keyPath: "id" });
          }
          // v4 新增：自动化规则与生成报告
          if (!db.objectStoreNames.contains("automations")) {
            db.createObjectStore("automations", { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains("reports")) {
            const rp = db.createObjectStore("reports", { keyPath: "id" });
            rp.createIndex("automationId", "automationId");
            rp.createIndex("date", "date");
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  function tx(storeName, mode, fn) {
    return openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(storeName, mode);
          const store = t.objectStore(storeName);
          const out = fn(store);
          t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        })
    );
  }

  // 跨多表事务（备份/恢复、级联删除用）
  function txMany(storeNames, mode, fn) {
    return openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(storeNames, mode);
          const stores = {};
          for (const name of storeNames) stores[name] = t.objectStore(name);
          let out;
          try {
            out = fn(stores);
          } catch (e) {
            reject(e);
            return;
          }
          t.oncomplete = () =>
            resolve(out && out.result !== undefined ? out.result : undefined);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        })
    );
  }

  function newId(prefix) {
    return (prefix || "id") + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  // 从文件推断合集标题
  function groupTitle(f) {
    if (f.meta && f.meta.title) return String(f.meta.title);
    if (f.meta && f.meta.topic) return String(f.meta.topic);
    if (f.meta && f.meta.from && f.meta.from !== "议题成文") {
      const from = String(f.meta.from);
      const dot = from.lastIndexOf(".");
      return dot > 0 ? from.slice(0, dot) : from;
    }
    const name = f.name || "";
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
  }

  const storage = {
    // ---------------- 文件 ----------------
    async listFiles() {
      const all = await tx("files", "readonly", (s) => s.getAll());
      all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return all;
    },

    async getFile(id) {
      return tx("files", "readonly", (s) => s.get(id));
    },

    async saveFile(record) {
      const now = Date.now();
      const rec = Object.assign(
        {
          id: "f_" + now.toString(36) + "_" + Math.random().toString(36).slice(2, 8),
          name: "",
          ext: "txt",
          content: "",
          size: 0,
          createdAt: now,
          updatedAt: now,
          bvid: "",
          lang: "",
          meta: {},
          groupId: "",
        },
        record
      );
      if (!rec.id) rec.id = "f_" + now.toString(36) + "_" + Math.random().toString(36).slice(2, 8);
      rec.size = (rec.content || "").length;
      rec.updatedAt = Date.now();
      // 自动归类：同一视频的字幕/润色/科普共享 groupId
      if (!rec.groupId) {
        if (rec.bvid) rec.groupId = "bvid:" + rec.bvid;
        else if (rec.meta && rec.meta.from && rec.meta.from !== "议题成文") rec.groupId = "from:" + rec.meta.from;
        else rec.groupId = rec.id;
      }
      await tx("files", "readwrite", (s) => s.put(rec));
      return rec;
    },

    // 聚合文件为"合集"（书架条目）
    async listGroups() {
      const files = await storage.listFiles();
      const groups = new Map();
      for (const f of files) {
        const key = f.groupId || f.id;
        if (!groups.has(key)) {
          groups.set(key, { id: key, title: "", files: [] });
        }
        const g = groups.get(key);
        g.files.push(f);
        if (!g.title) g.title = groupTitle(f);
      }
      const list = Array.from(groups.values());
      // 标题排序 + 每个合集内文件按时间排序
      list.sort((a, b) => (b.files[0].updatedAt || 0) - (a.files[0].updatedAt || 0));
      for (const g of list) {
        g.files.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
      }
      return list;
    },

    async renameFile(id, name) {
      const rec = await storage.getFile(id);
      if (!rec) return null;
      const dot = name.lastIndexOf(".");
      rec.name = name;
      rec.ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "txt";
      rec.updatedAt = Date.now();
      await tx("files", "readwrite", (s) => s.put(rec));
      return rec;
    },

    async deleteFile(id) {
      await tx("files", "readwrite", (s) => s.delete(id));
      localStorage.removeItem(LS_FONT + "_" + id);
      localStorage.removeItem("biliSub_pos_" + id);
    },

    // ---------------- 目标 ----------------
    async listGoals() {
      const all = await tx("goals", "readonly", (s) => s.getAll());
      all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      return all;
    },

    async saveGoal(record) {
      const now = Date.now();
      const rec = Object.assign(
        {
          id: newId("g"),
          title: "",
          desc: "",
          unit: "",
          target: 0,
          current: 0,
          endDate: "",
          dailyItems: [],
          milestones: [],
          milestoneDone: [],
          createdAt: now,
          updatedAt: now,
        },
        record
      );
      if (!rec.id) rec.id = newId("g");
      rec.updatedAt = Date.now();
      await tx("goals", "readwrite", (s) => s.put(rec));
      return rec;
    },

    async deleteGoal(id) {
      await tx("goals", "readwrite", (s) => s.delete(id));
    },

    // ---------------- 任务（时间链） ----------------
    async listTasks() {
      const all = await tx("tasks", "readonly", (s) => s.getAll());
      return all;
    },

    async saveTask(record) {
      const now = Date.now();
      const rec = Object.assign(
        {
          id: newId("t"),
          title: "",
          date: "",
          time: "",
          done: false,
          goalId: "",
          createdAt: now,
          updatedAt: now,
        },
        record
      );
      if (!rec.id) rec.id = newId("t");
      rec.updatedAt = Date.now();
      await tx("tasks", "readwrite", (s) => s.put(rec));
      return rec;
    },

    async deleteTask(id) {
      await tx("tasks", "readwrite", (s) => s.delete(id));
    },

    // ---------------- 日记 ----------------
    async listDiary() {
      const all = await tx("diary", "readonly", (s) => s.getAll());
      all.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));
      return all;
    },

    async saveDiary(record) {
      const now = Date.now();
      const rec = Object.assign(
        {
          id: newId("d"),
          date: "",
          mood: "",
          content: "",
          images: [],
          tags: [],
          createdAt: now,
          updatedAt: now,
        },
        record
      );
      if (!rec.id) rec.id = newId("d");
      rec.updatedAt = Date.now();
      await tx("diary", "readwrite", (s) => s.put(rec));
      return rec;
    },

    async deleteDiary(id) {
      await tx("diary", "readwrite", (s) => s.delete(id));
    },

    // ---------------- 图片压缩（写入日记前调用） ----------------
    compressImage(file, maxSize, quality) {
      const max = Number(maxSize) || 900;
      const q = quality === undefined ? 0.72 : Number(quality);
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => {
          const img = new Image();
          img.onload = () => {
            try {
              const scale = Math.min(1, max / Math.max(img.width, img.height));
              const w = Math.max(1, Math.round(img.width * scale));
              const h = Math.max(1, Math.round(img.height * scale));
              const canvas = document.createElement("canvas");
              canvas.width = w;
              canvas.height = h;
              const ctx = canvas.getContext("2d");
              ctx.drawImage(img, 0, 0, w, h);
              resolve(canvas.toDataURL("image/jpeg", q));
            } catch (e) {
              reject(e);
            }
          };
          img.onerror = () => reject(new Error("图片加载失败"));
          img.src = fr.result;
        };
        fr.onerror = () => reject(new Error("文件读取失败"));
        fr.readAsDataURL(file);
      });
    },

    // ---------------- 心情 ----------------
    saveMood(dateStr, mood) {
      localStorage.setItem(LS_MOOD + dateStr, mood || "");
    },

    loadMood(dateStr) {
      return localStorage.getItem(LS_MOOD + dateStr) || "";
    },

    // ---------------- B 站 Cookie ----------------
    saveBiliCookies(cookies) {
      try {
        localStorage.setItem(LS_COOKIES, JSON.stringify(cookies || []));
      } catch (_) {}
    },

    loadBiliCookies() {
      try {
        return JSON.parse(localStorage.getItem(LS_COOKIES) || "[]");
      } catch (_) {
        return [];
      }
    },

    clearBiliCookies() {
      localStorage.removeItem(LS_COOKIES);
    },

    // ---------------- 设置 ----------------
    saveAccessToken(token) {
      try {
        localStorage.setItem(LS_TOKEN, String(token || ""));
      } catch (_) {}
    },

    loadAccessToken() {
      return localStorage.getItem(LS_TOKEN) || "";
    },

    saveApiBase(url) {
      try {
        localStorage.setItem("biliSub_api_base", String(url || ""));
      } catch (_) {}
    },

    loadApiBase() {
      return localStorage.getItem("biliSub_api_base") || "";
    },

    saveAiConfig(cfg) {
      localStorage.setItem(LS_AI, JSON.stringify(cfg || {}));
    },

    loadAiConfig() {
      try {
        return JSON.parse(localStorage.getItem(LS_AI) || "{}");
      } catch (_) {
        return {};
      }
    },

    saveTheme(theme) {
      localStorage.setItem(LS_THEME, theme);
    },

    loadTheme() {
      return localStorage.getItem(LS_THEME) || "light";
    },

    saveFontSize(px) {
      localStorage.setItem(LS_FONT, String(px));
    },

    loadFontSize() {
      return Number(localStorage.getItem(LS_FONT)) || 16;
    },

    saveReaderPos(id, ratio) {
      try {
        localStorage.setItem("biliSub_pos_" + id, String(ratio));
      } catch (_) {}
    },

    loadReaderPos(id) {
      return Number(localStorage.getItem("biliSub_pos_" + id)) || 0;
    },
  };

  // ---------------- v3：个人成长模块 ----------------
  Object.assign(storage, {
    // 心情日志（可一天多次，含情绪/强度/触发因素/备注）
    async listMoodLogs(opts) {
      const all = await tx("mood_logs", "readonly", (s) => s.getAll());
      all.sort(
        (a, b) =>
          (a.date || "").localeCompare(b.date || "") ||
          (a.time || "").localeCompare(b.time || "")
      );
      const from = opts && opts.from;
      const to = opts && opts.to;
      if (from || to) {
        return all.filter(
          (m) => (!from || m.date >= from) && (!to || m.date <= to)
        );
      }
      return all;
    },

    async saveMoodLog(record) {
      const now = Date.now();
      const rec = Object.assign(
        {
          id: newId("m"),
          date: storage.todayStr(),
          time: "12:00",
          mood: "😐",
          label: "一般",
          intensity: 3,
          triggers: [],
          note: "",
          createdAt: now,
          updatedAt: now,
        },
        record
      );
      if (!rec.id) rec.id = newId("m");
      rec.updatedAt = Date.now();
      await tx("mood_logs", "readwrite", (s) => s.put(rec));
      return rec;
    },

    async deleteMoodLog(id) {
      await tx("mood_logs", "readwrite", (s) => s.delete(id));
    },

    async latestMood(dateStr) {
      const list = await storage.listMoodLogs({ from: dateStr, to: dateStr });
      return list.length ? list[list.length - 1] : null;
    },

    // 习惯
    async listHabits() {
      const all = await tx("habits", "readonly", (s) => s.getAll());
      all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      return all;
    },

    async saveHabit(record) {
      const now = Date.now();
      const rec = Object.assign(
        {
          id: newId("h"),
          name: "",
          emoji: "✅",
          frequency: "daily", // daily | weekdays | weekly
          targetPerWeek: 3,
          color: "",
          archived: false,
          createdAt: now,
          updatedAt: now,
        },
        record
      );
      if (!rec.id) rec.id = newId("h");
      rec.updatedAt = Date.now();
      await tx("habits", "readwrite", (s) => s.put(rec));
      return rec;
    },

    async deleteHabit(id) {
      const checks = await storage.listHabitChecks();
      const mine = checks.filter((c) => c.habitId === id).map((c) => c.id);
      await txMany(["habits", "habit_checks"], "readwrite", (stores) => {
        stores.habits.delete(id);
        for (const cid of mine) stores.habit_checks.delete(cid);
      });
    },

    async listHabitChecks(opts) {
      const all = await tx("habit_checks", "readonly", (s) => s.getAll());
      const from = opts && opts.from;
      const to = opts && opts.to;
      if (from || to) {
        return all.filter(
          (c) => (!from || c.date >= from) && (!to || c.date <= to)
        );
      }
      return all;
    },

    async getHabitCheck(habitId, dateStr) {
      return tx("habit_checks", "readonly", (s) => s.get(habitId + "_" + dateStr));
    },

    async toggleHabitCheck(habitId, dateStr) {
      const id = habitId + "_" + dateStr;
      const cur = await storage.getHabitCheck(habitId, dateStr);
      const done = !(cur && cur.done);
      await tx("habit_checks", "readwrite", (s) =>
        s.put({ id, habitId, date: dateStr, done, updatedAt: Date.now() })
      );
      return done;
    },

    async setHabitCheck(habitId, dateStr, done) {
      const id = habitId + "_" + dateStr;
      await tx("habit_checks", "readwrite", (s) =>
        s.put({ id, habitId, date: dateStr, done: !!done, updatedAt: Date.now() })
      );
      return !!done;
    },

    async habitStreak(habitId) {
      const checks = (await storage.listHabitChecks())
        .filter((c) => c.habitId === habitId && c.done)
        .map((c) => c.date)
        .sort();
      const set = new Set(checks);
      let streak = 0;
      const d = new Date();
      if (!set.has(storage.todayStr())) d.setDate(d.getDate() - 1);
      while (set.has(storage.dateStr(d))) {
        streak++;
        d.setDate(d.getDate() - 1);
      }
      return streak;
    },

    async habitStats() {
      const habits = await storage.listHabits();
      const checks = await storage.listHabitChecks();
      const stats = [];
      for (const h of habits) {
        const mine = checks.filter((c) => c.habitId === h.id);
        const doneDates = new Set(mine.filter((c) => c.done).map((c) => c.date));
        stats.push({
          habit: h,
          total: doneDates.size,
          streak: await storage.habitStreak(h.id),
          doneToday: doneDates.has(storage.todayStr()),
        });
      }
      return stats;
    },

    // 生活维度：睡眠 / 运动 / 喝水 / 冥想 / 阅读 / 精力 / 专注
    async listLifeLogs(opts) {
      const all = await tx("life_logs", "readonly", (s) => s.getAll());
      const from = opts && opts.from;
      const to = opts && opts.to;
      const type = opts && opts.type;
      return all.filter(
        (l) =>
          (!from || l.date >= from) &&
          (!to || l.date <= to) &&
          (!type || l.type === type)
      );
    },

    async saveLifeLog(record) {
      const now = Date.now();
      const rec = Object.assign(
        {
          id: newId("l"),
          date: storage.todayStr(),
          type: "exercise",
          amount: 0,
          unit: "分钟",
          note: "",
          createdAt: now,
          updatedAt: now,
        },
        record
      );
      if (!rec.id) rec.id = newId("l");
      rec.updatedAt = Date.now();
      await tx("life_logs", "readwrite", (s) => s.put(rec));
      return rec;
    },

    async deleteLifeLog(id) {
      await tx("life_logs", "readwrite", (s) => s.delete(id));
    },

    async lifeSummary(dateStr) {
      const logs = await storage.listLifeLogs({ from: dateStr, to: dateStr });
      const sum = {
        sleep: null,
        exercise: 0,
        water: 0,
        meditation: 0,
        reading: 0,
        energy: null,
        focus: 0,
      };
      for (const l of logs) {
        const v = Number(l.amount) || 0;
        if (l.type === "sleep") sum.sleep = l.amount;
        else if (l.type === "energy") sum.energy = l.amount;
        else if (sum[l.type] !== undefined) sum[l.type] += v;
      }
      return sum;
    },

    // 专注（番茄钟 / 手动记录）
    async listFocusSessions(opts) {
      const all = await tx("focus", "readonly", (s) => s.getAll());
      const from = opts && opts.from;
      const to = opts && opts.to;
      return all.filter(
        (f) => (!from || f.date >= from) && (!to || f.date <= to)
      );
    },

    async saveFocusSession(record) {
      const now = Date.now();
      const rec = Object.assign(
        {
          id: newId("f"),
          date: storage.todayStr(),
          start: "",
          end: "",
          minutes: 25,
          taskId: "",
          createdAt: now,
          updatedAt: now,
        },
        record
      );
      if (!rec.id) rec.id = newId("f");
      rec.updatedAt = Date.now();
      await tx("focus", "readwrite", (s) => s.put(rec));
      return rec;
    },

    async deleteFocusSession(id) {
      await tx("focus", "readwrite", (s) => s.delete(id));
    },

    async focusTotal(opts) {
      const list = await storage.listFocusSessions(opts);
      return list.reduce((s, f) => s + (Number(f.minutes) || 0), 0);
    },

    // 复盘（晨间 / 晚间 / 周）
    async listReviews(opts) {
      const all = await tx("reviews", "readonly", (s) => s.getAll());
      all.sort(
        (a, b) =>
          (b.date || "").localeCompare(a.date || "") ||
          (b.createdAt || 0) - (a.createdAt || 0)
      );
      const type = opts && opts.type;
      const from = opts && opts.from;
      const to = opts && opts.to;
      return all.filter(
        (r) =>
          (!type || r.type === type) &&
          (!from || r.date >= from) &&
          (!to || r.date <= to)
      );
    },

    async saveReview(record) {
      const now = Date.now();
      const rec = Object.assign(
        {
          id: newId("r"),
          date: storage.todayStr(),
          type: "evening", // morning | evening | weekly
          good: "",
          learn: "",
          plan: "",
          content: "",
          createdAt: now,
          updatedAt: now,
        },
        record
      );
      if (!rec.id) rec.id = newId("r");
      rec.updatedAt = Date.now();
      await tx("reviews", "readwrite", (s) => s.put(rec));
      return rec;
    },

    async deleteReview(id) {
      await tx("reviews", "readwrite", (s) => s.delete(id));
    },

    // ---------------- 记账（轻量） ----------------
    async listFinance(opts) {
      const all = await tx("finance", "readonly", (s) => s.getAll());
      const from = opts && opts.from;
      const to = opts && opts.to;
      return all.filter(
        (f) => (!from || f.date >= from) && (!to || f.date <= to)
      );
    },

    async saveFinance(record) {
      const now = Date.now();
      const rec = Object.assign(
        {
          id: newId("fn"),
          date: storage.todayStr(),
          type: "expense", // expense | income
          category: "其他",
          amount: 0,
          note: "",
          createdAt: now,
          updatedAt: now,
        },
        record
      );
      if (!rec.id) rec.id = newId("fn");
      rec.updatedAt = Date.now();
      await tx("finance", "readwrite", (s) => s.put(rec));
      return rec;
    },

    async deleteFinance(id) {
      await tx("finance", "readwrite", (s) => s.delete(id));
    },

    async financeSummary(monthStr) {
      const month = monthStr || storage.todayStr().slice(0, 7);
      const from = month + "-01";
      const [y, m] = month.split("-").map(Number);
      const next = new Date(y, m, 1);
      const to = storage.dateStr(next);
      const list = await storage.listFinance({ from, to: to === from ? "" : to });
      let income = 0;
      let expense = 0;
      for (const f of list) {
        const v = Number(f.amount) || 0;
        if (f.type === "income") income += v;
        else expense += v;
      }
      return { income, expense, balance: income - expense, count: list.length };
    },

    // ---------------- 技能投入 ----------------
    async listSkills() {
      const all = await tx("skills", "readonly", (s) => s.getAll());
      all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return all;
    },

    async saveSkill(record) {
      const now = Date.now();
      const rec = Object.assign(
        {
          id: newId("sk"),
          date: storage.todayStr(),
          name: "",
          category: "学习",
          hours: 0,
          note: "",
          createdAt: now,
          updatedAt: now,
        },
        record
      );
      if (!rec.id) rec.id = newId("sk");
      rec.updatedAt = Date.now();
      await tx("skills", "readwrite", (s) => s.put(rec));
      return rec;
    },

    async deleteSkill(id) {
      await tx("skills", "readwrite", (s) => s.delete(id));
    },

    // ---------------- 知识卡片（摘抄） ----------------
    async listCards() {
      const all = await tx("cards", "readonly", (s) => s.getAll());
      all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return all;
    },

    async saveCard(record) {
      const now = Date.now();
      const rec = Object.assign(
        {
          id: newId("c"),
          source: "",
          text: "",
          createdAt: now,
          updatedAt: now,
        },
        record
      );
      if (!rec.id) rec.id = newId("c");
      rec.updatedAt = Date.now();
      await tx("cards", "readwrite", (s) => s.put(rec));
      return rec;
    },

    async deleteCard(id) {
      await tx("cards", "readwrite", (s) => s.delete(id));
    },

    // ---------------- 自动化规则 ----------------
    async listAutomations() {
      const all = await tx("automations", "readonly", (s) => s.getAll());
      all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      return all;
    },

    async saveAutomation(record) {
      const now = Date.now();
      const rec = Object.assign(
        {
          id: newId("a"),
          name: "新自动化",
          enabled: true,
          schedule: { type: "daily", time: "09:00", weekdays: [], date: "" },
          task: "news",
          topic: "",
          sources: [],
          style: "reuters",
          styleLevel: 2,
          customStyle: "",
          length: "standard",
          includeSources: true,
          notify: { browser: true, inApp: true },
          retentionDays: 30,
          lastRun: "",
          nextRun: "",
          createdAt: now,
          updatedAt: now,
        },
        record
      );
      if (!rec.id) rec.id = newId("a");
      rec.schedule = Object.assign(
        { type: "daily", time: "09:00", weekdays: [], date: "" },
        record && record.schedule ? record.schedule : {}
      );
      rec.notify = Object.assign(
        { browser: true, inApp: true },
        record && record.notify ? record.notify : {}
      );
      rec.updatedAt = Date.now();
      await tx("automations", "readwrite", (s) => s.put(rec));
      return rec;
    },

    async deleteAutomation(id) {
      await tx("automations", "readwrite", (s) => s.delete(id));
    },

    // ---------------- 自动化生成报告 ----------------
    async listReports(opts) {
      const all = await tx("reports", "readonly", (s) => s.getAll());
      all.sort(
        (a, b) =>
          (b.date || "").localeCompare(a.date || "") ||
          (b.createdAt || 0) - (a.createdAt || 0)
      );
      const from = opts && opts.from;
      const to = opts && opts.to;
      const automationId = opts && opts.automationId;
      return all.filter(
        (r) =>
          (!from || r.date >= from) &&
          (!to || r.date <= to) &&
          (!automationId || r.automationId === automationId)
      );
    },

    async getReport(id) {
      return tx("reports", "readonly", (s) => s.get(id));
    },

    async saveReport(record) {
      const now = Date.now();
      const rec = Object.assign(
        {
          id: newId("rp"),
          automationId: "",
          title: "AI 报告",
          date: storage.todayStr(),
          content: "",
          sources: [],
          style: "reuters",
          status: "ok",
          createdAt: now,
          updatedAt: now,
        },
        record
      );
      if (!rec.id) rec.id = newId("rp");
      rec.updatedAt = Date.now();
      await tx("reports", "readwrite", (s) => s.put(rec));
      return rec;
    },

    async deleteReport(id) {
      await tx("reports", "readwrite", (s) => s.delete(id));
    },

    async pruneReports(retentionDays) {
      const days = Number(retentionDays) || 30;
      const cutoff = storage.offsetDateStr(-days);
      const all = await storage.listReports();
      const stale = all.filter((r) => r.date && r.date < cutoff);
      for (const r of stale) await storage.deleteReport(r.id);
      return stale.length;
    },

    // ---------------- 宽恕卡（防断签） ----------------
    loadForgiveness() {
      try {
        const f = JSON.parse(localStorage.getItem("biliSub_forgiveness") || "{}");
        const now = new Date();
        const month = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
        if (f.month !== month) {
          const fresh = { month, left: 3 };
          localStorage.setItem("biliSub_forgiveness", JSON.stringify(fresh));
          return fresh;
        }
        return { month: f.month, left: Number(f.left) || 0 };
      } catch (_) {
        return { month: "", left: 3 };
      }
    },

    useForgiveness() {
      const f = storage.loadForgiveness();
      if (f.left <= 0) return false;
      f.left--;
      localStorage.setItem("biliSub_forgiveness", JSON.stringify(f));
      return true;
    },

    // ---------------- 徽章 ----------------
    listBadges() {
      try {
        return JSON.parse(localStorage.getItem("biliSub_badges") || "[]");
      } catch (_) {
        return [];
      }
    },

    hasBadge(id) {
      return storage.listBadges().includes(id);
    },

    addBadge(id) {
      if (storage.hasBadge(id)) return false;
      const list = storage.listBadges();
      list.push(id);
      localStorage.setItem("biliSub_badges", JSON.stringify(list));
      return true;
    },

    // ---------------- 全量备份 / 恢复 ----------------
    async exportAll() {
      const [files, goals, tasks, diary, mood_logs, habits, habit_checks, life_logs, focus, reviews, finance, skills, cards, automations, reports] =
        await Promise.all([
          storage.listFiles(),
          storage.listGoals(),
          storage.listTasks(),
          storage.listDiary(),
          storage.listMoodLogs(),
          storage.listHabits(),
          storage.listHabitChecks(),
          storage.listLifeLogs(),
          storage.listFocusSessions(),
          storage.listReviews(),
          storage.listFinance(),
          storage.listSkills(),
          storage.listCards(),
          storage.listAutomations(),
          storage.listReports(),
        ]);
      const ls = {};
      for (const key of [LS_COOKIES, LS_AI, LS_TOKEN, LS_THEME, LS_FONT]) {
        const v = localStorage.getItem(key);
        if (v !== null) ls[key] = v;
      }
      const legacyMoods = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(LS_MOOD)) legacyMoods[k] = localStorage.getItem(k);
      }
      return {
        app: "biliSubWeb",
        version: 3,
        exportedAt: new Date().toISOString(),
        db: {
          files,
          goals,
          tasks,
          diary,
          mood_logs,
          habits,
          habit_checks,
          life_logs,
          focus,
          reviews,
          finance,
          skills,
          cards,
          automations,
          reports,
        },
        ls,
        legacyMoods,
      };
    },

    async importAll(data) {
      if (!data || data.app !== "biliSubWeb") {
        throw new Error("不是 biliSub 的备份文件");
      }
      const dbData = data.db || {};
      const stores = [
        "files",
        "goals",
        "tasks",
        "diary",
        "mood_logs",
        "habits",
        "habit_checks",
        "life_logs",
        "focus",
        "reviews",
        "finance",
        "skills",
        "cards",
        "automations",
        "reports",
      ];
      await txMany(stores, "readwrite", (st) => {
        for (const name of stores) {
          st[name].clear();
          const rows = dbData[name] || [];
          for (const row of rows) st[name].put(row);
        }
      });
      const ls = data.ls || {};
      for (const k of Object.keys(ls)) {
        try {
          localStorage.setItem(k, ls[k]);
        } catch (_) {}
      }
      const legacy = data.legacyMoods || {};
      for (const k of Object.keys(legacy)) {
        try {
          localStorage.setItem(k, legacy[k]);
        } catch (_) {}
      }
    },

    // 首次升级时把旧版 localStorage 心情迁移进 mood_logs
    async migrateLegacyMood() {
      if (localStorage.getItem("biliSub_mood_migrated_v3")) return 0;
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(LS_MOOD)) keys.push(k);
      }
      let n = 0;
      for (const k of keys) {
        const mood = localStorage.getItem(k) || "";
        if (!mood) continue;
        const date = k.slice(LS_MOOD.length);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        await storage.saveMoodLog({
          date,
          time: "12:00",
          mood,
          label: "",
          intensity: 3,
          triggers: ["旧记录"],
          note: "由旧版心情记录迁移",
        });
        n++;
      }
      localStorage.setItem("biliSub_mood_migrated_v3", "1");
      return n;
    },
  });

  // 日期工具（供生活模块使用）
  storage.todayStr = function () {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  };
  storage.dateStr = function (d) {
    const x = d || new Date();
    return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
  };
  storage.offsetDateStr = function (days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return storage.dateStr(d);
  };
  storage.monthStartStr = function () {
    return storage.todayStr().slice(0, 7) + "-01";
  };
  storage.daysUntil = function (dateStr) {
    const target = new Date(dateStr + "T00:00:00");
    const today = new Date(storage.todayStr() + "T00:00:00");
    return Math.ceil((target - today) / 86400000);
  };

  window.storage = storage;
})();
