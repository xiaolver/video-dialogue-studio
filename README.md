# 译谈 · Video Dialogue Studio

把带公开字幕的 YouTube 视频整理成结构清晰的中文对话文章。主文章通过 Gemini API 流式生成，浏览器会边接收边渲染；每个章节可继续生成结合完整视频上下文的 5W1H 总结。

## 本地运行

需要 Node.js 20+。

```bash
npm install
Copy-Item .dev.vars.example .dev.vars
# 编辑 .dev.vars，填入 Google AI Studio 的 GEMINI_API_KEY
npm run dev
```

打开 Wrangler 输出的本地地址。若不配置 `GEMINI_API_KEY`，应用会进入演示模式；文档指定的示例视频仍可走完流式文章和 5W1H 全流程。

## 本机字幕助手（方案二，推荐）

YouTube 经常拦截 Cloudflare、免费数据中心代理等机房 IP。方案二让网页调用只监听在本机 `127.0.0.1` 的小助手，由本机家庭网络运行 `yt-dlp` 读取公开字幕；助手随后只把字幕文本交给 Cloudflare/Gemini。账号密码、Webshare 凭据和浏览器 Cookie 都不会上传到 Worker。

首次使用请确认已安装 `yt-dlp`：

```powershell
yt-dlp --version
# 若未安装：
winget install yt-dlp.yt-dlp
```

以后只需在项目目录执行一条命令，并保持该终端窗口开启：

```powershell
npm run helper
```

再打开 `https://dialogue.viagoing.com`。视频输入框下方显示“本机助手已连接（家庭网络）”后即可生成。网页会优先走本机助手；助手未运行或提取失败时，才回退到 Worker 直连和 Webshare 代理池。

对于必须登录才能观看、且你有权访问的视频，可以选择读取本机浏览器登录态：

```powershell
npm run helper:chrome
# 或
npm run helper:edge
```

这会让 `yt-dlp` 在本机读取对应浏览器 Cookie，但 Cookie 始终留在本机，接口响应中只有字幕。建议使用普通公开字幕模式；不要把 Cookie 文件、账号密码或浏览器配置上传到 Worker/Git。若浏览器拦截 HTTPS 页面访问回环地址，请允许该站点访问本地网络，然后点击“重新检测”。助手健康检查地址是 `http://127.0.0.1:3210/health`。

## 一键部署与后续更新

项目默认发布到 `https://dialogue.viagoing.com`。首次部署前需要完成三项一次性准备：

1. 安装依赖：`npm install`。
2. 将 `.dev.vars.example` 复制为 `.dev.vars`，填入 `GEMINI_API_KEY`。如需处理 YouTube 验证码，再填入 Webshare 的 `WEBSHARE_PROXY_URLS`。`.dev.vars` 已被 Git 忽略。
3. 运行 `npx wrangler login` 登录 Cloudflare。新账户还需打开 [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)，按页面提示注册一次 `workers.dev` 子域名；这是 Cloudflare 创建 Worker 的账户级前置条件，即使最终只使用自定义域名也需要完成一次。

以后首次发布或修改代码后，都只需要运行：

```bash
npm run deploy:one-click
```

脚本会依次执行：

- 检查 Cloudflare 登录状态，未登录时启动 OAuth；
- 上传 Worker、静态资源和 Durable Object 迁移；
- 从本地 `.dev.vars` 安全读取 Key，更新线上 `GEMINI_API_KEY`；若已配置代理池，同时更新 `WEBSHARE_PROXY_URLS` Secret；
- 请求 `https://dialogue.viagoing.com/api/health`，确认公开地址、Gemini 模式和代理配置都已生效。
- 对 Cloudflare API 的偶发连接超时自动重试；只有明确返回未登录时才重新启动 OAuth。

密钥只通过标准输入传给 Wrangler，不会出现在命令参数、部署配置或 Git 仓库中。如果要更换域名，同时修改 `wrangler.jsonc` 中的 `routes[0].pattern` 和 `scripts/deploy.mjs` 中的 `publicUrl`。

## 代码结构

```text
.
├─ public/                 # 无构建依赖的响应式前端
│  ├─ index.html           # 页面结构与输入/结果区域
│  ├─ app.js               # NDJSON 流消费、Markdown 与 5W1H 交互
│  └─ styles.css           # 桌面/移动端视觉样式
├─ scripts/
│  ├─ deploy.mjs           # 登录、发布、Secret 和健康检查一键脚本
│  ├─ youtube-helper.mjs   # 仅监听 127.0.0.1 的字幕助手 HTTP 服务
│  └─ youtube-helper-lib.mjs # yt-dlp 调用、字幕选择与 JSON3/VTT 解析
├─ src/
│  ├─ index.ts             # Worker 入口、API 路由与流式响应
│  ├─ local-transcript.ts  # 本机字幕载荷的服务端二次校验
│  ├─ youtube.ts           # 视频 ID、YouTube 字幕和示例回退
│  ├─ proxy.ts             # TCP Socket 与 Webshare 绝对 URL 代理请求
│  ├─ proxy-http.ts        # Webshare 配置和原始 HTTP 响应解析
│  ├─ gemini.ts            # Gemini 流式文章与结构化总结
│  ├─ context.ts           # Durable Object 上下文、缓存与定时清理
│  ├─ sections.ts          # Markdown 章节解析
│  └─ types.ts             # 环境绑定与业务类型
├─ tests/                  # 视频、章节、代理和本机字幕助手单元测试
├─ .dev.vars.example       # 本地密钥模板
├─ wrangler.jsonc          # Worker、资源绑定、迁移和自定义域名
├─ package.json            # 开发、测试和一键部署命令
└─ tsconfig.json           # TypeScript 严格模式配置
```

## 实现说明

### YouTube 字幕

前端首先检测 `http://127.0.0.1:3210`。助手可用时，由本机 `yt-dlp` 获取元数据，优先选择人工中文字幕，其次为人工英文、自动中文、自动英文和其他公开字幕，并优先解析 JSON3、回退 VTT。助手只接受允许来源的 CORS 请求、仅绑定回环地址、限制请求体与执行时间。Worker 会再次校验视频 ID、字幕来源和文本长度，拒绝与当前视频不匹配的上下文。

服务端校验并提取 11 位视频 ID，请求 YouTube watch 页面中的 `ytInitialPlayerResponse`，优先选择人工中文字幕，其次是英文字幕与自动字幕。字幕轨道以 JSON3 格式读取，合并片段并保留 `[mm:ss]` 时间戳。输入、字幕长度都有限制，避免异常请求拖垮 Worker。

YouTube 可能对数据中心 IP 返回验证码。现在的处理顺序是：先用 Worker 原生 `fetch` 直连；遇到验证码、字幕轨道缺失或请求失败时，若配置了 Webshare，则从代理池随机起点开始，通过 Cloudflare Worker TCP Socket 依次重试最多 5 个节点。代理取得 watch 页面后，会先按人工/自动字幕类型生成 Android Innertube `get_transcript` 参数，尝试读取文字稿面板数据；失败后再依次尝试 Worker 直连和当前代理的 `timedtext` 字幕轨道。代理池仍失败才返回包含 HTTP 状态的明确错误。对题目指定的 `xRh2sVcNXQ8` 仍保留演示字幕作为最后回退，不会悄悄为其他视频生成无来源内容。

代理不依赖 Worker `fetch`：Worker 用 `connect()` 建立到 Webshare 节点的 TCP 连接，携带 Basic 认证发送绝对 HTTPS URL 的原始 HTTP/1.1 请求，由 Webshare 代理端完成目标站 TLS。之所以不在 CONNECT 隧道后调用 `startTls()`，是因为 Cloudflare 当前运行时尚不能可靠地为这类隧道改写目标 SNI，实际会触发 `TLS Handshake Failed`。重定向目标只允许 YouTube、YouTube NoCookie 和 GoogleVideo 域名，响应大小限制为 8 MiB，因此这不是一个可被外部滥用的开放代理。

在 `.dev.vars` 中配置一条或多条 Webshare HTTP 代理，多条以英文逗号分隔：

```dotenv
# Webshare 下载列表格式；可继续追加更多节点
WEBSHARE_PROXY_URLS="proxy-host:proxy-port:username:password,proxy-host-2:proxy-port:username:password"

# 兼容旧版单代理标准 URL
# WEBSHARE_PROXY_URL="http://username:password@proxy-host:proxy-port"
```

建议选择 Webshare 的用户名/密码认证 HTTP 代理，不要使用 IP 白名单认证，因为 Worker 出口 IP 不固定。代理端口必须避开 `25`、`80` 和 `443`；例如 Webshare 轮换端点常用的 `75`，或代理列表分配的其他高位端口。免费数据中心代理是共享 IP，可能全部被 YouTube 字幕接口返回 429；需要稳定运行时应使用未被限流的静态住宅代理或轮换住宅代理。代理密码只保存在本地 `.dev.vars` 和 Cloudflare Worker Secret 中。配置后运行 `npm run deploy:one-click`，健康检查返回的 `youtubeProxy` 应为 `true`，`youtubeProxyCount` 应等于配置的节点数；这只表示配置生效，不代表代理 IP 已通过 YouTube 风控。

### Gemini 流式输出

`POST /api/generate` 先取得字幕，再调用 Gemini `streamGenerateContent?alt=sse`。Worker 逐个解析上游 SSE 文本增量，并转换为 NDJSON 发送给浏览器；前端用 `ReadableStream` 增量解码和渲染 Markdown，因此第一批文字到达即可阅读，无需等待全文。

模型默认为 Google 官方稳定别名 `gemini-flash-latest`，可通过 `GEMINI_MODEL` 调整。使用稳定别名可以避免固定版本退役后新账户无法调用；API Key 仅保存在 Worker Secret 中，不会进入浏览器或仓库。

### 用户生成要求

可选要求会放入独立的 `<user_preference>` 边界，并明确限定为任务类型、输出风格、目标受众和篇幅/格式约束。系统提示同时把字幕和用户要求视为不可信数据，避免字幕中的提示注入改变核心任务。服务端限制为 1200 字。

### 章节级 5W1H

每次生成都会创建随机 `generationId`，并把字幕、用户要求、完整文章及服务端解析出的章节保存到该 ID 对应的 Cloudflare Durable Object。文章完成后，浏览器仅保留正文用于展示。

点击章节的 5W1H 时，前端只提交：

```json
{ "generationId": "…", "sectionIndex": 1 }
```

Durable Object 在服务端读取完整字幕和文章、校验章节编号，再要求 Gemini 按固定 JSON Schema 返回 `who / what / when / where / why / how`。结果按章节缓存，重复点击不会重复消耗模型额度。前端没有重新提交文章内容。元数据、字幕、文章和章节会拆分存储以避开单值大小上限，并在 24 小时后由 alarm 自动清理。

### 工程取舍与亮点

- 单 Worker 承载静态资源、API 和 Durable Object，部署面小，没有额外数据库。
- 真实 Gemini 与无 Key 演示模式走同一套流协议，便于本地审阅和故障演示。
- 上游断开后生成任务仍通过 `waitUntil` 完成并保存上下文；客户端断开不会让服务端留下半成品状态。
- 只实现所需的安全 Markdown 子集，所有模型内容先做 HTML 转义，避免把模型输出当作可信 HTML。
- 移动端排版、减少动画偏好、加载/错误/回退状态均有独立设计。

## 测试与部署

```bash
npm run check
node scripts/youtube-helper.mjs --probe "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
npm run deploy:one-click
```

`wrangler.jsonc` 已声明静态资源绑定和 Durable Object 的首次迁移。部署后可用以下接口做健康检查：

```bash
curl https://<your-worker>.workers.dev/api/health
```

## API

- `POST /api/generate` — `{ videoUrl, instruction?, localTranscript? }`，返回 NDJSON 流；`localTranscript` 由本机助手生成并经 Worker 二次校验。
- `POST /api/summary` — `{ generationId, sectionIndex }`，返回固定结构的 5W1H。
- `GET /api/health` — 返回运行模式（`gemini` 或 `demo`）、`youtubeProxy` 是否启用及代理节点数。
