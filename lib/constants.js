// 运行时常量：端口、目录、UA、MIME、WBI 表、搜索源
const path = require("path");

// 入口 server.js 位于项目根，lib/ 在其下
const PORT = Number(process.env.PORT || 8324);
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const CONFIG_PATH = path.join(__dirname, "..", "server-config.json");
const BIND_HOST = process.env.BIND_HOST || "127.0.0.1";

const BILI_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const ARTICLE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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

// WBI 签名置换表（B 站标准实现）
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

// 议题成文：SearXNG 公共实例列表
const SEARX_INSTANCES = [
  "https://searx.be",
  "https://search.inetol.net",
  "https://searx.tiekoetter.com",
  "https://opnxng.com",
  "https://search.bus-hit.me",
];

module.exports = {
  PORT,
  PUBLIC_DIR,
  CONFIG_PATH,
  BIND_HOST,
  BILI_UA,
  ARTICLE_UA,
  MIME,
  MIXIN_KEY_ENC_TAB,
  FALLBACK_WBI_KEYS,
  SEARX_INSTANCES,
};
