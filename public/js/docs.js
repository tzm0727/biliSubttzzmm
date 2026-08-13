// biliSub Web 文档管理：列表、搜索、导入、导出、重命名、删除
(function () {
  const ui = window.ui;

  async function refreshDocs() {
    ui.state.files = await storage.listFiles();
    const q = ui.$("doc-search").value.trim().toLowerCase();
    const list = q
      ? ui.state.files.filter((f) => f.name.toLowerCase().includes(q))
      : ui.state.files;
    const el = ui.$("doc-list");
    if (!list.length) {
      el.innerHTML =
        '<div class="doc-empty">还没有文档。去「下载」页粘贴链接，或点击「导入文件」添加本地字幕。</div>';
      return;
    }
    el.innerHTML = "";
    for (const f of list) {
      const item = document.createElement("div");
      item.className = "doc-item";

      const icon = document.createElement("div");
      const ext = String(f.ext || "other").toLowerCase();
      icon.className = "doc-icon " + (["txt", "srt", "ass", "vtt", "json", "lrc", "md"].includes(ext) ? ext : "other");
      icon.textContent = ext.slice(0, 4).toUpperCase();

      const main = document.createElement("div");
      main.className = "doc-main";
      const name = document.createElement("div");
      name.className = "doc-name";
      name.textContent = f.name;
      name.title = "点击阅读";
      name.addEventListener("click", (e) => {
        e.stopPropagation();
        ui.openReader(f.id);
      });
      const meta = document.createElement("div");
      meta.className = "doc-meta";
      meta.textContent =
        ui.formatBytes(f.size || 0) +
        " · " +
        new Date(f.updatedAt || Date.now()).toLocaleString() +
        (f.lang ? " · " + f.lang : "");
      main.append(name, meta);

      const expand = document.createElement("div");
      expand.className = "doc-expand";
      expand.hidden = true;
      if (f.meta && f.meta.from) {
        const src = document.createElement("div");
        src.className = "doc-source";
        src.textContent = "来源：" + f.meta.from;
        expand.appendChild(src);
      }
      const actions = document.createElement("div");
      actions.className = "doc-actions";
      actions.append(
        actionBtn("阅读", () => ui.openReader(f.id)),
        actionBtn("润色", () => ui.startAi("polish", f), !["txt", "srt", "vtt"].includes(ext)),
        actionBtn("生成文章", () => ui.startAi("article", f), !["txt", "srt", "vtt"].includes(ext)),
        actionBtn("导出", () => ui.exportFile(f)),
        actionBtn("重命名", () => ui.renameFile(f)),
        actionBtn("删除", () => ui.deleteFile(f))
      );
      expand.appendChild(actions);

      item.addEventListener("click", (e) => {
        if (e.target.closest(".doc-actions") || e.target.closest(".doc-name")) {
          return;
        }
        const show = expand.hidden;
        expand.hidden = !show;
        item.classList.toggle("expanded", show);
      });

      item.append(icon, main, expand);
      el.appendChild(item);
    }
  }

  function actionBtn(label, fn, disabled) {
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = label;
    b.disabled = !!disabled;
    b.addEventListener("click", fn);
    return b;
  }

  async function exportFile(f) {
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
        if (e && e.name === "AbortError") return; // 用户取消分享
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

  Object.assign(ui, {
    refreshDocs,
    actionBtn,
    exportFile,
    renameFile,
    deleteFile,
    readFileText,
    importFiles,
  });
})();
