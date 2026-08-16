// biliSub Web 本地服务入口
// 服务端基于 Node 原生 http；B 站与 DeepSeek 由本服务代理访问，
// B 站登录 Cookie 保存在浏览器 localStorage，并在每次请求时同步到本服务。
//
// 模块结构（lib/）：
//   constants.js      运行时常量（端口/目录/UA/MIME/WBI 表/搜索源）
//   config.js         配置加载（环境变量 + server-config.json）
//   utils.js          通用工具（HTML 解码/文本提取/网络抓取/请求体读取/响应/链接解析）
//   cookie-jar.js     B 站 Cookie 罐（内存）
//   bili-client.js    B 站 HTTP 客户端 + WBI 签名
//   deepseek.js       DeepSeek 对话封装
//   search.js         免费搜索源聚合（维基/DuckDuckGo/Bing/SearXNG）
//   article-engine.js 议题成文引擎（规划/搜索/写作/导语/审校/修订）
//   routes.js         API 路由
const http = require("http");
const fs = require("fs");
const path = require("path");
const { PORT, PUBLIC_DIR, BIND_HOST, MIME } = require("./lib/constants");
const { serverConfig } = require("./lib/config");
const { handleApi } = require("./lib/routes");
const { sendJson, readBody } = require("./lib/utils");
const automation = require("./lib/automation");

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      if (
        url.pathname !== "/api/health" &&
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
  automation.start();
});
