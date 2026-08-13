// biliSub Web 阅读器：打开文档、Markdown 渲染、阅读位置记忆
(function () {
  const ui = window.ui;

  async function openReader(id) {
    let f = ui.state.files.find((x) => x.id === id);
    if (!f) f = await storage.getFile(id);
    if (!f) return;
    ui.state.currentFile = f;
    ui.$("reader-name").textContent = f.name;
    const el = ui.$("reader-content");
    try {
      if (String(f.ext).toLowerCase() === "md") {
        el.innerHTML = window.marked
          ? marked.parse(f.content, { breaks: true, gfm: true })
          : "<pre>" + ui.escapeHtml(f.content) + "</pre>";
      } else {
        el.innerHTML = "<pre>" + ui.escapeHtml(f.content) + "</pre>";
      }
    } catch (_) {
      el.innerHTML = "<pre>" + ui.escapeHtml(f.content) + "</pre>";
    }
    const textOnly =
      String(f.ext).toLowerCase() === "md"
        ? f.content.replace(/[#>*`\[\]()!-]/g, "")
        : f.content;
    const charCount = textOnly.replace(/\s/g, "").length;
    ui.$("reader-stats").textContent = charCount.toLocaleString() + " 字";
    ui.switchView("reader");
    requestAnimationFrame(() => {
      const ratio = storage.loadReaderPos(f.id);
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, Math.max(0, ratio * Math.max(max, 0)));
    });
  }

  function saveReaderPos() {
    if (!ui.state.currentFile) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    storage.saveReaderPos(
      ui.state.currentFile.id,
      max > 0 ? window.scrollY / max : 0
    );
  }

  Object.assign(ui, {
    openReader,
    saveReaderPos,
  });
})();
