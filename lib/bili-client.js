// B 站 HTTP 客户端：请求封装、重定向跟随、WBI 签名
const crypto = require("crypto");
const { buildCookieHeader, mergeSetCookies } = require("./cookie-jar");
const {
  BILI_UA,
  MIXIN_KEY_ENC_TAB,
  FALLBACK_WBI_KEYS,
} = require("./constants");

async function biliGet(url, referer = "https://www.bilibili.com") {
  const headers = {
    "User-Agent": BILI_UA,
    Referer: referer,
    Origin: "https://www.bilibili.com",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
  };
  const cookie = buildCookieHeader(url);
  if (cookie) headers.Cookie = cookie;
  const resp = await fetch(url, { headers, redirect: "manual" });
  const setCookies = resp.headers.getSetCookie
    ? resp.headers.getSetCookie()
    : [];
  mergeSetCookies(url, setCookies);
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    /* 非 JSON */
  }
  return { status: resp.status, headers: resp.headers, json, text };
}

async function followWithCookies(url, maxRedirects = 12) {
  let current = url;
  for (let i = 0; i < maxRedirects; i++) {
    const r = await biliGet(current, "https://www.bilibili.com");
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) {
      current = new URL(loc, current).href;
      continue;
    }
    return { status: r.status, finalUrl: current, json: r.json, text: r.text };
  }
  return { status: 0, finalUrl: current, json: null, text: "" };
}

let wbiCache = { keys: null, at: 0 };

async function getWbiKeys() {
  if (wbiCache.keys && Date.now() - wbiCache.at < 12 * 3600 * 1000) {
    return wbiCache.keys;
  }
  let imgKey = FALLBACK_WBI_KEYS.imgKey;
  let subKey = FALLBACK_WBI_KEYS.subKey;
  try {
    const r = await biliGet("https://api.bilibili.com/x/web-interface/nav");
    const img = (r.json && r.json.data && r.json.data.wbi_img) || {};
    if (img.img_url && img.sub_url) {
      imgKey = img.img_url.split("/").pop().split(".")[0];
      subKey = img.sub_url.split("/").pop().split(".")[0];
    }
  } catch (_) {
    /* 使用备用 key */
  }
  const mixinKey = MIXIN_KEY_ENC_TAB.map((i) => (imgKey + subKey)[i])
    .join("")
    .slice(0, 32);
  wbiCache = { keys: { imgKey, subKey, mixinKey }, at: Date.now() };
  return wbiCache.keys;
}

function signedParams(params, mixinKey) {
  const p = Object.assign({}, params, { wts: Math.floor(Date.now() / 1000) });
  const filter = (s) => String(s).replace(/[!'()*]/g, "");
  const query = Object.keys(p)
    .sort()
    .map((k) => `${filter(k)}=${encodeURIComponent(filter(p[k]))}`)
    .join("&");
  const wRid = crypto.createHash("md5").update(query + mixinKey).digest("hex");
  return `${query}&w_rid=${wRid}`;
}

module.exports = { biliGet, followWithCookies, getWbiKeys, signedParams };
