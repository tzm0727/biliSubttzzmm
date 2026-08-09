// biliSub Web 本地服务

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
