// 议题成文：免费搜索源聚合（维基百科中英 / DuckDuckGo / Bing / SearXNG）
// 目标：返回"真实可达"的来源 URL（含重定向链接解码），杜绝假链接进入引用列表。
const { SEARX_INSTANCES } = require("./constants");
const {
  fetchText,
  stripHtml,
  truncate,
  htmlToArticleText,
  checkAbort,
} = require("./utils");

const articleSearchCache = new Map(); // query -> { at, results }

// ---------------------------------------------------------------------------
// URL 规范化：把搜索引擎的重定向/追踪链接还原为真实目标 URL
// ---------------------------------------------------------------------------
function b64urlDecode(s) {
  try {
    const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    return Buffer.from(b64 + pad, "base64").toString("utf-8");
  } catch (_) {
    return "";
  }
}

function normalizeUrl(raw) {
  let href = String(raw || "").trim();
  if (!href) return "";
  try {
    const u = new URL(href.startsWith("//") ? "https:" + href : href);

    // DuckDuckGo 重定向：/l/?uddg=<url-encoded>
    const uddg = u.searchParams.get("uddg");
    if (uddg && u.hostname.includes("duckduckgo.com")) {
      try {
        return decodeURIComponent(uddg);
      } catch (_) {
        return uddg;
      }
    }

    // Bing 重定向：/ck/a?...&u=a1<base64url>
    if (u.hostname.includes("bing.com") && /\/ck\/a|redirect/i.test(u.pathname)) {
      const uParam = u.searchParams.get("u");
      if (uParam && /^a1/.test(uParam)) {
        const decoded = b64urlDecode(uParam.slice(2));
        if (/^https?:/i.test(decoded)) return decoded;
      }
    }

    // 清理常见追踪参数
    const tracking = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "spm"];
    for (const t of tracking) u.searchParams.delete(t);
    return u.href;
  } catch (_) {
    return "";
  }
}

// ---------------------------------------------------------------------------
// 维基百科（中文 + 英文）——最稳定可靠的主力源，URL 为构造的真实条目链接
// ---------------------------------------------------------------------------
async function searchWikipedia(q, lang, signal) {
  const base = `https://${lang}.wikipedia.org/w/api.php`;
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
    const title = String(it.title || "").trim();
    if (!title) continue;
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
      title: `${lang === "zh" ? "维基百科" : "Wikipedia"}：${title}`,
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      snippet: truncate(extract, 700),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// DuckDuckGo（HTML 版，解析重定向链接）
// ---------------------------------------------------------------------------
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
    const href = normalizeUrl(links[i].href);
    if (!/^https?:/i.test(href)) continue;
    out.push({
      title: links[i].title || href,
      url: href,
      snippet: truncate(snips[i] || "", 700),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bing（正则放宽，解码 ck/a 重定向）
// ---------------------------------------------------------------------------
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
  // 兼容多种结果块结构：优先 b_algo，退回 <li class="b_algo">
  const blockRe = /<li class="b_algo"[\s\S]*?<\/li>/g;
  let m;
  while ((m = blockRe.exec(html)) && out.length < 6) {
    const block = m[0];
    const a = block.match(/<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/i);
    if (!a) continue;
    const url = normalizeUrl(a[1]);
    const title = stripHtml(a[2]).trim();
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = p ? stripHtml(p[1]).trim() : "";
    if (/^https?:/i.test(url)) {
      out.push({ title: title || url, url, snippet: truncate(snippet, 700) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// SearXNG（JSON 优先，HTML 兜底）
// ---------------------------------------------------------------------------
async function searchSearx(q, signal) {
  for (const inst of SEARX_INSTANCES.slice(0, 2)) {
    // JSON 接口
    const r = await fetchText(
      `${inst}/search?q=${encodeURIComponent(q)}&format=json&language=zh-CN`,
      10000,
      300000,
      signal
    );
    if (r.ok) {
      try {
        const j = JSON.parse(r.body);
        const results = (j.results || []).slice(0, 5);
        if (results.length) {
          return results
            .map((it) => ({
              title: String(it.title || ""),
              url: normalizeUrl(it.url),
              snippet: truncate(String(it.content || ""), 700),
            }))
            .filter((x) => /^https?:/i.test(x.url));
        }
      } catch (_) {
        /* 回落到 HTML 解析 */
      }
    }
    // HTML 接口兜底
    const hr = await fetchText(
      `${inst}/search?q=${encodeURIComponent(q)}&language=zh-CN`,
      10000,
      300000,
      signal
    );
    if (hr.ok) {
      const out = [];
      const artRe = /<article class="result"[^>]*>([\s\S]*?)<\/article>/g;
      let m;
      while ((m = artRe.exec(hr.body)) && out.length < 5) {
        const block = m[1];
        const a = block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        if (a) {
          const url = normalizeUrl(a[1]);
          if (/^https?:/i.test(url)) {
            out.push({
              title: stripHtml(a[2]).trim(),
              url,
              snippet: truncate(p ? stripHtml(p[1]).trim() : "", 700),
            });
          }
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

// ---------------------------------------------------------------------------
// 单查询聚合：中文维基 + 英文维基 + DuckDuckGo + Bing + SearXNG
// ---------------------------------------------------------------------------
async function searchQuery(q, signal) {
  checkAbort(signal);
  const hit = articleSearchCache.get(q);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.results;
  const results = await Promise.allSettled([
    searchWikipedia(q, "zh", signal),
    searchWikipedia(q, "en", signal),
    searchDuckDuckGo(q, signal),
    searchBing(q, signal),
    searchSearx(q, signal),
  ]);
  const merged = results.flatMap((r) =>
    r.status === "fulfilled" ? r.value : []
  );
  const clean = dedupeSources(merged);
  if (clean.length) {
    articleSearchCache.set(q, { at: Date.now(), results: clean });
    if (articleSearchCache.size > 300) articleSearchCache.clear();
  }
  return clean;
}

// ---------------------------------------------------------------------------
// 章节级搜索：多查询合并、去重、抓正文
// ---------------------------------------------------------------------------
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
  const qs = queries.slice(0, 3);
  const merged = [];
  for (const q of qs) {
    merged.push(...(await searchQuery(q, signal)));
    if (merged.length >= 12) break;
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
        i < 4 &&
        !/youtube\.com|youtu\.be|bilibili\.com|\.pdf$/i.test(src.url) &&
        !/wikipedia\.org/i.test(host);
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

module.exports = {
  searchQuery,
  searchSection,
  dedupeSources,
  normalizeUrl,
  articleSearchCache,
};
