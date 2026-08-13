# biliSub Web

B 站字幕下载 + AI 议题成文网页版（后续可打包成安卓 App）：

- 扫码登录 B 站（仅下载 B 站字幕需要），Cookie 只保存在本机
- 粘贴 B 站链接下载字幕（TXT / SRT / ASS / VTT / JSON / LRC）
- 议题成文：输入一个议题，AI 自动规划大纲、搜索公开资料、分章写作并审校，生成 3000/6000/10000 字长文（带编号引用与参考资料），保存后可直接阅读
- 字幕语言自动选择：中文 > 英文 > 其他（只导出一条）
- 文件管理：导入、搜索、阅读、重命名、删除、导出
- 集成阅读器：TXT / Markdown 阅读，字号调节、夜间模式、记住阅读位置
- AI 功能：字幕润色（transcript-polisher）、生成科普文章（science-writing），调用 DeepSeek

## 运行

需要电脑已安装 Node.js（本机已安装）。

在 `biliSub-web` 目录下打开终端，执行：

```powershell
node server.js
```

然后用浏览器打开：<http://127.0.0.1:8324>

## 使用提示

1. 下载 B 站字幕前，先点右上角「扫码登录」用 B 站 App 扫码。
2. 在「下载」页粘贴链接（每行一个，支持 B 站），默认只导出 TXT。
3. 在「生成文章」页输入一个议题，选择篇幅和风格，AI 会自动搜索资料、分章写作并审校，完成后自动保存并打开阅读。
4. 下载完成后到「文档」页查看文件，可点击阅读。
5. 使用「润色」「生成文章」或「议题成文」前，先在「设置」页填写 DeepSeek API Key（云端部署时服务端已配置可跳过）。
6. 所有数据保存在浏览器本地（IndexedDB / localStorage），关闭页面不丢失；清除浏览器数据会清空。

## 项目结构（v7 模块化）

```
biliSub-cloud-package/
├── server.js            # 入口：HTTP 服务 + 静态文件 + 请求分发
├── lib/                 # 后端模块（CommonJS）
│   ├── constants.js     #   运行时常量
│   ├── config.js        #   配置加载（环境变量 + server-config.json）
│   ├── utils.js         #   通用工具
│   ├── cookie-jar.js    #   B 站 Cookie 罐
│   ├── bili-client.js   #   B 站 HTTP 客户端 + WBI 签名
│   ├── deepseek.js      #   DeepSeek 对话封装
│   ├── search.js        #   免费搜索源聚合
│   ├── article-engine.js #  议题成文引擎
│   └── routes.js        #   API 路由
├── sync-to-git.ps1      # 同步源码到 Git 仓库并提交/推送的脚本
└── public/
    ├── index.html
    ├── css/style.css
    ├── js/              # 前端模块（IIFE + window.ui 命名空间）
    │   ├── storage.js / api.js / ai.js   # 数据层 / 通信层 / AI 功能层
    │   ├── core.js      # 状态机 + 工具 + 视图切换
    │   ├── login.js / download.js / docs.js / reader.js / ai-modal.js / article.js
    │   └── app.js       # 入口（初始化 + 事件绑定）
    ├── libs/            # marked / qrcode（浏览器版）
    └── skills/          # AI 提示词（transcript-polisher / science-writing）
```

## 开发工作流

修改代码在 `biliSub-cloud-package`，同步到 Git 仓库用脚本：

```powershell
.\sync-to-git.ps1                              # 仅同步文件
.\sync-to-git.ps1 -Message "更新说明" -Push     # 同步 + commit + push（触发 Render 部署）
```

## 说明

- 本机服务 `server.js` 只用于电脑浏览器测试阶段；后续打包安卓版时，会改为在 App 内直接调用接口。
- AI 技能提示词来自两个 MIT 开源项目：
  - transcript-polisher（rookie-ricardo/erduo-skills）
  - science-writing（Ariclk-L/science-writing-skill）
- 「议题成文」融合 STORM（斯坦福）与 GPT Researcher 的方法：多视角研究问题 → 免费搜索源收集资料 → 分章写作（带编号引用）→ 导语 → 审校修订；搜索使用维基百科、Bing、DuckDuckGo 与 SearXNG 公共实例等免费源，无需额外注册
