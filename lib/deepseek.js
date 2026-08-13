// DeepSeek 对话封装：统一调用 /chat/completions，支持超时与父级取消联动
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

module.exports = { deepseekChat };
