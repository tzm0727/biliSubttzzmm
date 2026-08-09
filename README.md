# biliSub Web

B 站字幕下载网页版（后续可打包成安卓 App）：

- 扫码登录 B 站（仅下载 B 站字幕需要），Cookie 只保存在本机
- 粘贴 B 站链接下载字幕（TXT / SRT / ASS / VTT / JSON / LRC）
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
3. 下载完成后到「文档」页查看文件，可点击阅读。
4. 使用「润色」或「生成文章」前，先在「设置」页填写 DeepSeek API Key。
5. 所有数据保存在浏览器本地（IndexedDB / localStorage），关闭页面不丢失；清除浏览器数据会清空。

## 说明

- 本机服务 `server.js` 只用于电脑浏览器测试阶段；后续打包安卓版时，会改为在 App 内直接调用接口。
- AI 技能提示词来自两个 MIT 开源项目：
  - transcript-polisher（rookie-ricardo/erduo-skills）
  - science-writing（Ariclk-L/science-writing-skill）
