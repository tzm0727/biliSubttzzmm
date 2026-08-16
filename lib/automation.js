// 自动化调度：规则存储、到期检查、AI 报告生成（零第三方依赖）
const fs = require("fs");
const path = require("path");
const { serverConfig } = require("./config");
const { deepseekChat } = require("./deepseek");
const { collectNews } = require("./news");
const { buildStyleSystem } = require("./style-scale");

const DATA_DIR = path.join(__dirname, "..", "data");
const AUTO_FILE = path.join(DATA_DIR, "automations.json");
const REPORT_FILE = path.join(DATA_DIR, "reports.json");
const MAX_REPORTS = 200;

let rules = [];
let reports = [];
let timer = null;

function ensureData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const f of [AUTO_FILE, REPORT_FILE]) {
    if (!fs.existsSync(f)) fs.writeFileSync(f, "[]", "utf8");
  }
}

function load() {
  ensureData();
  try {
    rules = JSON.parse(fs.readFileSync(AUTO_FILE, "utf8") || "[]");
  } catch (_) {
    rules = [];
  }
  try {
    reports = JSON.parse(fs.readFileSync(REPORT_FILE, "utf8") || "[]");
  } catch (_) {
    reports = [];
  }
}

function persistRules() {
  ensureData();
  fs.writeFileSync(AUTO_FILE, JSON.stringify(rules, null, 2), "utf8");
}

function persistReports() {
  ensureData();
  if (reports.length > MAX_REPORTS) reports = reports.slice(0, MAX_REPORTS);
  fs.writeFileSync(REPORT_FILE, JSON.stringify(reports, null, 2), "utf8");
}

function newId(prefix) {
  return (prefix || "id") + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function dateTimeStr(d) {
  return (
    d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    "T" + pad(d.getHours()) + ":" + pad(d.getMinutes())
  );
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function parseHM(time) {
  const parts = String(time || "09:00").split(":");
  return [Number(parts[0]) || 9, Number(parts[1]) || 0];
}

function dayMatches(day, schedule) {
  const type = schedule.type || "daily";
  if (type === "daily") return true;
  if (type === "weekdays") {
    const wd = day.getDay();
    return wd >= 1 && wd <= 5;
  }
  if (type === "once") {
    return schedule.date === todayStr();
  }
  // weekly：按 weekdays 数组（0=周日）或默认周日
  const wanted = Array.isArray(schedule.weekdays) && schedule.weekdays.length
    ? schedule.weekdays
    : [0];
  return wanted.includes(day.getDay());
}

function computeNextRun(rule, from) {
  const s = rule.schedule || {};
  const start = from ? new Date(from) : new Date();
  const [h, m] = parseHM(s.time);
  if (s.type === "once" && s.date) {
    return s.date + "T" + pad(h) + ":" + pad(m);
  }
  const cursor = new Date(start);
  for (let i = 0; i < 60; i++) {
    const day = new Date(cursor);
    day.setHours(h, m, 0, 0);
    if (day > start && dayMatches(day, s)) return dateTimeStr(day);
    cursor.setDate(cursor.getDate() + 1);
  }
  return dateTimeStr(start);
}

function isDue(rule, now) {
  return !!(rule.enabled && rule.nextRun && rule.nextRun <= dateTimeStr(now));
}

function buildPrompt(rule, sourceText, dataText) {
  const s = rule.schedule || {};
  const lines = [];
  lines.push(
    `请生成一份「${rule.name}」报告。触发时间：${s.type || "daily"} ${s.time || "09:00"}。`
  );
  if (rule.topic) lines.push(`\n【内容要求（用户指定，最高优先级）】\n${rule.topic}`);
  if (rule.task === "news") {
    lines.push(
      sourceText
        ? `\n【今日素材】\n${sourceText}\n\n请从素材中选取最相关的内容，按上述风格要求撰写。只使用素材中的事实，不要编造。`
        : "\n【今日素材】\n（没有抓取到素材，请基于你的知识生成一份通用简报，并明确标注为 AI 综合信息。）"
    );
  }
  if (dataText) lines.push(`\n【个人数据】\n${dataText}`);
  const lenMap = { short: "300-500 字", standard: "600-1000 字", long: "1200-2000 字" };
  lines.push(`\n篇幅：${lenMap[rule.length] || lenMap.standard}`);
  if (rule.includeSources) {
    lines.push("结尾必须附「来源」小节，列出用到的素材标题与链接；没有来源就标注 AI 综合信息。");
  } else {
    lines.push("不需要单独列出来源。");
  }
  lines.push("只输出报告本身，不要解释生成过程。");
  return lines.join("\n");
}

async function runAutomation(rule, opts) {
  opts = opts || {};
  const apiKey = String(opts.apiKey || "").trim() || serverConfig.deepseekApiKey || "";
  if (!apiKey) throw new Error("缺少 DeepSeek API Key");
  let sources = [];
  let sourceText = "";
  if (rule.task === "news") {
    const r = await collectNews(rule);
    sources = r.items;
    sourceText = r.text;
  }
  const system = buildStyleSystem(rule.style, rule.styleLevel, rule.customStyle, rule.task);
  const user = buildPrompt(rule, sourceText, opts.dataText || "");
  const tokens = rule.length === "long" ? 2400 : rule.length === "short" ? 900 : 1600;
  const content = await deepseekChat(apiKey, system, user, {
    model: opts.model || "deepseek-chat",
    maxTokens: tokens,
    temperature: 0.55,
    timeoutMs: 120000,
  });
  return { content, sources };
}

async function executeRule(rule, opts) {
  opts = opts || {};
  const now = new Date();
  try {
    const out = await runAutomation(rule, opts);
    const report = {
      id: newId("rp"),
      automationId: rule.id || "",
      title: rule.name + " · " + todayStr(),
      date: todayStr(),
      content: out.content,
      sources: (out.sources || []).slice(0, 20),
      style: rule.style || "reuters",
      status: "ok",
      createdAt: Date.now(),
    };
    reports.unshift(report);
    persistReports();
    rule.lastRun = dateTimeStr(now);
    rule.nextRun = computeNextRun(rule, now);
    rule.lastError = "";
    persistRules();
    return report;
  } catch (e) {
    const report = {
      id: newId("rp"),
      automationId: rule.id || "",
      title: rule.name + " · 生成失败",
      date: todayStr(),
      content: "## 生成失败\n\n" + String((e && e.message) || e).slice(0, 500),
      sources: [],
      style: rule.style || "reuters",
      status: "error",
      createdAt: Date.now(),
    };
    reports.unshift(report);
    persistReports();
    rule.lastRun = dateTimeStr(now);
    rule.nextRun = computeNextRun(rule, now);
    rule.lastError = String((e && e.message) || e).slice(0, 300);
    persistRules();
    return report;
  }
}

async function tick() {
  const now = new Date();
  for (const rule of rules) {
    if (isDue(rule, now)) {
      await executeRule(rule, {}); // 服务端定时只使用服务端配置的 Key
    }
  }
}

function syncRules(list) {
  rules = Array.isArray(list) ? list : [];
  const now = new Date();
  for (const r of rules) {
    if (!r.nextRun) r.nextRun = computeNextRun(r, now);
  }
  persistRules();
  return rules
    .filter((r) => r.enabled)
    .map((r) => ({ id: r.id, name: r.name, nextRun: r.nextRun }));
}

function start() {
  if (timer) return;
  load();
  tick();
  timer = setInterval(tick, 30000);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  start,
  stop,
  tick,
  syncRules,
  executeRule,
  runAutomation,
  computeNextRun,
  listReportsAPI: () => reports.slice(0, 50),
  clearReports: () => {
    reports = [];
    persistReports();
  },
  status: () => ({
    count: rules.length,
    nextRuns: rules
      .filter((r) => r.enabled)
      .map((r) => ({ id: r.id, name: r.name, nextRun: r.nextRun })),
    reports: reports.length,
  }),
};
