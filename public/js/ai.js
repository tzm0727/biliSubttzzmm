// DeepSeek 字幕润色（transcript-polisher）与科普文章（science-writing）
(function () {
  async function fetchSkill(rel) {
    const resp = await fetch("skills/" + rel, { cache: "no-store" });
    if (!resp.ok) throw new Error("技能文件缺失：" + rel);
    return resp.text();
  }

  async function buildPolishSystem() {
    const parts = [await fetchSkill("transcript-polisher/SKILL.md")];
    try {
      const errors = await fetchSkill(
        "transcript-polisher/references/common-errors.md"
      );
      if (errors.trim()) parts.push("\n\n--- 高频错误参考 ---\n" + errors);
    } catch (_) {}
    const text = parts.join("\n\n");
    if (!text.trim()) throw new Error("transcript-polisher 技能文件缺失");
    return text;
  }

  async function buildArticleSystem() {
    const parts = [await fetchSkill("science-writing/SKILL.md")];
    for (const ref of ["rhetoric-discipline.md", "writing-guidelines.md"]) {
      try {
        const text = await fetchSkill("science-writing/references/" + ref);
        if (text.trim()) parts.push("\n\n--- 参考文件 ---\n" + text);
      } catch (_) {}
    }
    const text = parts.join("\n\n");
    if (!text.trim()) throw new Error("science-writing 技能文件缺失");
    return text;
  }

  function isCancelled(e) {
    return !!(
      e &&
      (e.name === "AbortError" || /取消|aborted/i.test(String(e.message || "")))
    );
  }

  function detectLanguage(text) {
    const s = String(text || "");
    const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    const nonSpace = s.replace(/\s/g, "").length;
    return nonSpace > 0 && cjk / nonSpace > 0.15 ? "zh" : "other";
  }

  function languageRequirement(file, text) {
    const lang =
      (file && (file.lang || (file.meta && file.meta.lang))) || "";
    const isZh = lang
      ? String(lang).toLowerCase().startsWith("zh")
      : detectLanguage(text) === "zh";
    if (isZh) return { isZh, note: "" };
    return {
      isZh,
      note:
        "\n\n【语言要求】检测到源字幕不是中文：最终输出必须全部使用简体中文。\n" +
        "原文中的专有名词、人名、机构名首次出现时保留原文并附中文译名/解释；不得输出大段原文语言正文。",
    };
  }

  async function chat(settings, system, user, maxTokens, temperature, opts) {
    opts = opts || {};
    if (opts.signal && opts.signal.aborted) {
      const err = new Error("已取消");
      err.name = "AbortError";
      throw err;
    }
    const payload = {
      apiKey: settings.apiKey,
      model: settings.model,
      system,
      user,
      maxTokens,
      temperature,
    };
    if (opts.requestId) payload.requestId = opts.requestId;
    const data = await api.aiChat(payload, opts.signal);
    if (data.error) {
      const err = new Error("DeepSeek：" + data.error);
      if (/取消/.test(data.error)) err.name = "AbortError";
      throw err;
    }
    if (!data.content) throw new Error("DeepSeek 返回内容为空");
    return data.content;
  }

  function splitTextForPolish(text, size) {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const chunks = [];
    let cur = [];
    let curLen = 0;
    for (const ln of lines) {
      cur.push(ln);
      curLen += ln.length + 1;
      if (curLen >= size) {
        chunks.push(cur.join("\n"));
        cur = [];
        curLen = 0;
      }
    }
    if (cur.length) chunks.push(cur.join("\n"));
    return chunks.length ? chunks : [String(text || "")];
  }

  function stripDigestPrefix(digest) {
    let d = String(digest || "").trim();
    for (const prefix of ["## 导读", "# 导读", "导读："]) {
      if (d.startsWith(prefix)) {
        d = d.slice(prefix.length).trim();
        break;
      }
    }
    return d;
  }

  function baseName(name) {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
  }

  async function runPolish(file, settings, onLog, onProgress, opts) {
    const system = await buildPolishSystem();
    const langInfo = languageRequirement(file, file.content);
    if (!langInfo.isZh) onLog("[AI] 检测到非中文字幕，输出将统一为简体中文。");
    const fullSystem =
      system +
      "\n\n注意：只输出精修后的正文，不要解释处理过程，不要输出标题。" +
      langInfo.note;
    const size = Number(settings.chunkSize) || 4500;
    const chunks = splitTextForPolish(file.content, size);
    const results = [];
    const total = chunks.length;

    for (let i = 0; i < total; i++) {
      const chunk = chunks[i];
      onLog(`[AI] 润色分块 ${i + 1}/${total}（${chunk.length} 字）…`);
      const user = `以下是字幕文本的第 ${i + 1}/${total} 块，请按上述规则精修，只输出该块精修后的正文：\n\n${chunk}`;
      const out = await chat(settings, fullSystem, user, 8000, 0.7, opts);
      results.push(out);
      onProgress(((i + 1) / total) * 90);
    }

    const body = results.join("\n\n");
    onLog("[AI] 正在生成导读…");
    const digestUser =
      `以下是精修正文的开头部分（全文很长），请用 1 段话写“导读”，概括核心思想：\n\n` +
      body.slice(0, 6000);
    let digest = await chat(settings, system, digestUser, 800, 0.7, opts);
    digest = stripDigestPrefix(digest);

    const stem = baseName(file.name);
    const content =
      `## 视频信息\n标题：${stem}\n来源：biliSub 导出的字幕文件\n\n` +
      `## 导读\n${digest}\n\n## 正文\n\n${body}\n`;
    onProgress(100);
    return { name: `${stem}-润色版.md`, content };
  }

  async function runArticle(file, settings, onLog, onProgress, opts) {
    const system = await buildArticleSystem();
    const text = file.content;
    const langInfo = languageRequirement(file, text);
    if (!langInfo.isZh) onLog("[AI] 检测到非中文字幕，文章将统一为简体中文。");
    const sys = system + langInfo.note;

    onLog("[AI] 正在生成文章前半部分（标题 + 导读 + 主体前半）…");
    const part1User =
      "请根据下面完整的访谈字幕，写一篇面向完全没有 AI 背景读者的科普文章。\n" +
      "要求：通俗、有吸引力、保留访谈全部主要观点和原文数据；专业术语第一次出现时用括号给大白话解释；不要缩减内容。\n" +
      "【内容来源（最高优先级）】：所有内容必须严格来自下方字幕，禁止编造、补充或改写字幕中没有的事实、数据、案例和观点。\n" +
      "现在只输出【前半部分】：标题 + 导读 + 主体前半部分（章节标题由你根据内容拟定）。\n" +
      "只输出这部分正文，不要输出名词注释表、核心记忆点或 QA 报告。\n" +
      "结尾处请自然推进到尚未展开的内容，为后半部分留好衔接，但不要写“未完待续”之类的字样。\n\n" +
      "--- 字幕内容 ---\n" +
      text;
    const part1 = await chat(settings, sys, part1User, 8000, 0.8, opts);
    onProgress(45);

    onLog("[AI] 正在生成文章后半部分（后半主体 + 名词注释 + 记忆点等）…");
    const part1Tail = part1.slice(-1200);
    const part2User =
      "请继续写同一篇科普文章的【后半部分】：主体后半部分（继续你拟定的章节）、" +
      "名词注释表（用表格）、核心记忆点、信源与延伸阅读、QA 自检报告。\n" +
      "【衔接要求】：下面是前半部分的结尾，仅用于保持语言风格和章节体系一致，请从这里自然衔接；\n" +
      "不要重新介绍人物和背景，不要重复前半部分已写过的内容，不要出现“上半部分/下半部分/前文提到”等字样。\n" +
      "【内容来源（最高优先级）】：后半部分的一切内容必须严格来自下方【字幕内容（完整）】，\n" +
      "只允许写字幕中真实存在的观点、数据、案例和原话；禁止编造、补充或改写字幕中没有的事实；\n" +
      "前半部分结尾只作行文衔接，不是创作素材。\n" +
      "主体后半部分要覆盖字幕中尚未写到的全部重要观点，宁多勿漏，避免内容断档。\n" +
      "名词注释表用表格；QA 自检报告按 science-writing 的 19 项模板简写。\n\n" +
      "--- 前半部分结尾 ---\n" +
      part1Tail +
      "\n\n--- 字幕内容（完整） ---\n" +
      text;
    const part2 = await chat(settings, sys, part2User, 8000, 0.8, opts);
    onProgress(95);

    const stem = baseName(file.name);
    onProgress(100);
    return { name: `${stem}-大众科普版.md`, content: `${part1}\n\n${part2}\n` };
  }

  async function shortFileName(title, settings, opts) {
    const user =
      "把下面的视频标题精简为一个不超过 7 个汉字的中文文件名：\n" +
      "要求：只输出文件名本身，不要扩展名、不要引号、不要解释、不要标点符号；\n" +
      "如果标题含英文缩写（如 AI、K2），可保留；总长度不超过 7 个汉字（英文算半个）。\n\n" +
      "标题：" +
      title;
    const out = await chat(
      settings,
      "你是文件名精简助手，只输出精简后的文件名。",
      user,
      30,
      0,
      opts
    );
    return (
      out
        .replace(/[\\/*?:"<>|.\s]+/g, "")
        .replace(/[，。！？、；：]/g, "")
        .slice(0, 7) || ""
    );
  }

  function fallbackShortName(title) {
    return (
      String(title || "")
        .replace(/[\\/*?:"<>|.\s，。！？、；：]+/g, "")
        .slice(0, 7) || "biliSub"
    );
  }

  window.ai = {
    buildPolishSystem,
    buildArticleSystem,
    splitTextForPolish,
    runPolish,
    runArticle,
    shortFileName,
    fallbackShortName,
    isCancelled,
  };
})();
