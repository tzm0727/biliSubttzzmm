// 通用工具函数：HTML 解码、文本提取、网络抓取、请求体读取、HTTP 响应、链接解析
const { ARTICLE_UA } = require("./constants");

function decodeHtmlEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => {
      try {
        return String.fromCodePoint(Number(d));
      } catch (_e) {
        return "";
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch (_e) {
        return "";
      }
    });
}

function stripHtml(s) {
  return decodeHtmlEntities(
    String(s || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ");
}

function truncate(s, n) {
  const t = String(s || "").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function htmlToArticleText(html, maxChars) {
  const out = [];
  let cleaned = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|footer|header|aside|form|noscript)[\s\S]*?<\/\1>/gi, " ");
  const titleM = cleaned.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleM) out.push(stripHtml(titleM[1]).trim());
  const blocks = cleaned.match(
    /<(h[1-6]|p|li)[^>]*>([\s\S]*?)<\/\1>/gi
  );
  if (blocks) {
    for (const b of blocks) {
      const text = stripHtml(b).trim();
      if (text && !/^(首页|登录|注册|更多|阅读全文|评论)/.test(text)) {
        out.push(text);
      }
    }
  }
  const joined = out.filter(Boolean).join("\n");
  return truncate(joined, maxChars || 6000);
}

async function fetchText(url, timeoutMs, maxBytes, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  const onParentAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onParentAbort);
  }
  try {
    const resp = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": ARTICLE_UA,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        Accept: "text/html,application/json,application/xhtml+xml,*/*;q=0.8",
      },
    });
    if (!resp.ok) return { ok: false, status: resp.status, body: "" };
    const buf = await resp.arrayBuffer();
    let body = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    if (maxBytes && body.length > maxBytes) body = body.slice(0, maxBytes);
    return { ok: true, status: resp.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: "", err: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onParentAbort);
  }
}

function checkAbort(signal) {
  if (signal && signal.aborted) {
    const err = new Error("已取消");
    err.name = "AbortError";
    throw err;
  }
}

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

module.exports = {
  decodeHtmlEntities,
  stripHtml,
  truncate,
  htmlToArticleText,
  fetchText,
  checkAbort,
  extractBvid,
  extractPage,
  sendJson,
  readBody,
};
