// 文件库（IndexedDB）与本地设置（localStorage）
(function () {
  const DB_NAME = "biliSubWeb";
  const DB_VERSION = 1;
  const LS_COOKIES = "biliSub_cookies";
  const LS_AI = "biliSub_ai";
  const LS_TOKEN = "biliSub_access_token";
  const LS_THEME = "biliSub_theme";
  const LS_FONT = "biliSub_font";

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

  const storage = {
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
        },
        record
      );
      rec.size = (rec.content || "").length;
      rec.updatedAt = Date.now();
      await tx("files", "readwrite", (s) => s.put(rec));
      return rec;
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

    saveAccessToken(token) {
      try {
        localStorage.setItem(LS_TOKEN, String(token || ""));
      } catch (_) {}
    },

    loadAccessToken() {
      return localStorage.getItem(LS_TOKEN) || "";
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

  window.storage = storage;
})();
