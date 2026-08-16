// biliSub 日记：心情 + 文字 + 图片（本地压缩存储）
(function () {
  const ui = window.ui;
  const MOODS = ["😄", "😊", "😐", "😔", "😢"];

  let diaryMood = "";
  let diaryImages = [];
  let showAllDiary = false;

  // 渲染「今天」页的日记区
  async function renderDiaryQuick() {
    const el = ui.$("diary-quick");
    if (!el) return;
    const all = await storage.listDiary();
    const list = showAllDiary ? all : all.slice(0, 3);
    ui.$("diary-all").textContent = showAllDiary ? "收起" : "查看全部";

    el.innerHTML = "";
    // 写日记入口
    const writeBtn = document.createElement("button");
    writeBtn.className = "diary-write-btn";
    writeBtn.textContent = "✏️ 写一条日记…";
    writeBtn.addEventListener("click", () => openDiaryModal());
    el.appendChild(writeBtn);

    if (!list.length) {
      if (!showAllDiary) {
        const hint = document.createElement("div");
        hint.className = "empty-hint";
        hint.textContent = "记录心情，留住每一天";
        el.appendChild(hint);
      }
      return;
    }
    for (const d of list) {
      el.appendChild(renderDiaryItem(d));
    }
  }

  function renderDiaryItem(d) {
    const item = document.createElement("div");
    item.className = "diary-item";
    const head = document.createElement("div");
    head.className = "diary-item-head";
    const date = document.createElement("span");
    date.className = "diary-item-date";
    date.textContent = d.date;
    const mood = document.createElement("span");
    mood.className = "diary-item-mood";
    mood.textContent = d.mood || "📝";
    const del = document.createElement("button");
    del.className = "diary-item-del";
    del.textContent = "删除";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("删除这条日记？")) return;
      await storage.deleteDiary(d.id);
      await renderDiaryQuick();
    });
    head.append(date, mood, del);
    item.appendChild(head);
    if (d.content) {
      const p = document.createElement("div");
      p.className = "diary-item-content";
      p.textContent = d.content;
      item.appendChild(p);
    }
    if (d.tags && d.tags.length) {
      const tags = document.createElement("div");
      tags.className = "diary-tags";
      for (const t of d.tags.slice(0, 8)) {
        const span = document.createElement("span");
        span.className = "diary-tag";
        span.textContent = t;
        tags.appendChild(span);
      }
      item.appendChild(tags);
    }
    if (d.images && d.images.length) {
      const imgs = document.createElement("div");
      imgs.className = "diary-item-imgs";
      for (const src of d.images.slice(0, 3)) {
        const img = document.createElement("img");
        img.src = src;
        img.loading = "lazy";
        imgs.appendChild(img);
      }
      item.appendChild(imgs);
    }
    return item;
  }

  // 写日记弹层
  function openDiaryModal() {
    diaryMood = "";
    diaryImages = [];
    ui.$("diary-content").value = "";
    ui.$("diary-tags").value = "";
    const voiceBtn = ui.$("diary-voice");
    if (voiceBtn) {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      voiceBtn.hidden = !SR;
      voiceBtn.classList.remove("listening");
      voiceBtn.textContent = "🎤 语音输入";
    }
    renderDiaryMood();
    renderDiaryImages();
    ui.$("diary-modal").hidden = false;
  }

  function bindVoice() {
    const btn = ui.$("diary-voice");
    if (!btn) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    let rec = null;
    btn.addEventListener("click", () => {
      if (rec) {
        rec.stop();
        return;
      }
      rec = new SR();
      rec.lang = "zh-CN";
      rec.interimResults = true;
      rec.continuous = true;
      btn.classList.add("listening");
      btn.textContent = "⏹ 停止录音";
      rec.onresult = (e) => {
        let text = "";
        for (let i = 0; i < e.results.length; i++) {
          text += e.results[i][0].transcript;
        }
        const ta = ui.$("diary-content");
        if (ta) {
          const base = ta.value.trimEnd();
          ta.value = base ? base + "\n" + text.trim() : text.trim();
        }
      };
      rec.onend = () => {
        rec = null;
        btn.classList.remove("listening");
        btn.textContent = "🎤 语音输入";
      };
      rec.onerror = () => {
        if (rec) {
          rec.stop();
          rec = null;
        }
        btn.classList.remove("listening");
        btn.textContent = "🎤 语音输入";
      };
      rec.start();
    });
  }

  function renderDiaryMood() {
    const el = ui.$("diary-mood");
    el.innerHTML = "";
    MOODS.forEach((m) => {
      const b = document.createElement("button");
      b.className = "mood-btn" + (diaryMood === m ? " active" : "");
      b.textContent = m;
      b.addEventListener("click", () => {
        diaryMood = m;
        renderDiaryMood();
      });
      el.appendChild(b);
    });
  }

  function renderDiaryImages() {
    const el = ui.$("diary-imgs");
    el.innerHTML = "";
    diaryImages.forEach((src, i) => {
      const wrap = document.createElement("div");
      wrap.className = "diary-img-wrap";
      const img = document.createElement("img");
      img.src = src;
      const rm = document.createElement("button");
      rm.className = "diary-img-rm";
      rm.textContent = "×";
      rm.addEventListener("click", () => {
        diaryImages.splice(i, 1);
        renderDiaryImages();
      });
      wrap.append(img, rm);
      el.appendChild(wrap);
    });
  }

  async function addDiaryImages(files) {
    for (const file of Array.from(files || [])) {
      if (diaryImages.length >= 6) break;
      try {
        const dataUrl = await storage.compressImage(file, 900, 0.72);
        diaryImages.push(dataUrl);
      } catch (_) {}
    }
    renderDiaryImages();
  }

  async function saveDiary() {
    const content = ui.$("diary-content").value.trim();
    if (!content && !diaryMood && !diaryImages.length) {
      alert("写点什么吧");
      return;
    }
    await storage.saveDiary({
      date: storage.todayStr(),
      mood: diaryMood,
      content,
      images: diaryImages,
      tags: ui
        .$("diary-tags")
        .value.split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 8),
    });
    ui.$("diary-modal").hidden = true;
    await renderDiaryQuick();
    if (ui.renderToday) ui.renderToday();
  }

  function bindEvents() {
    bindVoice();
    ui.$("diary-all").addEventListener("click", () => {
      showAllDiary = !showAllDiary;
      renderDiaryQuick();
    });
    ui.$("diary-close").addEventListener("click", () => {
      ui.$("diary-modal").hidden = true;
    });
    ui.$("diary-save").addEventListener("click", saveDiary);
    ui.$("diary-add-img").addEventListener("click", () => ui.$("diary-img-input").click());
    ui.$("diary-img-input").addEventListener("change", (e) => {
      addDiaryImages(e.target.files);
      e.target.value = "";
    });
  }

  Object.assign(ui, {
    renderDiaryQuick,
    openDiaryModal,
    bindDiary: bindEvents,
  });
})();
