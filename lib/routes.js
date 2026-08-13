// API 路由：健康检查、会话 Cookie、B 站代理、议题成文（SSE）、DeepSeek 对话
const { serverConfig } = require("./config");
const { PORT } = require("./constants");
const { jar, cookiesArray, setCookiesArray } = require("./cookie-jar");
const {
  biliGet,
  followWithCookies,
  getWbiKeys,
  signedParams,
} = require("./bili-client");
const { generateArticleStream } = require("./article-engine");
const { deepseekChat } = require("./deepseek");
const { sendJson, extractBvid, extractPage } = require("./utils");

const activeAIRequests = new Map();

async function handleApi(req, res, url, body) {
  const p = url.searchParams;

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      port: PORT,
      hasCookies: jar.size > 0,
      hasAiKey: !!serverConfig.deepseekApiKey,
      needsToken: !!serverConfig.accessToken,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/session/cookies") {
    setCookiesArray(body.cookies || []);
    return sendJson(res, 200, { ok: true, count: jar.size });
  }

  if (req.method === "GET" && url.pathname === "/api/bili/nav") {
    const r = await biliGet("https://api.bilibili.com/x/web-interface/nav");
    return sendJson(res, 200, {
      json: r.json,
      cookies: cookiesArray(),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/bili/qrcode/generate") {
    const r = await biliGet(
      "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
    );
    return sendJson(res, 200, {
      code: r.json && r.json.code,
      message: r.json && r.json.message,
      data: r.json && r.json.data,
      cookies: cookiesArray(),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/bili/qrcode/poll") {
    const key = p.get("qrcode_key") || "";
    if (!key) return sendJson(res, 400, { error: "缺少 qrcode_key" });
    const r = await biliGet(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(
        key
      )}&source=main-fe-header`
    );
    const result = r.json || {};
    if (result.code === 0 && result.data && result.data.code === 0 && result.data.url) {
      await followWithCookies(result.data.url);
    }
    return sendJson(res, 200, { result, cookies: cookiesArray() });
  }

  if (req.method === "GET" && url.pathname === "/api/bili/resolve") {
    const raw = p.get("url") || "";
    let bvid = extractBvid(raw);
    let finalUrl = raw;
    if (!bvid && /^https?:\/\//i.test(raw)) {
      const r = await followWithCookies(raw);
      finalUrl = r.finalUrl;
      bvid = extractBvid(finalUrl);
    }
    if (!bvid) {
      return sendJson(res, 200, { error: "无法从链接中提取 BV 号", bvid: "" });
    }
    return sendJson(res, 200, {
      bvid,
      page: extractPage(raw),
      url: finalUrl,
      cookies: cookiesArray(),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/bili/view") {
    const bvid = p.get("bvid") || "";
    if (!bvid) return sendJson(res, 400, { error: "缺少 bvid" });
    const r = await biliGet(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`
    );
    return sendJson(res, 200, { json: r.json, cookies: cookiesArray() });
  }

  if (req.method === "GET" && url.pathname === "/api/bili/subtitles") {
    const bvid = p.get("bvid") || "";
    const cid = p.get("cid") || "";
    if (!bvid || !cid) return sendJson(res, 400, { error: "缺少 bvid 或 cid" });
    const keys = await getWbiKeys();
    const query = signedParams({ bvid, cid }, keys.mixinKey);
    const r = await biliGet(`https://api.bilibili.com/x/player/wbi/v2?${query}`);
    return sendJson(res, 200, { json: r.json, cookies: cookiesArray() });
  }

  if (req.method === "GET" && url.pathname === "/api/bili/subtitle") {
    let subUrl = p.get("url") || "";
    if (!subUrl) return sendJson(res, 400, { error: "缺少字幕 URL" });
    if (!/^https?:/i.test(subUrl)) subUrl = "https:" + subUrl;
    const r = await biliGet(subUrl, "https://www.bilibili.com/video/");
    return sendJson(res, 200, { json: r.json, cookies: cookiesArray() });
  }

  if (req.method === "POST" && url.pathname === "/api/article/generate") {
    const apiKey =
      String(body.apiKey || "").trim() || serverConfig.deepseekApiKey || "";
    const topic = String(body.topic || "").trim();
    if (!apiKey) return sendJson(res, 400, { error: "缺少 DeepSeek API Key" });
    if (!topic) return sendJson(res, 400, { error: "请输入议题" });
    if (topic.length > 200) {
      return sendJson(res, 400, { error: "议题太长了（最多 200 字）" });
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const sendEvent = (obj) => {
      try {
        res.write("data: " + JSON.stringify(obj) + "\n\n");
      } catch (_) {}
    };
    const requestId = String(body.requestId || "");
    const controller = new AbortController();
    if (requestId) activeAIRequests.set(requestId, controller);
    const timer = setTimeout(() => controller.abort(), 30 * 60 * 1000);
    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch (_) {}
    }, 20000);
    req.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      await generateArticleStream(
        {
          apiKey,
          topic,
          extra: String(body.extra || "").trim(),
          targetChars: Number(body.targetChars) || 6000,
          style: String(body.style || "通俗"),
        },
        sendEvent,
        controller.signal
      );
    } catch (e) {
      if (controller.signal.aborted || (e && e.name === "AbortError")) {
        sendEvent({ type: "cancelled", message: "已取消" });
      } else {
        sendEvent({
          type: "error",
          message: String((e && e.message) || e).slice(0, 500),
        });
      }
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (requestId) activeAIRequests.delete(requestId);
      try {
        res.end();
      } catch (_) {}
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/article/cancel") {
    const requestId = String(body.requestId || "");
    const controller = activeAIRequests.get(requestId);
    if (controller) controller.abort();
    return sendJson(res, 200, { ok: true, cancelled: !!controller });
  }

  if (req.method === "POST" && url.pathname === "/api/ai/chat") {
    const apiKey = String(body.apiKey || "").trim() || serverConfig.deepseekApiKey || "";
    const user = String(body.user || "");
    if (!apiKey) return sendJson(res, 400, { error: "缺少 DeepSeek API Key" });
    if (!user) return sendJson(res, 400, { error: "缺少对话内容" });
    const requestId = String(body.requestId || "");
    const controller = new AbortController();
    if (requestId) activeAIRequests.set(requestId, controller);
    const timer = setTimeout(() => controller.abort(), 600 * 1000);
    try {
      const resp = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: body.model || "deepseek-chat",
          messages: [
            { role: "system", content: String(body.system || "") },
            { role: "user", content: user },
          ],
          max_tokens: Number(body.maxTokens) || 8000,
          temperature: body.temperature === undefined ? 0.7 : Number(body.temperature),
          stream: false,
        }),
        signal: controller.signal,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg =
          (data.error && data.error.message) ||
          JSON.stringify(data).slice(0, 300) ||
          `HTTP ${resp.status}`;
        return sendJson(res, resp.status, { error: msg });
      }
      const content = (data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : ""
      ).trim();
      return sendJson(res, 200, { content });
    } catch (e) {
      if (e.name === "AbortError") {
        return sendJson(res, 499, { error: "请求已取消" });
      }
      return sendJson(res, 502, {
        error: e.name === "AbortError" ? "请求超时（10 分钟）" : String(e.message || e),
      });
    } finally {
      clearTimeout(timer);
      if (requestId) activeAIRequests.delete(requestId);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/ai/cancel") {
    const requestId = String(body.requestId || "");
    const controller = activeAIRequests.get(requestId);
    if (controller) controller.abort();
    return sendJson(res, 200, { ok: true, cancelled: !!controller });
  }

  return sendJson(res, 404, { error: "接口不存在" });
}

module.exports = { handleApi, activeAIRequests };
