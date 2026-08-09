// 与本地服务通信；B 站登录 Cookie 会随响应自动回存到 localStorage
(function () {
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
      const resp = await fetch(path + qs(params), {
        cache: "no-store",
        headers: authHeaders(),
      });
      return handle(resp);
    },

    async post(path, body, signal) {
      const resp = await fetch(path, {
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

    youtubeFetch(url) {
      return this.get("/api/youtube/fetch", { url });
    },

    aiChat(payload, signal) {
      return this.post("/api/ai/chat", payload, signal);
    },

    cancelAi(requestId) {
      return this.post("/api/ai/cancel", { requestId });
    },
  };

  window.api = api;
})();
