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
      let user;
      if (i === 0) {
        user = `以下是字幕文本的第 1/${total} 块，请按上述规则精修，只输出该块精修后的正文：\n\n${chunk}`;
      } else {
        const prevTail = results[results.length - 1].slice(-800);
        user =
          `这是字幕文本的第 ${i + 1}/${total} 块，请按上述规则继续精修。\n` +
          "下面是上一块精修后的结尾，只用于保持语气和分段风格一致：\n" +
          `${prevTail}\n\n` +
          "注意：不要重复上一块已经输出的内容，从上一块结束的地方自然继续；只输出本块精修后的正文：\n\n" +
          chunk;
      }
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

    const ONE_PASS_LIMIT = 30000; // 字幕 3 万字以内：一次请求直接输出整篇
    const TAIL_LEN = 2500; // 续写时带给模型的前文结尾长度
    const parts = [];

    const baseRules =
      "请根据下方【完整字幕】写一篇面向完全没有专业背景读者的科普文章。\n" +
      "要求：通俗、有吸引力、不缩减内容，保留全部主要观点、数据、案例和原话；" +
      "专业术语和人名首次出现时用括号给出大白话解释（如 离域能（delocalization energy））。\n" +
      "【内容来源（最高优先级）】所有内容必须严格来自字幕，禁止编造、补充或改写字幕中没有的事实、数据、案例和观点。\n" +
      "不要出现“前半部分/后半部分/上半部分/下半部分/未完待续”等字样；不要输出 QA 自检报告。\n";

    const endingRules =
      "文章结尾请自然收束，并在末尾附上两小节：\n" +
      "## 核心记忆点\n（1-2 句读者读后能复述的要点）\n" +
      "## 信源\n（原视频：标题，来源链接或视频ID）\n";

    if (text.length <= ONE_PASS_LIMIT) {
      onLog("[AI] 字幕较短，直接按完整字幕一次生成整篇文章…");
      const user =
        baseRules +
        "请输出一篇结构完整的文章：标题 + 导读 + 正文（章节标题由你根据内容拟定）。\n" +
        endingRules +
        "只输出文章本身，不要解释处理过程。\n\n--- 完整字幕 ---\n" +
        text;
      const out = await chat(settings, sys, user, 8000, 0.8, opts);
      parts.push(out);
      onProgress(100);
    } else {
      // 长字幕：第一段输出标题+导读+开头，后续每段都拿到【完整字幕+前文结尾】，
      // 只要求继续写“还没写过”的内容，从根上避免重复和遗漏
      const totalPasses = Math.max(
        2,
        Math.min(6, Math.ceil(text.length / ONE_PASS_LIMIT))
      );
      onLog(
        `[AI] 字幕较长（${text.length} 字），将分 ${totalPasses} 段连续生成，保证全文衔接、不重复、不遗漏…`
      );
      let prevTail = "";
      for (let i = 0; i < totalPasses; i++) {
        if (opts.signal && opts.signal.aborted) {
          const err = new Error("已取消");
          err.name = "AbortError";
          throw err;
        }
        onLog(`[AI] 正在生成第 ${i + 1}/${totalPasses} 段…`);
        let user;
        if (i === 0) {
          user =
            baseRules +
            "现在输出文章开头：标题 + 导读 + 正文开头（从字幕开头讲起）。\n" +
            "只输出文章本身，结尾自然收住，为后续内容留自然衔接。\n\n--- 完整字幕 ---\n" +
            text;
        } else if (i === totalPasses - 1) {
          user =
            baseRules +
            "继续写同一篇文章（不要重新介绍人物/背景）。\n" +
            "【衔接要求】下面是前文结尾，只用于保持语气和章节连贯，请紧接它的叙事顺序" +
            "继续写字幕中尚未覆盖的内容；绝不重复任何已经写过的内容、句子或观点。\n" +
            "如果某部分内容前面已经写过就跳过，宁可省略也不重复；字幕中尚未覆盖的重要内容必须补上，宁多勿漏。\n" +
            "这是最后一段：请写完全部剩余重要内容，并自然收尾。\n" +
            endingRules +
            "只输出文章本身，不要解释处理过程。\n\n--- 前文结尾（仅作衔接参考） ---\n" +
            (prevTail || "（无）") +
            "\n\n--- 完整字幕 ---\n" +
            text;
        } else {
          user =
            baseRules +
            "继续写同一篇文章（不要重新介绍人物/背景）。\n" +
            "【衔接要求】下面是前文结尾，只用于保持语气和章节连贯，请紧接它的叙事顺序" +
            "继续写字幕中尚未覆盖的内容；绝不重复任何已经写过的内容、句子或观点。\n" +
            "如果某部分内容前面已经写过就跳过，宁可省略也不重复；字幕中尚未覆盖的重要内容必须补上，宁多勿漏。\n" +
            "这是中间一段：结尾自然收住，继续为下一段留衔接。\n" +
            "只输出文章本身，不要解释处理过程。\n\n--- 前文结尾（仅作衔接参考） ---\n" +
            (prevTail || "（无）") +
            "\n\n--- 完整字幕 ---\n" +
            text;
        }
        const out = await chat(settings, sys, user, 8000, 0.8, opts);
        parts.push(out);
        prevTail = out.slice(-TAIL_LEN);
        onProgress(Math.round(((i + 1) / totalPasses) * 95));
      }
    }

    const stem = baseName(file.name);
    onProgress(100);
    return {
      name: `${stem}-大众科普版.md`,
      content: parts.join("\n\n") + "\n",
    };
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
