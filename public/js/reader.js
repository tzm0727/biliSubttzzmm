// biliSub Web 阅读器：打开文档、Markdown 渲染、目录（TOC）、阅读位置记忆
(function () {
  const ui = window.ui;

  // 从渲染后的内容提取标题，生成目录
  function buildToc(el) {
    const headers = el.querySelectorAll("h1, h2, h3");
    const list = [];
    headers.forEach((h, i) => {
      if (!h.id) h.id = "sec-" + i;
      list.push({
        id: h.id,
        level: Number(h.tagName.charAt(1)) || 2,
        text: h.textContent.trim(),
      });
    });
    return list;
  }

  function renderToc(list) {
    const tocList = ui.$("toc-list");
    if (!tocList) return;
    tocList.innerHTML = "";
    if (!list.length) {
      tocList.innerHTML = '<div class="empty-hint">本文没有标题</div>';
      return;
    }
    list.forEach((item) => {
      const a = document.createElement("a");
      a.className = "toc-item toc-level-" + item.level;
      a.textContent = item.text;
      a.addEventListener("click", () => {
        const target = document.getElementById(item.id);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        const panel = ui.$("toc-panel");
        if (panel) panel.hidden = true;
      });
      tocList.appendChild(a);
    });
  }

  async function openReader(id) {
    let f = ui.state.files.find((x) => x.id === id);
    if (!f) f = await storage.getFile(id);
    if (!f) return;
    ui.state.currentFile = f;
    ui.$("reader-name").textContent = f.name;
    const el = ui.$("reader-content");
    const isMd = String(f.ext).toLowerCase() === "md";
    try {
      if (isMd) {
        el.innerHTML = window.marked
          ? marked.parse(f.content, { breaks: true, gfm: true })
          : "<pre>" + ui.escapeHtml(f.content) + "</pre>";
      } else {
        el.innerHTML = "<pre>" + ui.escapeHtml(f.content) + "</pre>";
      }
    } catch (_) {
      el.innerHTML = "<pre>" + ui.escapeHtml(f.content) + "</pre>";
    }
    // 生成目录（仅 Markdown 有标题）
    renderToc(isMd ? buildToc(el) : []);
    const textOnly = isMd
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

  function bindReader() {
    ui.$("reader-toc").addEventListener("click", () => {
      ui.$("toc-panel").hidden = false;
    });
    ui.$("toc-close").addEventListener("click", () => {
      ui.$("toc-panel").hidden = true;
    });
    bindHighlight();
  }

  // 阅读时选中文字 → 一键存入知识卡片
  function bindHighlight() {
    const content = ui.$("reader-content");
    if (!content) return;
    let btn = document.getElementById("reader-highlight-btn");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "reader-highlight-btn";
      btn.textContent = "存为卡片";
      document.body.appendChild(btn);
    }
    const hide = () => {
      btn.style.display = "none";
    };
    const show = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return hide();
      const text = sel.toString().trim();
      if (text.length < 8) return hide();
      if (!content.contains(sel.anchorNode) && !content.contains(sel.focusNode)) return hide();
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect || !rect.width) return hide();
      btn.style.display = "block";
      btn.style.left =
        Math.max(8, Math.min(window.innerWidth - 118, rect.left + rect.width / 2 - 55)) + "px";
      btn.style.top = rect.bottom + 6 + "px";
      btn.onclick = async () => {
        const f = ui.state.currentFile;
        await storage.saveCard({ source: f ? f.name : "阅读摘抄", text });
        ui.showToast("已存入知识卡片");
        hide();
        sel.removeAllRanges();
      };
    };
    document.addEventListener("mouseup", ui.debounce(show, 80));
    document.addEventListener("keyup", ui.debounce(show, 80));
    window.addEventListener("scroll", hide, { passive: true });
  }

  Object.assign(ui, {
    openReader,
    saveReaderPos,
    bindReader,
  });
})();
