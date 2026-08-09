// biliSub Web 本地服务
// 服务端基于 Node 原生 http；B 站与 DeepSeek 由本服务代理访问，
// YouTube 字幕使用开源包 youtube-transcript-plus（安卓客户端）+ get-youtube-transcript（后备），均 MIT。
// B 站登录 Cookie 保存在浏览器 localStorage，并在每次请求时同步到本服务。
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawn } = require("child_process");
const ytPlus = require("youtube-transcript-plus");

const PORT = Number(process.env.PORT || 8324);
const PUBLIC_DIR = path.join(__dirname, "public");
const CONFIG_PATH = path.join(__dirname, "server-config.json");
const BIND_HOST = process.env.BIND_HOST || "127.0.0.1";
const BILI_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function resolveYtdlpPath() {
  for (const name of ["yt-dlp", "yt-dlp.exe"]) {
    const p = path.join(__dirname, name);
    try {
      fs.accessSync(p);
      return p;
    } catch (_) {}
  }
  return "";
}
const YTDLP_PATH = resolveYtdlpPath();

function loadServerConfig() {
  const fromEnv = {};
  if (process.env.DEEPSEEK_API_KEY) {
    fromEnv.deepseekApiKey = process.env.DEEPSEEK_API_KEY;
  }
  if (process.env.ACCESS_TOKEN) {
    fromEnv.accessToken = process.env.ACCESS_TOKEN;
  }
  try {
    const fromFile = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return Object.assign({}, fromFile, fromEnv);
  } catch (_) {
    return fromEnv;
  }
}
const serverConfig = loadServerConfig();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

// ---------------------------------------------------------------------------
// B 站 Cookie 罐（内存）
// ---------------------------------------------------------------------------
const jar = new Map();
const activeAIRequests = new Map();

function parseSetCookie(str) {
  const parts = String(str || "").split(";");
  const first = (parts.shift() || "").trim();
  const eq = first.indexOf("=");
  const name = eq > 0 ? first.slice(0, eq).trim() : "";
  const value = eq >= 0 ? first.slice(eq + 1).trim() : "";
  let domain = "";
  let pathValue = "/";
  let expires = null;
  let secure = false;
  for (const p of parts) {
    const seg = p.trim();
    const idx = seg.indexOf("=");
    const key = (idx >= 0 ? seg.slice(0, idx) : seg).trim().toLowerCase();
    const val = idx >= 0 ? seg.slice(idx + 1).trim() : "";
    if (key === "domain") domain = val;
    else if (key === "path") pathValue = val || "/";
    else if (key === "expires") expires = Date.parse(val);
    else if (key === "max-age") expires = Date.now() + Number(val) * 1000;
    else if (key === "secure") secure = true;
  }
  return { name, value, domain, path: pathValue, expires, secure };
}

function mergeSetCookies(requestUrl, setCookieList) {
  const host = new URL(requestUrl).hostname;
  for (const raw of setCookieList || []) {
    const c = parseSetCookie(raw);
    if (!c.name) continue;
    if (!c.domain) c.domain = host;
    if (c.expires && c.expires <= Date.now()) {
      jar.delete(`${c.domain}|${c.path}|${c.name}`);
      continue;
    }
    jar.set(`${c.domain}|${c.path}|${c.name}`, c);
  }
}

function domainMatches(domain, host) {
  const d = domain.startsWith(".") ? domain.slice(1) : domain;
  return host === d || host.endsWith("." + d);
}

function buildCookieHeader(requestUrl) {
  const u = new URL(requestUrl);
  const host = u.hostname;
  const pathName = u.pathname || "/";
  const parts = [];
  for (const c of jar.values()) {
    if (!domainMatches(c.domain, host)) continue;
    if (!pathName.startsWith(c.path)) continue;
    if (c.secure && u.protocol !== "https:") continue;
    parts.push(`${c.name}=${c.value}`);
  }
  return parts.join("; ");
}

function cookiesArray() {
  return Array.from(jar.values()).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    secure: c.secure,
  }));
}

function setCookiesArray(arr) {
  jar.clear();
  for (const c of Array.isArray(arr) ? arr : []) {
    if (c && c.name) {
      jar.set(
        `${c.domain || ""}|${c.path || "/"}|${c.name}`,
        {
          name: c.name,
          value: c.value || "",
          domain: c.domain || "",
          path: c.path || "/",
          expires: c.expires || null,
          secure: !!c.secure,
        }
      );
    }
  }
}

// ---------------------------------------------------------------------------
// B 站 HTTP 请求
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// WBI 签名
// ---------------------------------------------------------------------------
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];
const FALLBACK_WBI_KEYS = {
  imgKey: "7cd084941338484aae1ad9425b84077c",
  subKey: "4932caff0ff746eab6f01bf08b70ac45",
};

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

// ---------------------------------------------------------------------------
// YouTube 字幕
// 主方案：youtube-transcript-plus（MIT）走安卓客户端 Innertube 接口，
//         不需要 PoToken，对数据中心 IP 更友好；
// 后备方案：get-youtube-transcript（MIT）自动处理 PoToken/BotGuard。
// 另加 30 分钟内存缓存，减少重复请求被限流的概率。
// ---------------------------------------------------------------------------
const ytCache = new Map(); // videoId -> { at, data }

function extractYoutubeId(input) {
  const s = String(input || "").trim();
  const m =
    s.match(
      /(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/|v\/))([\w-]{11})/
    ) ||
    s.match(/youtu\.be\/([\w-]{11})/) ||
    s.match(/^([\w-]{11})$/);
  return m ? m[1] : "";
}

function rankYtLang(item) {
  const code = String(item.languageCode || item.lang || "")
    .toLowerCase()
    .split("-")[0];
  let base = 2;
  if (code === "zh" || code === "yue") base = 0;
  else if (code === "en") base = 1;
  return base + (item.isAutoGenerated ? 0.5 : 0);
}

function mapYtSegments(segments, lang) {
  return (segments || [])
    .map((s) => {
      const start = Number(s.offset !== undefined ? s.offset : s.start) || 0;
      return {
        start,
        end: start + (Number(s.duration) || 0),
        content: String(s.text || "").trim(),
        lang: String(s.lang || lang || ""),
      };
    })
    .filter((s) => s.content);
}

async function fetchYtTitle(videoId) {
  try {
    const u =
      "https://www.youtube.com/oembed?format=json&url=" +
      encodeURIComponent("https://www.youtube.com/watch?v=" + videoId);
    const resp = await fetch(u, {
      headers: { "User-Agent": BILI_UA, "Accept-Language": "zh-CN,zh;q=0.9" },
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.title) return String(data.title);
    }
  } catch (_) {
    /* 标题获取失败时使用兜底名 */
  }
  return "";
}

async function fetchYtSubtitleAndroid(rawUrl, videoId) {
  const languages = await ytPlus.listLanguages(rawUrl, {
    userAgent: BILI_UA,
    retries: 2,
    retryDelay: 1500,
  });
  if (!languages || !languages.length) {
    throw new Error("该视频没有可用字幕（或无字幕权限）");
  }
  const candidates = [...languages].sort(
    (a, b) => rankYtLang(a) - rankYtLang(b)
  );
  let lastErr = null;
  for (const cand of candidates.slice(0, 4)) {
    try {
      const result = await ytPlus.fetchTranscript(rawUrl, {
        lang: cand.languageCode,
        userAgent: BILI_UA,
        retries: 3,
        retryDelay: 1500,
        videoDetails: true,
      });
      const segments = mapYtSegments(result.segments, cand.languageCode);
      if (!segments.length) throw new Error("字幕内容为空");
      const title =
        (result.videoDetails && result.videoDetails.title) ||
        (await fetchYtTitle(videoId)) ||
        `YouTube-${videoId}`;
      return {
        videoId,
        title,
        lang: cand.languageCode || "",
        langName:
          cand.languageName ||
          (cand.isAutoGenerated ? "自动生成（机翻）" : "人工字幕"),
        segments,
      };
    } catch (e) {
      lastErr = e;
      // 只有“该语言不可用”时才继续试下一种语言，其余错误直接结束
      if (!/language/i.test(String(e.name || "") + String(e.message || ""))) {
        break;
      }
    }
  }
  throw lastErr || new Error("该视频没有可用字幕（或无字幕权限）");
}

const YT_INNERTUBE_KEYS = [
  "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
  "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w",
];

async function fetchYtSubtitleInnertube(rawUrl, videoId) {
  const endpoints = [
    "https://youtubei.googleapis.com/youtubei/v1/player",
    "https://www.youtube.com/youtubei/v1/player",
  ];
  const payload = {
    context: {
      client: {
        clientName: "ANDROID",
        clientVersion: "20.10.38",
      },
    },
    videoId,
  };
  let lastErr = null;
  for (const endpoint of endpoints) {
    for (const key of YT_INNERTUBE_KEYS) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 20000);
        const resp = await fetch(
          `${endpoint}?key=${encodeURIComponent(key)}&prettyPrint=false`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": BILI_UA,
              "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            },
            body: JSON.stringify(payload),
            signal: ctrl.signal,
          }
        );
        clearTimeout(timer);
        if (!resp.ok) {
          throw new Error(`播放器接口 HTTP ${resp.status}`);
        }
        const player = await resp.json();
        const ps = player && player.playabilityStatus;
        const tracks =
          (player &&
            player.captions &&
            player.captions.playerCaptionsTracklistRenderer &&
            player.captions.playerCaptionsTracklistRenderer.captionTracks) ||
          [];
        if (!tracks.length) {
          throw new Error(
            `无字幕轨道（playability=${(ps && ps.status) || "-"} ${
              (ps && ps.reason) || ""
            }）`
          );
        }
        const candidates = [...tracks].sort(
          (a, b) => rankYtLang(a) - rankYtLang(b)
        );
        for (const track of candidates.slice(0, 4)) {
          try {
            const baseUrl =
              String(track.baseUrl || "") +
              (String(track.baseUrl || "").includes("?") ? "&" : "?") +
              "fmt=vtt";
            const tCtrl = new AbortController();
            const tTimer = setTimeout(() => tCtrl.abort(), 25000);
            const tResp = await fetch(baseUrl, {
              headers: {
                "User-Agent": BILI_UA,
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
              },
              signal: tCtrl.signal,
            });
            clearTimeout(tTimer);
            if (!tResp.ok) throw new Error(`字幕接口 HTTP ${tResp.status}`);
            const vttText = await tResp.text();
            const segments = parseVttSegments(vttText).map((s) =>
              Object.assign({}, s, { lang: track.languageCode || "" })
            );
            if (!segments.length) throw new Error("字幕内容为空");
            return {
              videoId,
              title:
                (player.videoDetails && player.videoDetails.title) ||
                (await fetchYtTitle(videoId)) ||
                `YouTube-${videoId}`,
              lang: track.languageCode || "",
              langName:
                track.kind === "asr"
                  ? "自动生成（机翻）"
                  : track.name && track.name.simpleText
                  ? track.name.simpleText
                  : "人工字幕",
              segments,
            };
          } catch (e) {
            lastErr = e;
            const msg = String(e.message || "");
            if (!/字幕内容为空|HTTP/.test(msg)) throw e;
          }
        }
        throw lastErr || new Error("字幕内容为空");
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw (
    lastErr ||
    new Error("该视频没有可用字幕（或无字幕权限）")
  );
}

function hasYtdlp() {
  try {
    fs.accessSync(YTDLP_PATH, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function runYtdlp(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_PATH, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("yt-dlp 超时"));
    }, timeoutMs || 120000);
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const tail = (stderr || stdout || "")
          .trim()
          .split("\n")
          .slice(-3)
          .join(" ");
        reject(new Error(tail || `yt-dlp 退出码 ${code}`));
      }
    });
  });
}

function htmlDecodeYt(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function vttTimeToSec(t) {
  const m = String(t || "").match(/(\d+):(\d{2}):(\d{2})\.(\d{3})/);
  if (!m) return 0;
  return (
    Number(m[1]) * 3600 +
    Number(m[2]) * 60 +
    Number(m[3]) +
    Number(m[4]) / 1000
  );
}

function parseVttSegments(vttText) {
  const out = [];
  let cur = null;
  for (const raw of String(vttText || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === "WEBVTT") continue;
    const m = line.match(
      /^(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/
    );
    if (m) {
      if (cur && cur.content) out.push(cur);
      cur = { start: vttTimeToSec(m[1]), end: vttTimeToSec(m[2]), content: "" };
      continue;
    }
    if (cur && /^(NOTE|STYLE|REGION|Kind:|Language:)/i.test(line)) continue;
    if (cur) {
      const text = htmlDecodeYt(line.replace(/<[^>]+>/g, "")).trim();
      if (text) cur.content += (cur.content ? " " : "") + text;
    }
  }
  if (cur && cur.content) out.push(cur);
  return out;
}

async function fetchYtSubtitleYtdlp(rawUrl, videoId) {
  if (!hasYtdlp()) throw new Error("yt-dlp 未安装");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bilisub-yt-"));
  const clientArgs = "--extractor-args";
  const clients = "youtube:player_client=default,tv,web_safari,android";
  try {
    const info = await runYtdlp(
      ["-J", "--skip-download", "--no-warnings", clientArgs, clients, rawUrl],
      90000
    );
    const data = JSON.parse(info.stdout);
    if (!data || !data.id) throw new Error("无法解析 YouTube 视频信息");
    const candidates = [];
    for (const [code, arr] of Object.entries(data.subtitles || {})) {
      if (arr && arr.length) {
        candidates.push({ languageCode: code, isAutoGenerated: false });
      }
    }
    for (const [code, arr] of Object.entries(data.automatic_captions || {})) {
      if (arr && arr.length) {
        candidates.push({ languageCode: code, isAutoGenerated: true });
      }
    }
    if (!candidates.length) {
      throw new Error("该视频没有可用字幕（或无字幕权限）");
    }
    candidates.sort((a, b) => rankYtLang(a) - rankYtLang(b));
    let lastErr = null;
    for (const cand of candidates.slice(0, 4)) {
      const base = path.join(tmpDir, videoId);
      try {
        await runYtdlp(
          [
            "--skip-download",
            "--no-warnings",
            "--write-subs",
            "--write-auto-subs",
            "--sub-langs",
            cand.languageCode,
            "--sub-format",
            "vtt",
            clientArgs,
            clients,
            "-o",
            base,
            rawUrl,
          ],
          120000
        );
        const vttPath = `${base}.${cand.languageCode}.vtt`;
        const vttText = fs.readFileSync(vttPath, "utf8");
        const segments = parseVttSegments(vttText).map((s) =>
          Object.assign({}, s, { lang: cand.languageCode })
        );
        if (!segments.length) throw new Error("字幕内容为空");
        return {
          videoId,
          title:
            data.title ||
            (await fetchYtTitle(videoId)) ||
            `YouTube-${videoId}`,
          lang: cand.languageCode || "",
          langName: cand.isAutoGenerated ? "自动生成（机翻）" : "人工字幕",
          segments,
        };
      } catch (e) {
        lastErr = e;
        const msg = String(e.message || "");
        if (
          !/ENOENT|No such file|Unable to download|没有可用字幕|字幕内容为空/i.test(
            msg
          )
        ) {
          break;
        }
      }
    }
    throw lastErr || new Error("该视频没有可用字幕（或无字幕权限）");
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

async function fetchYtSubtitleLegacy(rawUrl, videoId) {
  const mod = await import("get-youtube-transcript");
  const result = await mod.getTranscript(rawUrl, {
    languages: [
      "zh",
      "zh-CN",
      "zh-Hans",
      "zh-Hant",
      "en",
      "en-US",
      "en-GB",
      "ja",
      "ko",
    ],
  });
  if (!result || !result.segments || !result.segments.length) {
    throw new Error("该视频没有可用字幕（或无字幕权限）");
  }
  const segments = mapYtSegments(result.segments, result.language);
  if (!segments.length) throw new Error("字幕内容为空");
  const title = (await fetchYtTitle(videoId)) || `YouTube-${videoId}`;
  return {
    videoId,
    title,
    lang: result.language || "",
    langName:
      result.kind === "auto-generated" ? "自动生成（机翻）" : "人工字幕",
    segments,
  };
}

async function fetchYoutubeSubtitle(rawUrl) {
  const videoId = extractYoutubeId(rawUrl);
  if (!videoId) throw new Error("无法识别的 YouTube 链接");
  const hit = ytCache.get(videoId);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.data;
  const channels = [
    ["安卓客户端-直连", () => fetchYtSubtitleInnertube(rawUrl, videoId)],
  ];
  channels.push(["安卓客户端-官方库", () => fetchYtSubtitleAndroid(rawUrl, videoId)]);
  if (hasYtdlp()) {
    channels.push(["yt-dlp 多客户端", () => fetchYtSubtitleYtdlp(rawUrl, videoId)]);
    channels.push(["yt-dlp 代理轮询", () => fetchYtSubtitleViaProxy(rawUrl, videoId)]);
  }
  channels.push(["Web 客户端", () => fetchYtSubtitleLegacy(rawUrl, videoId)]);
  const errors = [];
  for (const [name, fn] of channels) {
    try {
      const data = await fn();
      ytCache.set(videoId, { at: Date.now(), data });
      return data;
    } catch (e) {
      errors.push(`${name}：${String(e.message || e)}`);
    }
  }
  throw new Error(errors.join("；") || "该视频没有可用字幕（或无字幕权限）");
}

// ---------------------------------------------------------------------------
// YouTube 备用通道：免费代理轮询 + 临时诊断接口
// ---------------------------------------------------------------------------
const proxyPoolCache = { list: [], at: 0, lastGood: "" };
const PROXY_SOURCES = [
  "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=8000&country=all&ssl=yes&anonymity=all",
  "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=8000&country=all",
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt",
];

function diagFetch(url, options = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = Object.assign(
    {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    options.headers || {}
  );
  return fetch(url, Object.assign({}, options, { headers, signal: ctrl.signal }))
    .then(async (resp) => {
      const body = await resp.text();
      return {
        ok: resp.ok,
        status: resp.status,
        type: resp.headers.get("content-type") || "",
        body,
      };
    })
    .catch((e) => ({
      ok: false,
      status: 0,
      type: "",
      body: "",
      err: String((e && e.message) || e),
    }))
    .finally(() => clearTimeout(timer));
}

function diagSnippet(s, n = 240) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function parseYtPlayer(body) {
  try {
    const m = String(body || "").match(
      /ytInitialPlayerResponse\s*=\s*(\{.*?\})\s*;\s*(?:var\s+meta|<\/script>)/s
    );
    if (!m) return null;
    return JSON.parse(m[1]);
  } catch (_) {
    return null;
  }
}

function extractCaptionTracks(pr) {
  try {
    return (
      (pr &&
        pr.captions &&
        pr.captions.playerCaptionsTracklistRenderer &&
        pr.captions.playerCaptionsTracklistRenderer.captionTracks) ||
      []
    );
  } catch (_) {
    return [];
  }
}

async function loadProxyList() {
  if (
    proxyPoolCache.list.length &&
    Date.now() - proxyPoolCache.at < 10 * 60 * 1000
  ) {
    return proxyPoolCache.list;
  }
  const seen = new Set();
  const out = [];
  for (const src of PROXY_SOURCES) {
    try {
      const r = await diagFetch(src, {}, 10000);
      if (!r.ok) continue;
      const proto = src.includes("socks5") ? "socks5" : "http";
      for (const raw of String(r.body).split(/\r?\n/)) {
        const line = raw.trim();
        const m = line.match(/^([0-9a-fA-F:.]+):(\d{2,5})$/);
        if (!m) continue;
        const key = `${m[1]}:${m[2]}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ host: m[1], port: m[2], proto });
        }
        if (out.length >= 80) break;
      }
    } catch (_) {
      /* 单个代理源失败不影响其它源 */
    }
    if (out.length >= 80) break;
  }
  proxyPoolCache.list = out;
  proxyPoolCache.at = Date.now();
  return out;
}

function ytdlpCandidates(data) {
  const list = [];
  for (const [code, arr] of Object.entries(data.subtitles || {})) {
    if (arr && arr.length) {
      list.push({ languageCode: code, isAutoGenerated: false });
    }
  }
  for (const [code, arr] of Object.entries(data.automatic_captions || {})) {
    if (arr && arr.length) {
      list.push({ languageCode: code, isAutoGenerated: true });
    }
  }
  return list.sort((a, b) => rankYtLang(a) - rankYtLang(b));
}

async function fetchYtSubtitleViaProxy(rawUrl, videoId) {
  if (!hasYtdlp()) throw new Error("yt-dlp 未安装，代理通道不可用");
  const proxies = await loadProxyList();
  if (!proxies.length) throw new Error("暂无可用代理");
  const attempts = [];
  if (proxyPoolCache.lastGood) attempts.push(proxyPoolCache.lastGood);
  for (const p of proxies) {
    const arg = `${p.proto}://${p.host}:${p.port}`;
    if (!attempts.includes(arg)) attempts.push(arg);
    if (attempts.length >= 8) break;
  }
  let lastErr = null;
  for (const proxyArg of attempts) {
    try {
      const info = await runYtdlp(
        ["-J", "--skip-download", "--no-warnings", "--proxy", proxyArg, rawUrl],
        25000
      );
      const data = JSON.parse(info.stdout);
      if (!data || !data.id) throw new Error("无法解析 YouTube 视频信息");
      const candidates = ytdlpCandidates(data);
      if (!candidates.length) {
        throw new Error("该视频没有可用字幕（或无字幕权限）");
      }
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bilisub-yt-proxy-"));
      try {
        let lastCandErr = null;
        for (const cand of candidates.slice(0, 4)) {
          const base = path.join(tmpDir, videoId);
          try {
            await runYtdlp(
              [
                "--skip-download",
                "--no-warnings",
                "--write-subs",
                "--write-auto-subs",
                "--sub-langs",
                cand.languageCode,
                "--sub-format",
                "vtt",
                "--proxy",
                proxyArg,
                "-o",
                base,
                rawUrl,
              ],
              40000
            );
            const vttPath = `${base}.${cand.languageCode}.vtt`;
            const vttText = fs.readFileSync(vttPath, "utf8");
            const segments = parseVttSegments(vttText).map((s) =>
              Object.assign({}, s, { lang: cand.languageCode })
            );
            if (!segments.length) throw new Error("字幕内容为空");
            proxyPoolCache.lastGood = proxyArg;
            return {
              videoId,
              title:
                data.title ||
                (await fetchYtTitle(videoId)) ||
                `YouTube-${videoId}`,
              lang: cand.languageCode || "",
              langName: cand.isAutoGenerated
                ? "自动生成（机翻）"
                : "人工字幕",
              segments,
            };
          } catch (e) {
            lastCandErr = e;
            const msg = String(e.message || "");
            if (
              !/ENOENT|No such file|Unable to download|没有可用字幕|字幕内容为空/i.test(
                msg
              )
            ) {
              throw e;
            }
          }
        }
        throw lastCandErr || new Error("该视频没有可用字幕（或无字幕权限）");
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_) {}
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `代理通道失败（已尝试 ${attempts.length} 个代理）：${diagSnippet(
      String((lastErr && lastErr.message) || lastErr),
      180
    )}`
  );
}

async function diagYoutube(rawUrl) {
  const videoId = extractYoutubeId(rawUrl) || "";
  const out = { videoId, at: new Date().toISOString(), results: [] };
  const add = (name, ok, detail, ms) => {
    out.results.push({
      name,
      ok: !!ok,
      ms: Math.round(ms || 0),
      detail: diagSnippet(detail, 260),
    });
  };
  const run = async (name, fn) => {
    const t = Date.now();
    try {
      const r = await fn();
      add(name, true, r, Date.now() - t);
    } catch (e) {
      add(name, false, String((e && e.message) || e), Date.now() - t);
    }
  };

  if (!videoId) {
    out.results.push({ name: "invalid-url", ok: false, ms: 0, detail: "无法识别视频 ID" });
    return out;
  }

  await run("watch-page", async () => {
    const r = await diagFetch(
      `https://www.youtube.com/watch?v=${videoId}&hl=en`,
      { headers: { "Accept-Language": "en" } },
      15000
    );
    let detail = `HTTP ${r.status}${r.type ? " " + r.type : ""}`;
    const pr = parseYtPlayer(r.body);
    if (!pr) {
      detail += r.body && r.body.length > 20000
        ? " | 页面已返回但未解析出播放器数据"
        : " | 无法解析播放器数据";
      return detail;
    }
    const ps = pr.playabilityStatus || {};
    const tracks = extractCaptionTracks(pr);
    detail += ` | playability=${ps.status} reason=${ps.reason || "-"} tracks=${tracks.length}`;
    if (tracks.length) {
      const track = tracks[0];
      detail += ` | first=${track.languageCode} ${track.kind || ""}`;
      const tt = await diagFetch(
        track.baseUrl +
          (String(track.baseUrl).includes("?") ? "&" : "?") +
          "fmt=vtt",
        {},
        15000
      );
      detail += ` | timedtext=${tt.status} len=${String(tt.body).length}`;
    }
    return detail;
  });

  for (const host of [
    "https://www.youtube.com",
    "https://youtubei.googleapis.com",
  ]) {
    await run(`innertube-${host.replace("https://", "")}`, async () => {
      const payload = {
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: "19.09.37",
            androidSdkVersion: 30,
            hl: "en",
            gl: "US",
          },
        },
        videoId,
      };
      const r = await diagFetch(
        `${host}/youtubei/v1/player?prettyPrint=false`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        15000
      );
      let detail = `HTTP ${r.status}`;
      let pr = null;
      try {
        pr = JSON.parse(r.body);
      } catch (_) {}
      if (!pr) return detail + ` | 非 JSON 响应：${diagSnippet(r.body, 120)}`;
      const ps = pr.playabilityStatus || {};
      detail += ` | playability=${ps.status} reason=${ps.reason || "-"}`;
      const tracks = extractCaptionTracks(pr);
      detail += ` tracks=${tracks.length}`;
      if (tracks.length) {
        const track = tracks[0];
        detail += ` first=${track.languageCode} ${track.kind || ""}`;
        const tt = await diagFetch(
          track.baseUrl +
            (String(track.baseUrl).includes("?") ? "&" : "?") +
            "fmt=vtt",
          {},
          15000
        );
        detail += ` timedtext=${tt.status} len=${String(tt.body).length}`;
      }
      return detail;
    });
  }

  for (const host of [
    "https://youtubei.googleapis.com",
    "https://www.youtube.com",
  ]) {
    await run(`innertube-android-${host.replace("https://", "")}`, async () => {
      const payload = {
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: "20.10.38",
          },
        },
        videoId,
      };
      let best = "";
      for (const key of YT_INNERTUBE_KEYS) {
        const r = await diagFetch(
          `${host}/youtubei/v1/player?key=${key}&prettyPrint=false`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
          15000
        );
        let pr = null;
        try {
          pr = JSON.parse(r.body);
        } catch (_) {}
        const tracks = pr ? extractCaptionTracks(pr) : [];
        const ps = (pr && pr.playabilityStatus) || {};
        best = `HTTP ${r.status} play=${ps.status} reason=${ps.reason || "-"} tracks=${tracks.length}`;
        if (tracks.length) {
          const track = tracks[0];
          const tt = await diagFetch(
            track.baseUrl +
              (String(track.baseUrl).includes("?") ? "&" : "?") +
              "fmt=vtt",
            {},
            20000
          );
          best += ` | first=${track.languageCode} ${track.kind || ""} timedtext=${tt.status}/${String(tt.body).length}`;
          break;
        }
      }
      return best;
    });
  }

  await run("video-google-timedtext", async () => {
    const parts = [];
    for (const q of [
      `type=list&v=${videoId}`,
      `lang=en&v=${videoId}`,
      `lang=en&v=${videoId}&fmt=vtt`,
    ]) {
      const r = await diagFetch(
        `https://video.google.com/timedtext?${q}`,
        {},
        12000
      );
      parts.push(`${q.split("&")[0]}=${r.status}/${String(r.body).length}`);
    }
    return parts.join(" | ");
  });

  await run("youtubetranscript-com", async () => {
    const r = await diagFetch(
      `https://youtubetranscript.com/?server_vid2=${videoId}`,
      {},
      15000
    );
    return `HTTP ${r.status} | ${diagSnippet(r.body, 180)}`;
  });

  await run("youtubetotranscript-get", async () => {
    const r = await diagFetch(
      `https://youtubetotranscript.com/transcript?v=${videoId}`,
      {
        headers: {
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Referer: "https://youtubetotranscript.com/",
        },
      },
      15000
    );
    return `HTTP ${r.status} | ${diagSnippet(r.body, 180)}`;
  });

  await run("youtubetotranscript-post", async () => {
    const body =
      "youtube_url=" +
      encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
    const r = await diagFetch("https://youtubetotranscript.com/transcript", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://youtubetotranscript.com",
        Referer: "https://youtubetotranscript.com/",
      },
      body,
    }, 15000);
    return `HTTP ${r.status} | ${diagSnippet(r.body, 180)}`;
  });

  await run("kome-api", async () => {
    const payload = { video_id: videoId, format: true };
    const r = await diagFetch(
      "https://api.kome.ai/api/tools/youtube-transcripts",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://kome.ai",
          Referer: "https://kome.ai/",
        },
        body: JSON.stringify(payload),
      },
      15000
    );
    return `HTTP ${r.status} | ${diagSnippet(r.body, 180)}`;
  });

  await run("tactiq", async () => {
    const r = await diagFetch(
      "https://tactiq-apps-prod.tactiq.io/transcript",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Origin: "https://tactiq.io",
          Referer: "https://tactiq.io/",
        },
        body: JSON.stringify({
          videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
          langCode: "en",
        }),
      },
      15000
    );
    return `HTTP ${r.status} | ${diagSnippet(r.body, 180)}`;
  });

  await run("piped", async () => {
    const insts = [];
    try {
      const r = await diagFetch("https://piped-instances.kavin.rocks/", {}, 10000);
      if (r.ok) {
        const arr = JSON.parse(r.body);
        for (const it of arr) {
          if (it && it.api_url) insts.push(String(it.api_url));
        }
      }
    } catch (_) {}
    for (const api of [
      "https://pipedapi.kavin.rocks",
      "https://pipedapi.adminforge.de",
      "https://pipedapi.leptons.xyz",
      "https://api.piped.private.coffee",
    ]) {
      if (!insts.includes(api)) insts.push(api);
    }
    const parts = [];
    for (const api of insts.slice(0, 8)) {
      const r = await diagFetch(
        `${api}/streams/${videoId}`,
        { headers: { Accept: "application/json" } },
        10000
      );
      let track = null;
      try {
        const j = JSON.parse(r.body);
        const subs = (j && j.subtitles) || [];
        if (subs.length) track = subs[0];
      } catch (_) {}
      if (track && track.url) {
        const tt = await diagFetch(track.url, {}, 10000);
        parts.push(
          `${api.replace("https://", "")}=OK subs=${track.code || "?"} vtt=${tt.status}/${String(tt.body).length}`
        );
        if (String(tt.body).length > 100) break;
      } else {
        parts.push(`${api.replace("https://", "")}=${r.status}`);
      }
    }
    return parts.join(" | ") || "无实例";
  });

  await run("invidious", async () => {
    const hosts = [];
    try {
      const r = await diagFetch(
        "https://api.invidious.io/instances.json?sort_by=health",
        {},
        10000
      );
      if (r.ok) {
        const arr = JSON.parse(r.body);
        for (const item of arr || []) {
          const info = item && item[1];
          if (
            info &&
            info.type === "https" &&
            info.stats &&
            info.stats.software &&
            info.stats.software.name === "invidious"
          ) {
            hosts.push(String(item[0]));
          }
        }
      }
    } catch (_) {}
    for (const h of [
      "inv.nadeko.net",
      "invidious.f5.si",
      "invidious.nerdvpn.de",
    ]) {
      if (!hosts.includes(h)) hosts.push(h);
    }
    const parts = [];
    for (const h of hosts.slice(0, 8)) {
      const r = await diagFetch(
        `https://${h}/api/v1/captions/${videoId}`,
        {},
        10000
      );
      let cap = null;
      try {
        const j = JSON.parse(r.body);
        const caps = (j && j.captions) || [];
        if (caps.length) cap = caps[0];
      } catch (_) {}
      if (cap && cap.url) {
        const tt = await diagFetch(`https://${h}${cap.url}`, {}, 12000);
        parts.push(
          `${h}=OK ${cap.languageCode || "?"} vtt=${tt.status}/${String(tt.body).length}`
        );
        if (String(tt.body).length > 100) break;
      } else {
        parts.push(`${h}=${r.status}`);
      }
    }
    return parts.join(" | ") || "无实例";
  });

  await run("proxy-list", async () => {
    const list = await loadProxyList();
    return `共获取 ${list.length} 个代理（http=${list.filter((p) => p.proto === "http").length}, socks5=${list.filter((p) => p.proto === "socks5").length}）`;
  });

  if (hasYtdlp()) {
    const proxies = await loadProxyList();
    const attempts = [];
    if (proxyPoolCache.lastGood) attempts.push(proxyPoolCache.lastGood);
    for (const p of proxies) {
      const arg = `${p.proto}://${p.host}:${p.port}`;
      if (!attempts.includes(arg)) attempts.push(arg);
      if (attempts.length >= 6) break;
    }
    let idx = 0;
    for (const proxyArg of attempts) {
      idx++;
      await run(`ytdlp-proxy-${idx}`, async () => {
        const info = await runYtdlp(
          ["-J", "--skip-download", "--no-warnings", "--proxy", proxyArg, rawUrl],
          22000
        );
        const data = JSON.parse(info.stdout);
        const candidates = ytdlpCandidates(data);
        return `${proxyArg} 解析成功，字幕 ${candidates.length} 种`;
      });
    }
  }

  await run("ytplus", async () => {
    const langs = await Promise.race([
      ytPlus.listLanguages(rawUrl, {
        userAgent: BILI_UA,
        retries: 1,
        retryDelay: 800,
      }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("超时 15s")), 15000)
      ),
    ]);
    return `字幕语言 ${langs.length} 种：${langs
      .slice(0, 6)
      .map((l) => l.languageCode)
      .join(",")}`;
  });

  await run("getyt", async () => {
    const mod = await import("get-youtube-transcript");
    const result = await Promise.race([
      mod.getTranscript(rawUrl, { languages: ["en", "zh", "zh-CN"] }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("超时 15s")), 15000)
      ),
    ]);
    return `语言 ${result.language}，段落 ${result.segments.length}`;
  });

  return out;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function extractBvid(input) {
  const m = String(input || "").match(/BV[0-9A-Za-z]+/);
  return m ? m[0] : "";
}

function extractPage(input) {
  try {
    const u = new URL(String(input || ""));
    const p = Number(u.searchParams.get("p"));
    return Number.isInteger(p) && p >= 1 ? p : 1;
  } catch (_) {
    const m = String(input || "").match(/[?&]p=(\d+)/);
    if (m) {
      const p = Number(m[1]);
      if (Number.isInteger(p) && p >= 1) return p;
    }
    return 1;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req, limitBytes = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error("JSON 解析失败"));
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// API 路由
// ---------------------------------------------------------------------------
async function handleApi(req, res, url, body) {
  const p = url.searchParams;

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      port: PORT,
      hasCookies: jar.size > 0,
      hasAiKey: !!serverConfig.deepseekApiKey,
      needsToken: !!serverConfig.accessToken,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/session/cookies") {
    setCookiesArray(body.cookies || []);
    return sendJson(res, 200, { ok: true, count: jar.size });
  }

  if (req.method === "GET" && url.pathname === "/api/bili/nav") {
    const r = await biliGet("https://api.bilibili.com/x/web-interface/nav");
    return sendJson(res, 200, {
      json: r.json,
      cookies: cookiesArray(),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/bili/qrcode/generate") {
    const r = await biliGet(
      "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
    );
    return sendJson(res, 200, {
      code: r.json && r.json.code,
      message: r.json && r.json.message,
      data: r.json && r.json.data,
      cookies: cookiesArray(),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/bili/qrcode/poll") {
    const key = p.get("qrcode_key") || "";
    if (!key) return sendJson(res, 400, { error: "缺少 qrcode_key" });
    const r = await biliGet(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(
        key
      )}&source=main-fe-header`
    );
    const result = r.json || {};
    if (result.code === 0 && result.data && result.data.code === 0 && result.data.url) {
      await followWithCookies(result.data.url);
    }
    return sendJson(res, 200, { result, cookies: cookiesArray() });
  }

  if (req.method === "GET" && url.pathname === "/api/bili/resolve") {
    const raw = p.get("url") || "";
    let bvid = extractBvid(raw);
    let finalUrl = raw;
    if (!bvid && /^https?:\/\//i.test(raw)) {
      const r = await followWithCookies(raw);
      finalUrl = r.finalUrl;
      bvid = extractBvid(finalUrl);
    }
    if (!bvid) {
      return sendJson(res, 200, { error: "无法从链接中提取 BV 号", bvid: "" });
    }
    return sendJson(res, 200, {
      bvid,
      page: extractPage(raw),
      url: finalUrl,
      cookies: cookiesArray(),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/bili/view") {
    const bvid = p.get("bvid") || "";
    if (!bvid) return sendJson(res, 400, { error: "缺少 bvid" });
    const r = await biliGet(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`
    );
    return sendJson(res, 200, { json: r.json, cookies: cookiesArray() });
  }

  if (req.method === "GET" && url.pathname === "/api/bili/subtitles") {
    const bvid = p.get("bvid") || "";
    const cid = p.get("cid") || "";
    if (!bvid || !cid) return sendJson(res, 400, { error: "缺少 bvid 或 cid" });
    const keys = await getWbiKeys();
    const query = signedParams({ bvid, cid }, keys.mixinKey);
    const r = await biliGet(`https://api.bilibili.com/x/player/wbi/v2?${query}`);
    return sendJson(res, 200, { json: r.json, cookies: cookiesArray() });
  }

  if (req.method === "GET" && url.pathname === "/api/bili/subtitle") {
    let subUrl = p.get("url") || "";
    if (!subUrl) return sendJson(res, 400, { error: "缺少字幕 URL" });
    if (!/^https?:/i.test(subUrl)) subUrl = "https:" + subUrl;
    const r = await biliGet(subUrl, "https://www.bilibili.com/video/");
    return sendJson(res, 200, { json: r.json, cookies: cookiesArray() });
  }

  if (req.method === "GET" && url.pathname === "/api/youtube/fetch") {
    const rawUrl = p.get("url") || "";
    if (!rawUrl) return sendJson(res, 400, { error: "缺少 YouTube 链接" });
    try {
      const data = await fetchYoutubeSubtitle(rawUrl);
      return sendJson(res, 200, data);
    } catch (e) {
      let msg = String(e.message || e);
      if (/rate-limiting|rate limit|too many request/i.test(msg))
        msg = "YouTube 暂时限制了本服务器访问，请稍后再试（三道通道均已尝试）";
      else if (/not available.*language|language.*not available/i.test(msg))
        msg = "该视频没有所选语言的字幕";
      else if (/no captions|no transcript|not available|disabled/i.test(msg))
        msg = "该视频没有可用字幕（或无字幕权限）";
      else if (/no longer available|video not available|unavailable|removed/i.test(msg))
        msg = "该视频不可用、已被删除，或受地区/年龄限制（请确认手机能否正常播放）";
      else if (/not a valid youtube/i.test(msg))
        msg = "无法识别的 YouTube 链接";
      else if (/empty transcript/i.test(msg))
        msg = "字幕内容为空（视频可能受区域或年龄限制）";
      else if (/fetch failed/i.test(msg))
        msg = "服务器访问 YouTube 失败（网络波动），请稍后再试";
      else if (msg.length > 300) msg = msg.slice(0, 300);
      return sendJson(res, 200, {
        error: msg,
        videoId: "",
        title: "",
        lang: "",
        langName: "",
        segments: [],
      });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/youtube/diag") {
    const rawUrl = p.get("url") || "";
    if (!rawUrl) return sendJson(res, 400, { error: "缺少 YouTube 链接" });
    try {
      const data = await diagYoutube(rawUrl);
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 200, { error: String(e.message || e) });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/youtube/probe") {
    const rawUrl = p.get("url") || "";
    if (!rawUrl) return sendJson(res, 400, { error: "缺少 YouTube 链接" });
    const videoId = extractYoutubeId(rawUrl);
    if (!videoId) return sendJson(res, 200, { ok: false, error: "无法识别视频 ID" });
    try {
      const data = await Promise.race([
        fetchYtSubtitleInnertube(rawUrl, videoId),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("安卓直连通道超时 60s")), 60000)
        ),
      ]);
      return sendJson(res, 200, {
        ok: true,
        videoId,
        title: data.title,
        lang: data.lang,
        langName: data.langName,
        segments: data.segments.length,
      });
    } catch (e) {
      return sendJson(res, 200, {
        ok: false,
        error: String((e && e.message) || e).slice(0, 400),
      });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/ai/chat") {
    const apiKey = String(body.apiKey || "").trim() || serverConfig.deepseekApiKey || "";
    const user = String(body.user || "");
    if (!apiKey) return sendJson(res, 400, { error: "缺少 DeepSeek API Key" });
    if (!user) return sendJson(res, 400, { error: "缺少对话内容" });
    const requestId = String(body.requestId || "");
    const controller = new AbortController();
    if (requestId) activeAIRequests.set(requestId, controller);
    const timer = setTimeout(() => controller.abort(), 600 * 1000);
    try {
      const resp = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: body.model || "deepseek-chat",
          messages: [
            { role: "system", content: String(body.system || "") },
            { role: "user", content: user },
          ],
          max_tokens: Number(body.maxTokens) || 8000,
          temperature: body.temperature === undefined ? 0.7 : Number(body.temperature),
          stream: false,
        }),
        signal: controller.signal,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg =
          (data.error && data.error.message) ||
          JSON.stringify(data).slice(0, 300) ||
          `HTTP ${resp.status}`;
        return sendJson(res, resp.status, { error: msg });
      }
      const content = (data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : ""
      ).trim();
      return sendJson(res, 200, { content });
    } catch (e) {
      if (e.name === "AbortError") {
        return sendJson(res, 499, { error: "请求已取消" });
      }
      return sendJson(res, 502, {
        error: e.name === "AbortError" ? "请求超时（10 分钟）" : String(e.message || e),
      });
    } finally {
      clearTimeout(timer);
      if (requestId) activeAIRequests.delete(requestId);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/ai/cancel") {
    const requestId = String(body.requestId || "");
    const controller = activeAIRequests.get(requestId);
    if (controller) controller.abort();
    return sendJson(res, 200, { ok: true, cancelled: !!controller });
  }

  return sendJson(res, 404, { error: "接口不存在" });
}

// ---------------------------------------------------------------------------
// 静态文件
// ---------------------------------------------------------------------------
function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (_) {
    pathname = "/";
  }
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("404 Not Found");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(buf);
  });
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      if (
        url.pathname !== "/api/health" &&
        url.pathname !== "/api/youtube/diag" &&
        url.pathname !== "/api/youtube/probe" &&
        serverConfig.accessToken
      ) {
        const token = String(req.headers["x-access-token"] || "");
        if (token !== serverConfig.accessToken) {
          return sendJson(res, 401, { error: "访问口令错误，请在「设置」页填写正确的访问口令" });
        }
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        return await handleApi(req, res, url, body);
      }
      return await handleApi(req, res, url, {});
    }
    return serveStatic(req, res, url);
  } catch (e) {
    return sendJson(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, BIND_HOST, () => {
  console.log(`biliSub Web 已启动：http://127.0.0.1:${PORT}`);
  console.log("按 Ctrl+C 停止服务。");
});
