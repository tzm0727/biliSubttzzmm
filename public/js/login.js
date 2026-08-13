// biliSub Web 登录：扫码登录（二维码生成 + 轮询）、手动 Cookie、退出
(function () {
  const ui = window.ui;

  async function refreshLoginStatus() {
    try {
      const data = await api.nav();
      const isLogin = !!(data.json && data.json.data && data.json.data.isLogin);
      const badge = ui.$("login-status");
      badge.textContent = isLogin ? "已登录" : "未登录";
      badge.classList.toggle("on", isLogin);
      badge.classList.toggle("off", !isLogin);
      ui.$("login-btn").hidden = isLogin;
      ui.$("logout-btn").hidden = !isLogin;
    } catch (_) {
      const badge = ui.$("login-status");
      badge.textContent = "服务未连接";
      badge.classList.add("off");
      badge.classList.remove("on");
    }
  }

  function stopQrPolling() {
    if (ui.state.qrTimer) {
      clearInterval(ui.state.qrTimer);
      ui.state.qrTimer = null;
    }
  }

  async function startQr() {
    stopQrPolling();
    ui.$("qr-status").textContent = "正在获取二维码…";
    try {
      const data = await api.qrGenerate();
      if (data.code !== 0 || !data.data || !data.data.url) {
        throw new Error(data.message || "生成二维码失败");
      }
      ui.state.qrKey = data.data.qrcode_key;
      if (window.QRCode) {
        await QRCode.toCanvas(ui.$("qr-canvas"), data.data.url, {
          width: 240,
          margin: 1,
        });
      } else {
        throw new Error("二维码组件缺失");
      }
      ui.$("qr-status").textContent = "请用 B 站 App 扫码";
      const direct = ui.$("qr-direct");
      direct.href = data.data.url;
      direct.hidden = false;
      ui.state.qrTimer = setInterval(pollQr, 2000);
    } catch (e) {
      ui.$("qr-status").textContent = "二维码获取失败：" + e.message;
    }
  }

  async function pollQr() {
    try {
      const data = await api.qrPoll(ui.state.qrKey);
      const result = data.result || {};
      if (result.code !== 0) throw new Error(result.message || "登录接口异常");
      const d = result.data || {};
      const code = d.code;
      if (code === 86101) {
        ui.$("qr-status").textContent = "已扫码，请在手机上确认";
      } else if (code === 86090) {
        ui.$("qr-status").textContent = "请在手机上点击确认";
      } else if (code === 86038 || code === -2) {
        ui.$("qr-status").textContent = "二维码已过期/失效，请刷新";
        stopQrPolling();
      } else if (code === 0) {
        stopQrPolling();
        ui.$("qr-modal").hidden = true;
        ui.appendLog("登录成功，凭据已保存在本机。");
        await refreshLoginStatus();
      } else {
        ui.$("qr-status").textContent = "登录状态异常（code=" + code + "），请刷新";
      }
    } catch (e) {
      ui.$("qr-status").textContent = "轮询失败：" + e.message;
    }
  }

  function parseCookieText(text) {
    const arr = [];
    for (const part of String(text || "").split(";")) {
      const idx = part.indexOf("=");
      if (idx <= 0) continue;
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (name) arr.push({ name, value, domain: ".bilibili.com", path: "/" });
    }
    return arr;
  }

  async function saveCookiesManually() {
    const arr = parseCookieText(ui.$("cookie-text").value);
    if (!arr.length) {
      alert("没有解析到 Cookie，请按 SESSDATA=...; bili_jct=... 的格式填写。");
      return;
    }
    storage.saveBiliCookies(arr);
    await api.sendCookies(arr);
    await refreshLoginStatus();
    ui.appendLog("已保存 " + arr.length + " 条 Cookie。");
  }

  async function clearCookies() {
    storage.clearBiliCookies();
    await api.sendCookies([]);
    ui.$("cookie-text").value = "";
    await refreshLoginStatus();
    ui.appendLog("已清除 B 站登录凭据。");
  }

  Object.assign(ui, {
    refreshLoginStatus,
    stopQrPolling,
    startQr,
    pollQr,
    parseCookieText,
    saveCookiesManually,
    clearCookies,
  });
})();
