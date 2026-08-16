// 数据备份 / 恢复
(function () {
  const ui = window.ui;

  function download(data, name) {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 3000);
  }

  async function exportAll() {
    try {
      const data = await storage.exportAll();
      download(data, "bilisub-backup-" + storage.todayStr() + ".json");
      ui.showToast("备份已导出");
    } catch (e) {
      alert("导出失败：" + ((e && e.message) || e));
    }
  }

  async function importAll(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!confirm("导入将覆盖当前全部数据，确定继续吗？")) return;
      await storage.importAll(data);
      ui.showToast("恢复完成");
      if (ui.renderToday) ui.renderToday();
      if (ui.renderGrowth) ui.renderGrowth();
      if (ui.refreshDocs) ui.refreshDocs();
    } catch (e) {
      alert("导入失败：" + ((e && e.message) || e));
    }
  }

  function bindEvents() {
    ui.$("export-all").addEventListener("click", exportAll);
    ui.$("import-all").addEventListener("click", () =>
      ui.$("import-all-input").click()
    );
    ui.$("import-all-input").addEventListener("change", (e) => {
      importAll(e.target.files && e.target.files[0]);
      e.target.value = "";
    });
  }

  Object.assign(ui, {
    bindBackup: bindEvents,
    exportAllData: exportAll,
  });
})();
