// 轻量新闻/内容抓取：RSS/Atom 解析 + 普通网页文本提取（零第三方依赖）
const { fetchText, stripHtml } = require("./utils");

const DEFAULT_FEEDS = [
  { label: "BBC 中文", url: "https://feeds.bbci.co.uk/zhongwen/simp/rss.xml" },
  { label: "纽约时报中文网", url: "https://cn.nytimes.com/rss/" },
  { label: "联合早报", url: "https://www.zaobao.com/rss/news/china" },
  { label: "Hacker News", url: "https://hnrss.org/frontpage" },
];

function decode(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function parseFeed(xml) {
  const items = [];
  const blocks = String(xml || "").match(/<(?:item|entry)[\s\S]*?<\/(?:item|entry)>/gi) || [];
  for (const block of blocks) {
    const title = decode((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
    const link = decode((block.match(/<link[^>]*href="([^"]+)"/i) || block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || "");
    const descRaw =
      (block.match(/<(?:description|summary|content:encoded)[^>]*>([\s\S]*?)<\/(?:description|summary|content:encoded)>/i) || [])[1] || "";
    const snippet = stripHtml(decode(descRaw)).replace(/\s+/g, " ").trim().slice(0, 600);
    if (title) items.push({ title: title.trim(), link: link.trim(), snippet });
  }
  return items;
}

async function fetchSourceItems(source, limit) {
  try {
    const text = await fetchText(source.url, 15000, 2 * 1024 * 1024);
    const items = parseFeed(text);
    if (items.length) return items.slice(0, limit);
    // 普通网页：提取正文片段作为单条
    const plain = stripHtml(text).replace(/\s+/g, " ").trim().slice(0, 3000);
    if (plain) {
      return [{ title: source.label || source.url, link: source.url, snippet: plain }];
    }
  } catch (_) {}
  return [];
}

// 汇总规则配置的来源，输出可给 AI 的素材文本
async function collectNews(rule) {
  const configured = Array.isArray(rule.sources)
    ? rule.sources
        .filter((s) => s && s.url)
        .map((s) => ({ label: s.label || s.url, url: s.url }))
    : [];
  const sources = configured.length ? configured : DEFAULT_FEEDS;
  const perSource = Math.max(1, Math.min(6, Math.floor(12 / sources.length) || 1));
  const items = [];
  for (const s of sources) {
    const list = await fetchSourceItems(s, perSource);
    for (const it of list) items.push(it);
  }
  const text = items
    .map(
      (it, i) =>
        `${i + 1}. ${it.title}${it.link ? "（" + it.link + "）" : ""}\n${it.snippet || ""}`
    )
    .join("\n\n")
    .slice(0, 40000);
  return { items, text };
}

module.exports = { collectNews, parseFeed, DEFAULT_FEEDS };
