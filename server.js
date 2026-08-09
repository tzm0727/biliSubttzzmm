// biliSub Web 本地服务
// 服务端基于 Node 原生 http；B 站与 DeepSeek 由本服务代理访问，
// YouTube 字幕使用开源包 get-youtube-transcript（MIT，免 API Key）。
// B 站登录 Cookie 保存在浏览器 localStorage，并在每次请求时同步到本服务。
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8324);
const PUBLIC_DIR = path.join(__dirname, "public");
const CONFIG_PATH = path.join(__dirname, "server-config.json");
const BIND_HOST = process.env.BIND_HOST || "127.0.0.1";
const BILI_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function loadServerConfig() {
  const fromEnv = {};
  if (process.env.DEEPSEEK_API_KEY) {
    fromEnv.deepseekApiKey = process.env.DEEPSEEK_API_KEY;
  }
  if (process.env.ACCESS_TOKEN) {
    fromEnv.accessToken = process.env.ACCESS_TOKEN;
  }
  try {
    const fromFile = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return Object.assign({}, fromFile, fromEnv);
  } catch (_) {
    return fromEnv;
  }
}
const serverConfig = loadServerConfig();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

// ---------------------------------------------------------------------------
// B 站 Cookie 罐（内存）
// ---------------------------------------------------------------------------
const jar = new Map();
const activeAIRequests = new Map();

function parseSetCookie(str) {
  const parts = String(str || "").split(";");
  const first = (parts.shift() || "").trim();
  const eq = first.indexOf("=");
  const name = eq > 0 ? first.slice(0, eq).trim() : "";
  const value = eq >= 0 ? first.slice(eq + 1).trim() : "";
  let domain = "";
  let pathValue = "/";
  let expires = null;
  let secure = false;
  for (const p of parts) {
    const seg = p.trim();
    const idx = seg.indexOf("=");
    const key = (idx >= 0 ? seg.slice(0, idx) : seg).trim().toLowerCase();
    const val = idx >= 0 ? seg.slice(idx + 1).trim() : "";
    if (key === "domain") domain = val;
    else if (key === "path") pathValue = val || "/";
    else if (key === "expires") expires = Date.parse(val);
    else if (key === "max-age") expires = Date.now() + Number(val) * 1000;
    else if (key === "secure") secure = true;
  }
  return { name, value, domain, path: pathValue, expires, secure };
}

function mergeSetCookies(requestUrl, setCookieList) {
  const host = new URL(requestUrl).hostname;
  for (const raw of setCookieList || []) {
    const c = parseSetCookie(raw);
    if (!c.name) continue;
    if (!c.domain) c.domain = host;
    if (c.expires && c.expires <= Date.now()) {
      jar.delete(`${c.domain}|${c.path}|${c.name}`);
      continue;
    }
    jar.set(`${c.domain}|${c.path}|${c.name}`, c);
  }
}

function domainMatches(domain, host) {
  const d = domain.startsWith(".") ? domain.slice(1) : domain;
  return host === d || host.endsWith("." + d);
}

function buildCookieHeader(requestUrl) {
  const u = new URL(requestUrl);
  const host = u.hostname;
  const pathName = u.pathname || "/";
  const parts = [];
  for (const c of jar.values()) {
    if (!domainMatches(c.domain, host)) continue;
    if (!pathName.startsWith(c.path)) continue;
    if (c.secure && u.protocol !== "https:") continue;
    parts.push(`${c.name}=${c.value}`);
  }
  return parts.join("; ");
}

function cookiesArray() {
  return Array.from(jar.values()).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    secure: c.secure,
  }));
}

function setCookiesArray(arr) {
  jar.clear();
  for (const c of Array.isArray(arr) ? arr : []) {
    if (c && c.name) {
      jar.set(
        `${c.domain || ""}|${c.path || "/"}|${c.name}`,
        {
          name: c.name,
          value: c.value || "",
          domain: c.domain || "",
          path: c.path || "/",
          expires: c.expires || null,
          secure: !!c.secure,
        }
      );
    }
  }
}

// ---------------------------------------------------------------------------
// B 站 HTTP 请求
// ---------------------------------------------------------------------------
async function biliGet(url, referer = "https://www.bilibili.com") {
  const headers = {
    "User-Agent": BILI_UA,
    Referer: referer,
    Origin: "https://www.bilibili.com",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
  };
  const cookie = buildCookieHeader(url);
  if (cookie) headers.Cookie = cookie;
  const resp = await fetch(url, { headers, redirect: "manual" });
  const setCookies = resp.headers.getSetCookie
    ? resp.headers.getSetCookie()
    : [];
  mergeSetCookies(url, setCookies);
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    /* 非 JSON */
  }
  return { status: resp.status, headers: resp.headers, json, text };
}

async function followWithCookies(url, maxRedirects = 12) {
  let current = url;
  for (let i = 0; i < maxRedirects; i++) {
    const r = await biliGet(current, "https://www.bilibili.com");
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) {
      current = new URL(loc, current).href;
      continue;
    }
    return { status: r.status, finalUrl: current, json: r.json, text: r.text };
  }
  return { status: 0, finalUrl: current, json: null, text: "" };
}

// ---------------------------------------------------------------------------
// WBI 签名
// ---------------------------------------------------------------------------
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];
const FALLBACK_WBI_KEYS = {
  imgKey: "7cd084941338484aae1ad9425b84077c",
  subKey: "4932caff0ff746eab6f01bf08b70ac45",
};

let wbiCache = { keys: null, at: 0 };

async function getWbiKeys() {
  if (wbiCache.keys && Date.now() - wbiCache.at < 12 * 3600 * 1000) {
    return wbiCache.keys;
  }
  let imgKey = FALLBACK_WBI_KEYS.imgKey;
  let subKey = FALLBACK_WBI_KEYS.subKey;
  try {
    const r = await biliGet("https://api.bilibili.com/x/web-interface/nav");
    const img = (r.json && r.json.data && r.json.data.wbi_img) || {};
    if (img.img_url && img.sub_url) {
      imgKey = img.img_url.split("/").pop().split(".")[0];
      subKey = img.sub_url.split("/").pop().split(".")[0];
    }
  } catch (_) {
    /* 使用备用 key */
  }
  const mixinKey = MIXIN_KEY_ENC_TAB.map((i) => (imgKey + subKey)[i])
    .join("")
    .slice(0, 32);
  wbiCache = { keys: { imgKey, subKey, mixinKey }, at: Date.now() };
  return wbiCache.keys;
}

function signedParams(params, mixinKey) {
  const p = Object.assign({}, params, { wts: Math.floor(Date.now() / 1000) });
  const filter = (s) => String(s).replace(/[!'()*]/g, "");
  const query = Object.keys(p)
    .sort()
    .map((k) => `${filter(k)}=${encodeURIComponent(filter(p[k]))}`)
    .join("&");
  const wRid = crypto.createHash("md5").update(query + mixinKey).digest("hex");
  return `${query}&w_rid=${wRid}`;
}

// ---------------------------------------------------------------------------
// YouTube 字幕（开源包 get-youtube-transcript，MIT，免 API Key）
// 该包会自动处理 YouTube 的 PoToken/BotGuard 校验，比手写抓取更稳定
// ---------------------------------------------------------------------------
async function fetchYtTitle(videoId) {
  try {
    const u =
      "https://www.youtube.com/oembed?format=json&url=" +
      encodeURIComponent("https://www.youtube.com/watch?v=" + videoId);
    const resp = await fetch(u, {
      headers: { "User-Agent": BILI_UA, "Accept-Language": "zh-CN,zh;q=0.9" },
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.title) return String(data.title);
    }
  } catch (_) {
    /* 标题获取失败时使用兜底名 */
  }
  return "";
}

async function fetchYoutubeSubtitle(rawUrl) {
  const mod = await import("get-youtube-transcript");
  const videoId = mod.parseVideoId(rawUrl);
  if (!videoId) throw new Error("无法识别的 YouTube 链接");
  // 语言优先级：中文 > 英语 > 其他；人工字幕优先于自动生成字幕
  const result = await mod.getTranscript(rawUrl, {
    languages: [
      "zh",
      "zh-CN",
      "zh-Hans",
      "zh-Hant",
      "en",
      "en-US",
      "en-GB",
      "ja",
      "ko",
    ],
  });
  if (!result || !result.segments || !result.segments.length) {
    throw new Error("该视频没有可用字幕（或无字幕权限）");
  }
  const segments = result.segments
    .map((s) => ({
      start: Number(s.start) || 0,
      end: (Number(s.start) || 0) + (Number(s.duration) || 0),
      content: String(s.text || "").trim(),
      lang: result.language || "",
    }))
    .filter((s) => s.content);
  if (!segments.length) throw new Error("字幕内容为空");
  const title = (await fetchYtTitle(videoId)) || `YouTube-${videoId}`;
  return {
    videoId,
    title,
    lang: result.language || "",
    langName:
      result.kind === "auto-generated" ? "自动生成（机翻）" : "人工字幕",
    segments,
  };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function extractBvid(input) {
  const m = String(input || "").match(/BV[0-9A-Za-z]+/);
  return m ? m[0] : "";
}

function extractPage(input) {
  try {
    const u = new URL(String(input || ""));
    const p = Number(u.searchParams.get("p"));
    return Number.isInteger(p) && p >= 1 ? p : 1;
  } catch (_) {
    const m = String(input || "").match(/[?&]p=(\d+)/);
    if (m) {
      const p = Number(m[1]);
      if (Number.isInteger(p) && p >= 1) return p;
    }
    return 1;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req, limitBytes = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error("JSON 解析失败"));
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// API 路由
// ---------------------------------------------------------------------------
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

  if (req.method === "GET" && url.pathname === "/api/youtube/fetch") {
    const rawUrl = p.get("url") || "";
    if (!rawUrl) return sendJson(res, 400, { error: "缺少 YouTube 链接" });
    try {
      const data = await fetchYoutubeSubtitle(rawUrl);
      return sendJson(res, 200, data);
    } catch (e) {
      let msg = String(e.message || e);
      if (/no captions/i.test(msg)) msg = "该视频没有可用字幕（或无字幕权限）";
      else if (/rate-limiting|rate limit/i.test(msg))
        msg = "YouTube 暂时限制了本服务器访问，请稍后再试";
      else if (/not a valid youtube/i.test(msg))
        msg = "无法识别的 YouTube 链接";
      else if (/video not available/i.test(msg))
        msg = "该视频不可用或已被删除";
      else if (/empty transcript/i.test(msg))
        msg = "字幕内容为空（视频可能受区域或年龄限制）";
      return sendJson(res, 200, {
        error: msg,
        videoId: "",
        title: "",
        lang: "",
        langName: "",
        segments: [],
      });
    }
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

// ---------------------------------------------------------------------------
// 静态文件
// ---------------------------------------------------------------------------
function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (_) {
    pathname = "/";
  }
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("404 Not Found");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(buf);
  });
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname !== "/api/health" && serverConfig.accessToken) {
        const token = String(req.headers["x-access-token"] || "");
        if (token !== serverConfig.accessToken) {
          return sendJson(res, 401, { error: "访问口令错误，请在「设置」页填写正确的访问口令" });
        }
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        return await handleApi(req, res, url, body);
      }
      return await handleApi(req, res, url, {});
    }
    return serveStatic(req, res, url);
  } catch (e) {
    return sendJson(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, BIND_HOST, () => {
  console.log(`biliSub Web 已启动：http://127.0.0.1:${PORT}`);
  console.log("按 Ctrl+C 停止服务。");
});
