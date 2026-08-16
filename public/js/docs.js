// biliSub Web 文档（书架）：合集书卡片、合集内文件、导入、导出（EPUB）、重命名、删除
(function () {
  const ui = window.ui;

  // 按标题 hash 生成确定性渐变封面
  function coverGradient(title) {
    const palettes = [
      [210, 72], [260, 62], [330, 58], [170, 54], [20, 68], [40, 62], [190, 58], [280, 66],
    ];
    let h = 0;
    for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
    const p = palettes[h % palettes.length];
    const hue2 = (p[0] + 35) % 360;
    return `linear-gradient(160deg, hsl(${p[0]}, ${p[1]}%, 60%), hsl(${hue2}, ${p[1]}%, 42%))`;
  }

  async function refreshDocs() {
    ui.state.files = await storage.listFiles();
    const groups = await storage.listGroups();
    const q = ui.$("doc-search").value.trim().toLowerCase();
    const list = q
      ? groups.filter(
          (g) =>
            g.title.toLowerCase().includes(q) ||
            g.files.some(
              (f) =>
                f.name.toLowerCase().includes(q) ||
                String(f.content || "").toLowerCase().includes(q)
            )
        )
      : groups;
    const el = ui.$("doc-list");
    if (!list.length) {
      el.innerHTML =
        '<div class="doc-empty">书架还是空的。下载字幕、写文章，都会自动整理到这里。</div>';
      return;
    }
    el.innerHTML = "";
    for (const g of list) {
      el.appendChild(renderBookCard(g));
    }
  }

  function renderBookCard(g) {
    const card = document.createElement("div");
    card.className = "book-card";
    const cover = document.createElement("div");
    cover.className = "book-cover";
    cover.style.background = coverGradient(g.title);
    const spine = document.createElement("div");
    spine.className = "book-cover-spine";
    const title = document.createElement("div");
    title.className = "book-cover-title";
    title.textContent = g.title;
    cover.append(spine, title);
    const name = document.createElement("div");
    name.className = "book-name";
    name.textContent = g.title;
    const meta = document.createElement("div");
    meta.className = "book-meta";
    meta.textContent = g.files.length + " 个文件";
    card.append(cover, name, meta);
    card.addEventListener("click", () => openGroup(g));
    return card;
  }

  function openGroup(g) {
    ui.$("group-title").textContent = g.title;
    const list = ui.$("group-files");
    list.innerHTML = "";
    for (const f of g.files) {
      list.appendChild(renderGroupFile(f));
    }
    ui.$("group-modal").hidden = false;
  }

  function renderGroupFile(f) {
    const ext = String(f.ext || "other").toLowerCase();
    const row = document.createElement("div");
    row.className = "group-file";
    const head = document.createElement("div");
    head.className = "group-file-head";
    const icon = document.createElement("span");
    icon.className = "doc-icon " + (["txt", "srt", "ass", "vtt", "json", "lrc", "md"].includes(ext) ? ext : "other");
    icon.textContent = ext.slice(0, 4).toUpperCase();
    const info = document.createElement("div");
    info.className = "group-file-info";
    const name = document.createElement("div");
    name.className = "group-file-name";
    name.textContent = f.name;
    const meta = document.createElement("div");
    meta.className = "group-file-meta";
    meta.textContent =
      ui.formatBytes(f.size || 0) +
      " · " +
      new Date(f.updatedAt || Date.now()).toLocaleDateString();
    info.append(name, meta);
    head.append(icon, info);
    const actions = document.createElement("div");
    actions.className = "group-file-actions";
    actions.append(
      actionBtn("阅读", () => ui.openReader(f.id)),
      actionBtn("润色", () => ui.startAi("polish", f), !["txt", "srt", "vtt"].includes(ext)),
      actionBtn("生成文章", () => ui.startAi("article", f), !["txt", "srt", "vtt"].includes(ext)),
      actionBtn("导出", () => ui.exportFile(f)),
      actionBtn("删除", () => ui.deleteFile(f))
    );
    row.append(head, actions);
    return row;
  }

  function actionBtn(label, fn, disabled) {
    const b = document.createElement("button");
    b.className = "btn small";
    b.textContent = label;
    b.disabled = !!disabled;
    b.addEventListener("click", fn);
    return b;
  }

  async function exportFile(f) {
    // Markdown 文件导出为 EPUB 电子书
    if (String(f.ext).toLowerCase() === "md") {
      try {
        const title =
          (f.meta && (f.meta.title || f.meta.topic)) || f.name.replace(/\.md$/i, "");
        const blob = await api.exportEpub(title, f.content);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = title + ".epub";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(a.href);
        }, 1000);
        ui.showToast("已导出 EPUB：" + title);
      } catch (e) {
        ui.showToast("EPUB 导出失败：" + (e && e.message));
      }
      return;
    }
    const type =
      String(f.ext).toLowerCase() === "md"
        ? "text/markdown;charset=utf-8"
        : "text/plain;charset=utf-8";
    const blob = new Blob([f.content], { type });
    const file = new File([blob], f.name, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ title: f.name, files: [file] });
        ui.showToast("已分享/导出");
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    }, 1000);
    ui.showToast("已导出：" + f.name);
  }

  async function renameFile(f) {
    const name = prompt("新的文件名：", f.name);
    if (!name || name === f.name) return;
    await storage.renameFile(f.id, name);
    await ui.refreshDocs();
  }

  async function deleteFile(f) {
    if (!confirm(`确定删除「${f.name}」吗？删除后无法恢复。`)) return;
    await storage.deleteFile(f.id);
    if (ui.state.currentFile && ui.state.currentFile.id === f.id) {
      ui.state.currentFile = null;
      ui.$("reader-name").textContent = "";
      ui.$("reader-content").innerHTML =
        '<div class="doc-empty">文档已删除。</div>';
    }
    await ui.refreshDocs();
  }

  function readFileText(file) {
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => {
        try {
          const buf = new Uint8Array(fr.result);
          let text = new TextDecoder("utf-8").decode(buf);
          if ((text.match(/\uFFFD/g) || []).length > 2) {
            try {
              text = new TextDecoder("gb18030").decode(buf);
            } catch (_) {}
          }
          resolve(text);
        } catch (_) {
          resolve(null);
        }
      };
      fr.onerror = () => resolve(null);
      fr.readAsArrayBuffer(file);
    });
  }

  async function importFiles(fileList) {
    for (const file of fileList) {
      const text = await readFileText(file);
      if (text === null) continue;
      const dot = file.name.lastIndexOf(".");
      const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "txt";
      await storage.saveFile({ name: file.name, ext, content: text });
    }
    await ui.refreshDocs();
  }

  function bindDocs() {
    ui.$("group-close").addEventListener("click", () => {
      ui.$("group-modal").hidden = true;
    });
  }

  Object.assign(ui, {
    refreshDocs,
    actionBtn,
    exportFile,
    renameFile,
    deleteFile,
    readFileText,
    importFiles,
    bindDocs,
  });
})();
