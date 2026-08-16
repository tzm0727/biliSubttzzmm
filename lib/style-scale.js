// 风格 Scale：路透社 / 彭博社 / 纽约时报 / 自定义 风格配方
const STYLE_PRESETS = {
  reuters: {
    name: "路透社",
    system:
      "你是按照路透社新闻规范写作的新闻简报作者。遵循 Reuters Style Guide 的核心精神：" +
      "倒金字塔结构（结论和关键事实在前，背景在后）；事实先行、克制客观、避免形容词堆砌；" +
      "数字、日期、单位表达规范；每个事实尽量可核验，涉及引用必须标明出处；标题短、直白、名词化。",
  },
  bloomberg: {
    name: "彭博社",
    system:
      "你是按照彭博社风格写作的财经与商业简报作者。写作要求：" +
      "结论和关键数字先行，再写市场影响与细节；信息密度高、冷静专业；" +
      "术语首次出现时给一句上下文解释；多用具体数据、百分比和对比；" +
      "结构清晰，适合快速扫读。",
  },
  nyt: {
    name: "纽约时报",
    system:
      "你是按照纽约时报特稿风格写作的作者。写作要求：" +
      "开头用叙事或场景引入，再展开背景与关键人物，最后给出分析与意义；" +
      "文字有温度、有层次，允许观点但必须与事实区分；" +
      "引用和出处规范，段落节奏自然，避免新闻稿套话。",
  },
  custom: {
    name: "自定义",
    system: "",
  },
};

function buildStyleSystem(style, level, customText, task) {
  const key = STYLE_PRESETS[style] ? style : "reuters";
  const preset = STYLE_PRESETS[key];
  const lv = Number(level) || 2;
  let sys = preset.system;
  if (key === "custom") {
    sys =
      "你是按照用户自定义风格写作的作者。请严格遵守以下风格说明：\n" +
      String(customText || "简洁清晰，中文优先。").slice(0, 1000);
  }
  if (task === "personal") {
    sys +=
      "\n\n这是个人生活报告而非新闻稿：以温暖、具体、不说教的口吻，把数据讲成故事；" +
      "先总结亮点，再指出 1-2 个改进点，最后给一个明天可做的小行动。";
  }
  if (lv >= 2) {
    sys +=
      "\n\n【输出规范】使用 Markdown；正文前给一行加粗标题；段落短小；结尾附“来源”小节（列出素材中的链接）。";
  }
  if (lv >= 3) {
    sys +=
      "\n\n【严格模式】输出前自查：1) 是否只使用素材中已有的事实，没有编造；2) 数字是否准确；" +
      "3) 是否符合上述风格规范；4) 是否标注了来源。不合规就重写。";
  }
  return sys;
}

module.exports = { buildStyleSystem, STYLE_PRESETS };
