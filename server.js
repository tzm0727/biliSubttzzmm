// biliSub Web 本地服务
// 服务端基于 Node 原生 http；B 站与 DeepSeek 由本服务代理访问，
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
// 议题成文引擎：规划 → 免费搜索 → 分章写作 → 合并（SSE 进度）
// ---------------------------------------------------------------------------
const ARTICLE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SEARX_INSTANCES = [
  "https://searx.be",
  "https://search.inetol.net",
  "https://searx.tiekoetter.com",
  "https://opnxng.com",
  "https://search.bus-hit.me",
];
const articleSearchCache = new Map(); // query -> { at, results }

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

async function deepseekChat(apiKey, system, user, opts) {
  opts = opts || {};
  const maxTokens = Number(opts.maxTokens) || 4000;
  const temperature = opts.temperature === undefined ? 0.7 : Number(opts.temperature);
  const timeoutMs = Number(opts.timeoutMs) || 180000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onParentAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", onParentAbort);
  }
  try {
    const resp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model || "deepseek-chat",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
        temperature,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg =
        (data.error && data.error.message) ||
        JSON.stringify(data).slice(0, 300) ||
        `HTTP ${resp.status}`;
      throw new Error(`DeepSeek：${msg}`);
    }
    const content = (
      (data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : "") || ""
    ).trim();
    if (!content) throw new Error("DeepSeek 返回内容为空");
    return content;
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onParentAbort);
  }
}

function checkAbort(signal) {
  if (signal && signal.aborted) {
    const err = new Error("已取消");
    err.name = "AbortError";
    throw err;
  }
}

async function searchWikipedia(q, signal) {
  const base = "https://zh.wikipedia.org/w/api.php";
  const searchUrl =
    `${base}?action=query&list=search&srsearch=${encodeURIComponent(q)}` +
    `&format=json&utf8=1&srlimit=5`;
  const r = await fetchText(searchUrl, 12000, 200000, signal);
  if (!r.ok) return [];
  let data = null;
  try {
    data = JSON.parse(r.body);
  } catch (_) {
    return [];
  }
  const items = ((data.query && data.query.search) || []).slice(0, 3);
  const out = [];
  for (const it of items) {
    const title = String(it.title || "");
    const snippet = stripHtml(it.snippet || "").trim();
    const extractUrl =
      `${base}?action=query&prop=extracts&explaintext=1&exchars=1200` +
      `&titles=${encodeURIComponent(title)}&format=json&utf8=1`;
    const er = await fetchText(extractUrl, 12000, 200000, signal);
    let extract = snippet;
    try {
      const ej = JSON.parse(er.body);
      const pages = (ej.query && ej.query.pages) || {};
      const page = Object.values(pages)[0];
      if (page && page.extract) extract = String(page.extract).slice(0, 1200);
    } catch (_) {}
    out.push({
      title: `维基百科：${title}`,
      url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      snippet: truncate(extract, 700),
    });
  }
  return out;
}

async function searchDuckDuckGo(q, signal) {
  const r = await fetchText(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    12000,
    300000,
    signal
  );
  if (!r.ok) return [];
  const html = r.body;
  const out = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const links = [];
  let m;
  while ((m = linkRe.exec(html)) && links.length < 6) {
    links.push({ href: m[1], title: stripHtml(m[2]).trim() });
  }
  const snips = [];
  while ((m = snipRe.exec(html)) && snips.length < 6) {
    snips.push(stripHtml(m[1]).trim());
  }
  for (let i = 0; i < links.length; i++) {
    let href = links[i].href;
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try {
        href = decodeURIComponent(uddg[1]);
      } catch (_) {}
    } else if (href.startsWith("//")) {
      href = "https:" + href;
    }
    if (!/^https?:/i.test(href)) continue;
    out.push({
      title: links[i].title || href,
      url: href,
      snippet: truncate(snips[i] || "", 700),
    });
  }
  return out;
}

async function searchBing(q, signal) {
  const r = await fetchText(
    `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-hans&cc=cn`,
    12000,
    400000,
    signal
  );
  if (!r.ok) return [];
  const html = r.body;
  const out = [];
  const blockRe = /<li class="b_algo"[\s\S]*?<\/li>/g;
  let m;
  while ((m = blockRe.exec(html)) && out.length < 6) {
    const block = m[0];
    const a = block.match(/<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/i);
    if (!a) continue;
    const url = a[1];
    const title = stripHtml(a[2]).trim();
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = p ? stripHtml(p[1]).trim() : "";
    if (/^https?:/i.test(url)) {
      out.push({ title: title || url, url, snippet: truncate(snippet, 700) });
    }
  }
  return out;
}

async function searchSearx(q, signal) {
  for (const inst of SEARX_INSTANCES.slice(0, 2)) {
    const r = await fetchText(
      `${inst}/search?q=${encodeURIComponent(q)}&format=json&language=zh-CN`,
      10000,
      300000,
      signal
    );
    if (!r.ok) continue;
    try {
      const j = JSON.parse(r.body);
      const results = (j.results || []).slice(0, 5);
      if (results.length) {
        return results.map((it) => ({
          title: String(it.title || ""),
          url: String(it.url || ""),
          snippet: truncate(String(it.content || ""), 700),
        }));
      }
    } catch (_) {
      /* 尝试 HTML 解析 */
      const out = [];
      const artRe = /<article class="result"[^>]*>([\s\S]*?)<\/article>/g;
      let m;
      while ((m = artRe.exec(r.body)) && out.length < 5) {
        const block = m[1];
        const a = block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        if (a && /^https?:/i.test(a[1])) {
          out.push({
            title: stripHtml(a[2]).trim(),
            url: a[1],
            snippet: truncate(p ? stripHtml(p[1]).trim() : "", 700),
          });
        }
      }
      if (out.length) return out;
    }
  }
  return [];
}

function dedupeSources(list) {
  const seen = new Set();
  const out = [];
  for (const s of list || []) {
    if (!s || !s.url) continue;
    let key = "";
    try {
      const u = new URL(s.url);
      key = u.hostname + u.pathname;
    } catch (_) {
      key = String(s.url);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

async function searchQuery(q, signal) {
  checkAbort(signal);
  const hit = articleSearchCache.get(q);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.results;
  const results = await Promise.allSettled([
    searchWikipedia(q, signal),
    searchDuckDuckGo(q, signal),
    searchBing(q, signal),
    searchSearx(q, signal),
  ]);
  const merged = results.flatMap((r) =>
    r.status === "fulfilled" ? r.value : []
  );
  if (merged.length) {
    articleSearchCache.set(q, { at: Date.now(), results: merged });
    if (articleSearchCache.size > 300) articleSearchCache.clear();
  }
  return merged;
}

async function searchSection(keywords, questions, sectionTitle, signal) {
  const queries = [];
  for (const q of questions || []) {
    if (q && !queries.includes(q)) queries.push(q);
  }
  for (const k of keywords || []) {
    if (k && !queries.includes(k)) queries.push(k);
  }
  if (sectionTitle && !queries.includes(sectionTitle)) {
    queries.push(sectionTitle);
  }
  const qs = queries.slice(0, 2);
  const merged = [];
  for (const q of qs) {
    merged.push(...(await searchQuery(q, signal)));
    if (merged.length >= 10) break;
  }
  const uniq = dedupeSources(merged).slice(0, 6);
  const notes = [];
  const fetchJobs = [];
  for (let i = 0; i < uniq.length; i++) {
    checkAbort(signal);
    const src = uniq[i];
    let eligible = false;
    try {
      const host = new URL(src.url).hostname;
      eligible =
        i < 3 &&
        !/youtube\.com|youtu\.be|bilibili\.com|\.pdf$/i.test(src.url) &&
        !/zh\.wikipedia\.org/i.test(host);
    } catch (_) {}
    if (eligible) {
      fetchJobs.push({ i, p: fetchText(src.url, 12000, 300000, signal) });
    }
  }
  const settled = await Promise.allSettled(fetchJobs.map((j) => j.p));
  for (let k = 0; k < fetchJobs.length; k++) {
    const j = fetchJobs[k];
    const r = settled[k];
    const src = uniq[j.i];
    const body =
      r.status === "fulfilled" && r.value && r.value.ok
        ? htmlToArticleText(r.value.body, 6000)
        : src.snippet || "";
    notes[j.i] = { title: src.title, url: src.url, body: truncate(body, 1200) };
  }
  for (let i = 0; i < uniq.length; i++) {
    if (!notes[i]) {
      notes[i] = {
        title: uniq[i].title,
        url: uniq[i].url,
        body: truncate(uniq[i].snippet || "", 1200),
      };
    }
  }
  return notes;
}

function extractOutline(raw) {
  let text = String(raw || "").trim();
  const f = text.indexOf("{");
  const l = text.lastIndexOf("}");
  if (f >= 0 && l > f) {
    try {
      const obj = JSON.parse(text.slice(f, l + 1));
      if (obj && Array.isArray(obj.sections) && obj.sections.length) {
        const sections = obj.sections
          .filter((s) => s && s.title)
          .map((s) => ({
            title: String(s.title).trim(),
            questions: Array.isArray(s.questions)
              ? s.questions
                  .map((x) => String(x).trim())
                  .filter(Boolean)
                  .slice(0, 3)
              : [],
            keywords: Array.isArray(s.keywords)
              ? s.keywords
                  .map((k) => String(k).trim())
                  .filter(Boolean)
                  .slice(0, 5)
              : [],
          }));
        if (sections.length) {
          return {
            title: String(obj.title || "未命名").trim(),
            summary: String(obj.summary || "").trim(),
            perspectives: Array.isArray(obj.perspectives)
              ? obj.perspectives
                  .map((p) => String(p).trim())
                  .filter(Boolean)
                  .slice(0, 4)
              : [],
            sections,
          };
        }
      }
    } catch (_) {}
  }
  // 兜底：按行解析
  const sections = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:\d+[.、)]\s*)?(.{2,40})$/);
    if (m && !/^(title|summary|sections|perspectives|questions|keywords|议题|要求)/i.test(m[1])) {
      sections.push({ title: m[1].trim(), questions: [], keywords: [] });
    }
  }
  return {
    title: sections[0] ? sections[0].title : "未命名",
    summary: "",
    perspectives: [],
    sections: sections.slice(0, 8),
  };
}

async function planArticle(apiKey, topic, extra, targetChars, signal) {
  const system =
    "你是一位资深中文主编，擅长把复杂议题规划成结构清晰、视角多元的长文。只输出 JSON，不要输出任何解释。";
  const user =
    `议题：${topic}\n补充要求：${extra || "无"}\n目标篇幅：约 ${targetChars} 字。\n\n` +
    "请输出规划 JSON，格式严格如下：\n" +
    '{"title":"文章标题（不超过 20 字）","summary":"一句话摘要（30 字内）","perspectives":["视角1","视角2","视角3"],"sections":[{"title":"章节标题（不超过 15 字）","questions":["该章必须回答的研究问题1","研究问题2"],"keywords":["3-5 个搜索关键词"]}]}\n' +
    "要求：\n" +
    "1. 章节数量：标准篇幅 6-8 章，每章约 700-1000 字；\n" +
    "2. perspectives 给出 2-3 个不同立场或背景的视角（例如：产业分析师、技术专家、普通用户、政策研究者、一线从业者），后续写作要兼顾这些视角；\n" +
    "3. 章节覆盖：背景/现状、核心概念、关键案例、争议或问题、趋势/展望等维度；\n" +
    "4. 每章写 2 个具体的研究问题（该章必须回答），keywords 要具体，便于搜索引擎找到高质量资料；\n" +
    "5. 只输出 JSON 本身。";
  const raw = await deepseekChat(apiKey, system, user, {
    maxTokens: 2400,
    temperature: 0.5,
    signal,
    timeoutMs: 120000,
  });
  const outline = extractOutline(raw);
  if (!outline.sections.length) {
    outline.sections = [
      {
        title: "背景与现状",
        questions: [`当前${topic}的整体情况如何？`, `有哪些关键背景需要了解？`],
        keywords: [topic, "现状"],
      },
      {
        title: "核心概念与原理",
        questions: [`${topic}的核心概念是什么？`, `底层原理如何理解？`],
        keywords: [topic, "原理"],
      },
      {
        title: "典型案例",
        questions: [`${topic}有哪些代表性案例？`, `案例说明了什么？`],
        keywords: [topic, "案例"],
      },
      {
        title: "争议与问题",
        questions: [`${topic}存在哪些争议或挑战？`, `不同观点各有什么依据？`],
        keywords: [topic, "争议"],
      },
      {
        title: "未来趋势",
        questions: [`${topic}的未来走向如何？`, `有哪些值得关注的趋势？`],
        keywords: [topic, "趋势"],
      },
    ];
  }
  outline.sections = outline.sections.slice(0, 8);
  return outline;
}

async function writeSection(apiKey, topic, outline, index, notes, prevTail, targetChars, style, signal) {
  const sec = outline.sections[index];
  const sectionTarget = Math.max(500, Math.round(targetChars / outline.sections.length));
  const styleRule =
    style === "专业"
      ? "面向有一定基础的读者，用词准确专业，可保留术语，逻辑严密。"
      : "面向普通大众，通俗易懂、有画面感；专业术语首次出现时用括号给出大白话解释。";
  const system =
    "你是一位中文写作专家。你借鉴了维基百科长文（STORM）与深度研究系统（GPT Researcher）的写作规范：\n" +
    "1. 只依据下方编号资料写作，绝不编造数据、引文或事实；\n" +
    "2. 行文要有信息量、不空洞，语句流畅自然，避免 AI 腔和套话；\n" +
    "3. 重要事实或数据在句末用 [n] 标注资料编号；\n" +
    "4. 逐条回答本章研究问题，做到有问必答。\n" +
    styleRule;
  const outlineText = outline.sections
    .map((s, i) => `${i + 1}. ${s.title}`)
    .join("\n");
  const notesText = notes.length
    ? notes
        .map(
          (n) =>
            `[${n.no}]《${n.title}》(${n.url})\n${truncate(n.body, 800)}`
        )
        .join("\n\n")
    : "（在线资料较少，请基于你自己的知识谨慎撰写，并在该章结尾注明“本章公开资料有限，以上基于模型知识整理”。）";
  const questionsText =
    sec.questions && sec.questions.length
      ? sec.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")
      : "（无明确研究问题，请围绕章节主题展开。）";
  const perspectivesText =
    outline.perspectives && outline.perspectives.length
      ? outline.perspectives.join("；")
      : "兼顾多方视角";
  const user =
    `议题：${topic}\n文章标题：${outline.title}\n写作视角：${perspectivesText}\n全文各章：\n${outlineText}\n\n` +
    `现在是第 ${index + 1}/${outline.sections.length} 章「${sec.title}」。\n\n` +
    `本章必须回答的研究问题：\n${questionsText}\n\n` +
    `本章可用编号资料：\n${notesText}\n\n` +
    `上一章结尾（仅用于衔接语气，不要重复内容）：\n${prevTail || "（第一章，无上文）"}\n\n` +
    `写作要求：\n` +
    `1. 本章正文约 ${sectionTarget} 字；\n` +
    `2. 以 "## ${sec.title}" 开头；\n` +
    `3. 与上一章自然衔接，不重复已写内容；\n` +
    `4. 逐条回答研究问题；依据资料写作，重要数据在句末加 [n] 标注；\n` +
    `5. 只输出本章正文，不要输出章节列表、参考文献列表或解释。`;
  return deepseekChat(apiKey, system, user, {
    maxTokens: Math.max(1600, Math.round(sectionTarget * 1.8)),
    temperature: 0.75,
    signal,
    timeoutMs: 240000,
  });
}

async function writeLeadSection(apiKey, topic, outline, draft, sources, style, signal) {
  const system = "你是一位资深中文编辑，负责为长文撰写导语。";
  const draftForLead = truncate(draft, 12000);
  const srcList = (sources || [])
    .slice(0, 25)
    .map((s) => `[${s.no}] ${s.title} — ${s.url}`)
    .join("\n");
  const styleRule =
    style === "专业" ? "语言专业克制。" : "通俗有吸引力，像优质深度报道的开头。";
  const user =
    `议题：${topic}\n文章标题：${outline.title}\n全文各章：${outline.sections
      .map((s) => s.title)
      .join(" / ")}\n\n` +
    `文章草稿：\n${draftForLead}\n\n` +
    `可用引用编号：\n${srcList}\n\n` +
    `写作要求（借鉴维基百科导语规范）：\n` +
    `1. 导语独立成篇：点明议题、交代背景、说明为什么值得关注，并概括最重要观点与主要争议；\n` +
    `2. 不超过 4 段、约 400-600 字；\n` +
    `3. 重要事实用 [n] 标注引用；\n` +
    `4. ${styleRule}\n` +
    `5. 以 "## 导语" 开头，只输出导语本身。`;
  return deepseekChat(apiKey, system, user, {
    maxTokens: 1200,
    temperature: 0.7,
    signal,
    timeoutMs: 180000,
  });
}

async function reviewArticle(apiKey, topic, outline, fullText, targetChars, signal) {
  const system = "你是一位严格的审校编辑，只依据质量规范评价文章并给出修改意见。只输出 JSON。";
  const user =
    `议题：${topic}\n目标篇幅：约 ${targetChars} 字\n全文各章：${outline.sections
      .map((s, i) => `${i + 1}. ${s.title}`)
      .join("\n")}\n\n文章全文：\n${truncate(fullText, 16000)}\n\n` +
    "请按以下规范审校：\n" +
    "1. 是否只依据资料、无明显编造的数据或引文；\n" +
    "2. 各章之间是否重复、衔接是否自然；\n" +
    "3. 每章研究问题是否都被回答；\n" +
    "4. 引用 [n] 是否规范、参考资料是否齐全；\n" +
    "5. 篇幅是否接近目标；结构、语气是否符合设定。\n\n" +
    '只输出 JSON：{"ok":true或false,"issues":[{"section":章节序号1起,"problem":"问题","suggestion":"修改建议"}]}\n' +
    "若无需修改，issues 为空数组且 ok 为 true。";
  const raw = await deepseekChat(apiKey, system, user, {
    maxTokens: 1500,
    temperature: 0.2,
    signal,
    timeoutMs: 180000,
  });
  try {
    const f = raw.indexOf("{");
    const l = raw.lastIndexOf("}");
    return JSON.parse(raw.slice(f, l + 1));
  } catch (_) {
    return { ok: true, issues: [] };
  }
}

async function reviseSection(
  apiKey,
  topic,
  outline,
  index,
  notes,
  oldText,
  feedback,
  targetChars,
  style,
  signal
) {
  const sec = outline.sections[index];
  const notesText = notes.length
    ? notes
        .map(
          (n) =>
            `[${n.no}]《${n.title}》(${n.url})\n${truncate(n.body, 800)}`
        )
        .join("\n\n")
    : "（无）";
  const system =
    "你是一位资深编辑，根据审校意见修改指定章节。只输出修改后的该章正文，保持其它内容不变。";
  const user =
    `议题：${topic}\n文章标题：${outline.title}\n全文章节：${outline.sections
      .map((s) => s.title)
      .join(" / ")}\n\n` +
    `需要修改的章节（第 ${index + 1} 章）：${sec.title}\n\n` +
    `原章节正文：\n${truncate(oldText, 6000)}\n\n` +
    `审校意见：\n${feedback}\n\n` +
    `该章资料：\n${notesText}\n\n` +
    `要求：\n1. 按审校意见重写该章，解决所有问题；\n` +
    `2. 保留与原文一致的内容与编号引用 [n]，不新增编造事实；\n` +
    `3. 仍以 "## ${sec.title}" 开头，只输出该章正文。`;
  return deepseekChat(apiKey, system, user, {
    maxTokens: Math.max(
      1600,
      Math.round((targetChars / Math.max(1, outline.sections.length)) * 1.8)
    ),
    temperature: 0.6,
    signal,
    timeoutMs: 240000,
  });
}

async function runPool(items, limit, fn) {
  let idx = 0;
  const workers = [];
  const next = async () => {
    if (idx >= items.length) return;
    const i = idx++;
    await fn(items[i], i);
    await next();
  };
  for (let k = 0; k < Math.min(limit, items.length); k++) {
    workers.push(next());
  }
  await Promise.all(workers);
}

async function generateArticleStream(opts, sendEvent, signal) {
  const { apiKey, topic, extra } = opts;
  const targetChars = Math.max(2000, Number(opts.targetChars) || 6000);
  const style = opts.style === "专业" ? "专业" : "通俗";

  sendEvent({
    type: "stage",
    stage: "plan",
    message: "正在规划文章大纲与多视角研究问题…",
  });
  const outline = await planArticle(apiKey, topic, extra, targetChars, signal);
  sendEvent({
    type: "outline",
    title: outline.title,
    sections: outline.sections.map((s) => s.title),
  });

  const sectionNotes = [];
  let searched = 0;
  sendEvent({
    type: "progress",
    stage: "search",
    done: 0,
    total: outline.sections.length,
    message: "开始收集资料…",
  });
  await runPool(outline.sections, 2, async (sec, i) => {
    checkAbort(signal);
    sendEvent({
      type: "progress",
      stage: "search",
      done: searched,
      total: outline.sections.length,
      message: `正在搜索资料 ${searched + 1}/${outline.sections.length}：「${sec.title}」`,
    });
    sectionNotes[i] = await searchSection(
      sec.keywords,
      sec.questions,
      sec.title,
      signal
    );
    searched++;
    sendEvent({
      type: "progress",
      stage: "search",
      done: searched,
      total: outline.sections.length,
      message: `资料收集 ${searched}/${outline.sections.length}`,
    });
  });

  const allSources = [];
  let sourceNo = 0;
  for (const notes of sectionNotes) {
    for (const n of notes || []) {
      sourceNo++;
      n.no = sourceNo;
      allSources.push(n);
    }
  }

  const parts = [];
  let prevTail = "";
  for (let i = 0; i < outline.sections.length; i++) {
    checkAbort(signal);
    const sec = outline.sections[i];
    sendEvent({
      type: "progress",
      stage: "write",
      done: i,
      total: outline.sections.length,
      message: `正在写作 ${i + 1}/${outline.sections.length}：「${sec.title}」`,
    });
    const text = await writeSection(
      apiKey,
      topic,
      outline,
      i,
      sectionNotes[i] || [],
      prevTail,
      targetChars,
      style,
      signal
    );
    parts.push(text);
    prevTail = truncate(text, 500);
  }

  checkAbort(signal);
  const bodyNoLead = parts.join("\n\n");
  sendEvent({
    type: "progress",
    stage: "lead",
    done: 0,
    total: 1,
    message: "正在撰写导语…",
  });
  const lead = await writeLeadSection(
    apiKey,
    topic,
    outline,
    bodyNoLead,
    allSources,
    style,
    signal
  );
  let body = `${lead}\n\n${bodyNoLead}`;

  checkAbort(signal);
  sendEvent({
    type: "progress",
    stage: "review",
    done: 0,
    total: 1,
    message: "审校中…",
  });
  const review = await reviewArticle(
    apiKey,
    topic,
    outline,
    body,
    targetChars,
    signal
  );
  const issues = (review && Array.isArray(review.issues) ? review.issues : []).filter(
    (it) =>
      it &&
      Number(it.section) >= 1 &&
      Number(it.section) <= outline.sections.length
  );
  const revised = new Set();
  let revisedCount = 0;
  for (const issue of issues) {
    if (revisedCount >= 2) break;
    const idx = Number(issue.section) - 1;
    if (revised.has(idx)) continue;
    revised.add(idx);
    revisedCount++;
    checkAbort(signal);
    sendEvent({
      type: "progress",
      stage: "revise",
      done: revisedCount,
      total: Math.min(2, issues.length),
      message: `根据审校意见修改第 ${idx + 1} 章…`,
    });
    parts[idx] = await reviseSection(
      apiKey,
      topic,
      outline,
      idx,
      sectionNotes[idx] || [],
      parts[idx],
      `问题：${issue.problem}\n建议：${issue.suggestion}`,
      targetChars,
      style,
      signal
    );
  }
  if (revised.size) {
    body = `${lead}\n\n${parts.join("\n\n")}`;
  }

  checkAbort(signal);
  const charCount = body.replace(/\s/g, "").length;
  let content = `# ${outline.title}\n\n`;
  if (outline.summary) content += `> ${outline.summary}\n\n`;
  content += body + "\n";
  if (allSources.length) {
    content +=
      "\n\n---\n\n## 参考资料\n\n" +
      allSources
        .map((s) => `[${s.no}] ${s.title || s.url} — ${s.url}`)
        .join("\n") +
      "\n";
  }
  content +=
    `\n\n---\n\n*本文由 biliSub「议题成文」融合 STORM 与 GPT Researcher 方法，基于公开网络资料自动生成，正文约 ${charCount} 字。*`;
  sendEvent({
    type: "done",
    title: outline.title,
    content,
    charCount,
    sections: outline.sections.map((s) => s.title),
    sources: allSources.map((s) => ({ title: s.title, url: s.url })),
  });
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
      if (
        url.pathname !== "/api/health" &&
        serverConfig.accessToken
      ) {
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
