# Video Dialogue Studio（译谈）

把 YouTube 视频整理成中文多人对话文章，并为每个章节生成 5W1H 总结。

在线地址：<https://dialogue.viagoing.com>

## 功能

- 输入 YouTube 链接，流式生成中文对话文章。
- 可选填写一段自然语言要求，限定任务类型、输出风格、目标受众和约束条件，最多 1200 字。
- 文章按章节展示，每章可单独生成 5W1H 总结。
- 5W1H 请求只提交生成记录 ID 和章节序号，不会由前端重新提交整篇文章。
- 优先读取公开字幕；没有字幕时，自动提取音频并交给 Gemini 转写。
- 一台电脑启动共享字幕助手后，电脑和手机访问同一网站即可共用，不需要配对或额外配置。
- 支持 Cloudflare Workers 一键部署。

## 使用方法

### 1. 启动共享字幕助手

YouTube 经常限制云服务器访问。为了稳定获取字幕，需要在一台可以正常访问 YouTube 的电脑上保持助手运行。所有网站访客会共用这一个助手。

环境要求：

- Node.js 22 或更高版本
- `yt-dlp`
- `ffmpeg`

安装依赖并准备配置：

```bash
npm install
copy .dev.vars.example .dev.vars
```

在 `.dev.vars` 中填写 `GEMINI_API_KEY`，然后运行：

```bash
npm run helper
```

保持终端窗口开启。看到“本机助手已连接 Cloudflare 字幕中继”后，直接打开 <https://dialogue.viagoing.com>。手机访问同一网址也会自动使用这个助手。

如果视频需要登录状态，可以读取本机浏览器 Cookie：

```bash
npm run helper:chrome
# 或
npm run helper:edge
```

Cookie 只由本机 `yt-dlp` 读取，不会上传到网页或保存到 Cloudflare。

### 2. 生成文章

1. 粘贴 YouTube 视频链接。
2. 按需填写生成要求；不填写也可以。
3. 点击生成，等待字幕获取、音频转写和文章生成。
4. 文章生成后，点击章节下方的“5W1H 总结”。

没有公开字幕的视频需要下载并压缩音频，通常比有字幕的视频多等待 1～3 分钟。

## 本地开发

```bash
npm install
copy .dev.vars.example .dev.vars
npm run dev
```

另开一个终端启动字幕助手：

```bash
npm run helper -- --no-open
```

Wrangler 默认地址为 <http://localhost:8787>。

`.dev.vars` 示例：

```dotenv
GEMINI_API_KEY=你的_Gemini_API_Key
GEMINI_MODEL=gemini-flash-latest
WEBSHARE_PROXY_URLS=http://用户名:密码@IP:端口,http://用户名:密码@IP:端口
```

| 配置 | 必填 | 说明 |
| --- | --- | --- |
| `GEMINI_API_KEY` | 是 | 文章生成、5W1H 和无字幕音频转写 |
| `GEMINI_MODEL` | 否 | 默认 `gemini-flash-latest` |
| `WEBSHARE_PROXY_URLS` | 否 | 云端直连 YouTube 失败后的代理池回退 |

`.dev.vars` 已被 Git 忽略，不要把密钥或代理密码提交到仓库。

## 部署

首次使用先登录 Cloudflare：

```bash
npx wrangler login
```

以后每次修改代码后运行：

```bash
npm run deploy:one-click
```

脚本会依次执行类型检查、测试和 Wrangler 部署。域名配置在 `wrangler.jsonc`；如果更换域名，还需同步修改 `public/app.js` 和 `scripts/youtube-helper.mjs` 中的线上地址。

部署完成后，重新启动 `npm run helper`，使本机助手连接到最新 Worker。

## 工作流程

```text
浏览器 / 手机
    │
    ├─ Cloudflare Worker ─ Gemini：生成文章
    │        │
    │        ├─ Durable Object：保存生成上下文、生成 5W1H
    │        │
    │        └─ 共享字幕中继 ─ 本机助手 ─ yt-dlp：读取字幕
    │                                      └─ ffmpeg + Gemini：无字幕音频转写
    │
    └─ 助手离线时：Worker 直连 YouTube，再回退 Webshare 代理池
```

生成上下文由服务端保存 24 小时。点击章节 5W1H 时，浏览器只发送 `generationId` 和 `sectionIndex`，由服务端读取对应章节内容。

## 项目结构

```text
.
├─ public/
│  ├─ index.html              页面结构
│  ├─ app.js                  页面交互、流式输出和共享助手检测
│  └─ styles.css              页面样式
├─ scripts/
│  ├─ deploy.mjs              一键部署脚本
│  ├─ youtube-helper.mjs      本机 HTTP 服务和 Cloudflare 字幕中继
│  └─ youtube-helper-lib.mjs  yt-dlp、ffmpeg 和字幕处理
├─ src/
│  ├─ index.ts                Worker 路由、生成接口和共享助手接口
│  ├─ context.ts              Durable Object 上下文及 WebSocket 中继
│  ├─ gemini.ts               Gemini 请求和流式解析
│  ├─ youtube.ts              YouTube 字幕获取
│  ├─ proxy.ts                Webshare 代理池回退
│  ├─ proxy-http.ts           Cloudflare TCP HTTP 代理客户端
│  ├─ local-transcript.ts     本机字幕结果校验
│  ├─ sections.ts             章节解析
│  └─ types.ts                类型定义
├─ tests/                     单元测试
├─ wrangler.jsonc             Cloudflare Worker 配置
├─ package.json               命令和依赖
└─ .dev.vars                  本地密钥，不提交 Git
```

## 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/generate` | 获取字幕并流式生成文章 |
| `POST` | `/api/summary` | 根据服务端上下文生成章节 5W1H |
| `GET` | `/api/helper/status` | 查询共享字幕助手状态 |
| `POST` | `/api/helper/extract` | 通过共享助手提取字幕或音频 |
| `GET` | `/api/helper/connect` | 本机助手连接 WebSocket 中继 |
| `GET` | `/api/health` | 服务健康检查 |

## 检查与排错

运行全部检查：

```bash
npm run check
```

单独测试字幕或无字幕音频流程：

```bash
node scripts/youtube-helper.mjs --probe "YouTube 链接"
node scripts/youtube-helper.mjs --probe-audio "YouTube 链接"
```

如果页面显示“共享字幕助手未启动”，检查：

1. `npm run helper` 的窗口是否仍在运行。
2. `.dev.vars` 中的 `GEMINI_API_KEY` 是否与已部署到 Cloudflare 的密钥一致。
3. 终端是否出现“本机助手已连接 Cloudflare 字幕中继”。
4. `https://dialogue.viagoing.com/api/health` 中的 `helperConnected` 是否为 `true`。
