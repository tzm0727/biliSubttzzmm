// 服务端配置：环境变量（优先） + server-config.json（本地可选）
const fs = require("fs");
const { CONFIG_PATH } = require("./constants");

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

module.exports = { serverConfig, loadServerConfig };
