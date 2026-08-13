// 议题成文引擎：规划 → 免费搜索 → 分章写作 → 导语 → 审校 → 修订（SSE 进度）
const { deepseekChat } = require("./deepseek");
const { searchSection } = require("./search");
const { truncate, checkAbort } = require("./utils");

// 中文 AI 套话黑名单：写作时严禁出现，用于提示模型输出高信息密度内容
const ANTI_FLUFF = [
  "随着", "众所周知", "值得注意的是", "不难看出", "总的来说", "综上所述",
  "在当今社会", "日益", "越来越", "扮演着重要角色", "发挥着重要作用",
  "具有重要意义", "不可或缺", "深入探讨", "赋能", "抓手", "闭环",
  "底层逻辑", "顶层设计", "核心要素", "重中之重", "多维度", "全方位",
  "系统性", "值得一提的是", "可以说", "换言之", "毋庸置疑", "毫无疑问",
  "显而易见", "举足轻重", "欣欣向荣", "蓬勃发展", "如虎添翼", "雨后春笋",
  "一波三折", "任重道远", "意义深远", "影响深远",
];
const ANTI_FLUFF_STR = ANTI_FLUFF.join("、");

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
    "你是一位严谨的中文深度报道作者，写作风格参照财新、三联生活周刊的深度报道：信息密度高、具体、克制、无空话。\n" +
    "写作铁律：\n" +
    "1. 只依据下方【编号资料】写作，资料中没有的事实、数据、人名、机构名、时间一律不得出现；绝不编造任何具体来源、论文或引文。\n" +
    "2. 严禁使用以下套话空话：" + ANTI_FLUFF_STR + "，出现即视为不合格。\n" +
    "3. 每段必须有实质信息：具体数字、真实案例、因果逻辑、时间节点或运行机制；拒绝概括性的正确废话。\n" +
    "4. 重要事实或数据在句末用 [n] 标注资料编号；只允许标注下方真实存在的编号，资料为空时禁止任何 [n] 标注。\n" +
    "5. 逐条回答本章研究问题，有问必答。\n" +
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
    : "（本章未检索到可用的在线资料。）";
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
    `4. 逐条回答研究问题；只依据资料写作，重要数据句末加 [n] 标注；\n` +
    `5. 若本章资料为空：只做常识性介绍，禁止使用 [n] 标注，禁止编造任何具体来源、数据、论文名或机构名；\n` +
    `6. 每段以具体事实、数字或案例开头，避免「随着」「众所周知」「值得注意的是」等套话；\n` +
    `7. 只输出本章正文，不要输出章节列表、参考文献列表或解释。`;
  return deepseekChat(apiKey, system, user, {
    maxTokens: Math.max(1600, Math.round(sectionTarget * 1.8)),
    temperature: 0.75,
    signal,
    timeoutMs: 240000,
  });
}

async function writeLeadSection(apiKey, topic, outline, draft, sources, style, signal) {
  const system =
    "你是一位资深中文编辑，负责为长文撰写导语。导语要像优质深度报道的开头：具体、有钩子、无套话、无空话。";
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
    `可用引用编号：\n${srcList || "（无可用来源）"}\n\n` +
    `写作要求（借鉴维基百科导语规范）：\n` +
    `1. 导语独立成篇：点明议题、交代背景、说明为什么值得关注，并概括最重要观点与主要争议；\n` +
    `2. 不超过 4 段、约 400-600 字；\n` +
    `3. 重要事实用 [n] 标注引用（只允许引用上方真实存在的编号）；\n` +
    `4. 禁止「随着」「众所周知」「值得注意的是」等套话；每段以具体事实或数字开头；\n` +
    `5. ${styleRule}\n` +
    `6. 以 "## 导语" 开头，只输出导语本身。`;
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
    "1. 是否只依据资料、有无编造的数据、来源或引文；\n" +
    "2. 各章之间是否重复、衔接是否自然；\n" +
    "3. 每章研究问题是否都被回答；\n" +
    "4. 引用 [n] 是否规范、编号是否越界、参考资料是否齐全；\n" +
    "5. 篇幅是否接近目标；结构、语气是否符合设定；\n" +
    "6. 是否存在套话空话（如「随着」「众所周知」「值得注意的是」「越来越」等）或空泛的正确废话。\n\n" +
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
    "你是一位资深编辑，根据审校意见修改指定章节。只输出修改后的该章正文，保持其它内容不变。修订时同样避免「随着」「众所周知」等套话，保持高信息密度，绝不编造来源或数据。";
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

  // 引用一致性校验：清理越界/编造的 [n] 标注，确保文中引用编号都对应真实参考资料
  const maxSourceNo = allSources.length;
  if (maxSourceNo > 0) {
    body = body.replace(/\[(\d+)\]/g, (m, n) => {
      const num = Number(n);
      return num >= 1 && num <= maxSourceNo ? m : "";
    });
  } else {
    body = body.replace(/\[\d+\]/g, "");
  }

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

module.exports = {
  extractOutline,
  planArticle,
  writeSection,
  writeLeadSection,
  reviewArticle,
  reviseSection,
  runPool,
  generateArticleStream,
};
