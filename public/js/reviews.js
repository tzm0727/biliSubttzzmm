// 复盘：晨间规划 / 晚间复盘 / 周复盘
(function () {
  const ui = window.ui;
  const TYPE_LABEL = { morning: "晨间", evening: "晚间", weekly: "周复盘" };
  let reviewType = "evening";

  function renderTypeSeg() {
    const seg = ui.$("review-type-seg");
    if (!seg) return;
    seg.querySelectorAll(".seg-mini-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.type === reviewType);
    });
  }

  async function renderReviewList() {
    const el = ui.$("review-list");
    if (!el) return;
    const list = await storage.listReviews();
    if (!list.length) {
      el.innerHTML = '<div class="empty-hint">写一篇复盘，记录每天的收获</div>';
      return;
    }
    el.innerHTML = "";
    for (const r of list.slice(0, 10)) {
      const item = document.createElement("div");
      item.className = "review-item";
      const head = document.createElement("div");
      head.className = "review-item-head";
      const left = document.createElement("span");
      left.className = "review-item-left";
      left.innerHTML =
        `<span class="review-type">${TYPE_LABEL[r.type] || r.type}</span>` +
        `<span class="review-date">${r.date}</span>`;
      const del = document.createElement("button");
      del.className = "diary-item-del";
      del.textContent = "删除";
      del.addEventListener("click", async () => {
        if (!confirm("删除这条复盘？")) return;
        await storage.deleteReview(r.id);
        await renderReviewList();
      });
      head.append(left, del);
      item.appendChild(head);
      for (const [k, label] of [
        ["good", "三件好事"],
        ["learn", "收获与反思"],
        ["plan", "明日计划"],
      ]) {
        if (r[k]) {
          const p = document.createElement("p");
          p.className = "review-line";
          p.innerHTML =
            `<b>${label}：</b>` + ui.escapeHtml(r[k]);
          item.appendChild(p);
        }
      }
      if (r.content) {
        const p = document.createElement("p");
        p.className = "review-line";
        p.innerHTML = `<b>随笔：</b>` + ui.escapeHtml(r.content);
        item.appendChild(p);
      }
      el.appendChild(item);
    }
  }

  function openReviewModal() {
    reviewType = "evening";
    renderTypeSeg();
    ui.$("review-core").value = "";
    ui.$("review-good").value = "";
    ui.$("review-learn").value = "";
    ui.$("review-plan").value = "";
    for (const target of ["good", "learn", "plan"]) {
      const wrap = ui.$("review-" + target + "-wrap");
      if (wrap) wrap.hidden = true;
    }
    ui.$("review-template-row").querySelectorAll(".chip").forEach((b) =>
      b.classList.remove("active")
    );
    ui.$("review-modal").hidden = false;
  }

  async function saveReview() {
    const core = ui.$("review-core").value.trim();
    const good = ui.$("review-good").value.trim();
    const learn = ui.$("review-learn").value.trim();
    const plan = ui.$("review-plan").value.trim();
    if (!core && !good && !learn && !plan) {
      alert("写点什么吧");
      return;
    }
    await storage.saveReview({
      date: storage.todayStr(),
      type: reviewType,
      good,
      learn,
      plan,
      content: core,
    });
    ui.$("review-modal").hidden = true;
    if (ui.renderGrowth) ui.renderGrowth();
    if (ui.renderToday) ui.renderToday();
  }

  function bindEvents() {
    ui.$("review-type-seg").querySelectorAll(".seg-mini-btn").forEach((b) => {
      b.addEventListener("click", () => {
        reviewType = b.dataset.type;
        renderTypeSeg();
      });
    });
    ui.$("review-template-row").querySelectorAll(".chip").forEach((b) => {
      b.addEventListener("click", () => {
        const target = b.dataset.target;
        const wrap = ui.$("review-" + target + "-wrap");
        if (!wrap) return;
        wrap.hidden = !wrap.hidden;
        b.classList.toggle("active", !wrap.hidden);
      });
    });
    ui.$("review-add").addEventListener("click", openReviewModal);
    ui.$("review-add-growth").addEventListener("click", openReviewModal);
    ui.$("review-save").addEventListener("click", saveReview);
    ui.$("review-close").addEventListener("click", () => {
      ui.$("review-modal").hidden = true;
    });
  }

  Object.assign(ui, {
    renderReviewList,
    bindReviews: bindEvents,
  });
})();
