// 与内置服务通信；B 站登录 Cookie 会随响应自动回存到 localStorage
(function () {
  // 始终使用同源后端（APK 内 WebView 加载 127.0.0.1:8325，相对路径自动连内置服务）
  function baseUrl() {
    return "";
  }
  function u(path) {
    return baseUrl() + path;
  }

  async function handle(resp) {
    let data;
    try {
      data = await resp.json();
    } catch (_) {
      data = {};
    }
    if (resp.status === 401) {
      throw new Error(data.error || "访问口令错误，请在「设置」页填写");
    }
    if (data && Array.isArray(data.cookies)) {
      storage.saveBiliCookies(data.cookies);
    }
    return data;
  }

  function authHeaders() {
    const token = storage.loadAccessToken();
    return token ? { "X-Access-Token": token } : {};
  }

  function qs(params) {
    const s = new URLSearchParams();
    for (const k of Object.keys(params || {})) {
      if (params[k] !== undefined && params[k] !== null) s.set(k, params[k]);
    }
    const str = s.toString();
    return str ? "?" + str : "";
  }

  const api = {
    async get(path, params) {
      const resp = await fetch(u(path) + qs(params), {
        cache: "no-store",
        headers: authHeaders(),
      });
      return handle(resp);
    },

    async post(path, body, signal) {
      const resp = await fetch(u(path), {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
        body: JSON.stringify(body || {}),
        signal: signal || undefined,
      });
      return handle(resp);
    },

    health() {
      return this.get("/api/health");
    },

    sendCookies(cookies) {
      return this.post("/api/session/cookies", { cookies: cookies || [] });
    },

    nav() {
      return this.get("/api/bili/nav");
    },

    qrGenerate() {
      return this.get("/api/bili/qrcode/generate");
    },

    qrPoll(key) {
      return this.get("/api/bili/qrcode/poll", { qrcode_key: key });
    },

    resolve(url) {
      return this.get("/api/bili/resolve", { url });
    },

    view(bvid) {
      return this.get("/api/bili/view", { bvid });
    },

    subtitles(bvid, cid) {
      return this.get("/api/bili/subtitles", { bvid, cid });
    },

    subtitle(url) {
      return this.get("/api/bili/subtitle", { url });
    },

    async articleGenerate(payload, onEvent, signal) {
      const resp = await fetch(u("/api/article/generate"), {
        method: "POST",
        headers: Object.assign(
          { "Content-Type": "application/json" },
          authHeaders()
        ),
        body: JSON.stringify(payload || {}),
        signal: signal || undefined,
      });
      if (!resp.ok) {
        let data = {};
        try {
          data = await resp.json();
        } catch (_) {}
        throw new Error(data.error || "HTTP " + resp.status);
      }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const dispatch = (chunk) => {
        for (const line of String(chunk || "").split("\n")) {
          if (line.startsWith("data: ")) {
            try {
              onEvent(JSON.parse(line.slice(6)));
            } catch (_) {}
          }
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          dispatch(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
        }
      }
      if (buf.trim()) dispatch(buf);
    },

    articleCancel(requestId) {
      return this.post("/api/article/cancel", { requestId });
    },

    aiChat(payload, signal) {
      return this.post("/api/ai/chat", payload, signal);
    },

    cancelAi(requestId) {
      return this.post("/api/ai/cancel", { requestId });
    },

    async exportEpub(title, content) {
      const resp = await fetch(u("/api/export/epub"), {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
        body: JSON.stringify({ title: title || "未命名", content: content || "" }),
      });
      if (!resp.ok) throw new Error("导出失败（HTTP " + resp.status + "）");
      return resp.blob();
    },
  };

  window.api = api;
})();
