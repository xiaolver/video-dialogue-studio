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

## 一键部署与后续更新

项目默认发布到 `https://dialogue.viagoing.com`。首次部署前需要完成三项一次性准备：

1. 安装依赖：`npm install`。
2. 将 `.dev.vars.example` 复制为 `.dev.vars`，填入 `GEMINI_API_KEY`。如需处理 YouTube 验证码，再填入 Webshare 的 `WEBSHARE_PROXY_URL`。`.dev.vars` 已被 Git 忽略。
3. 运行 `npx wrangler login` 登录 Cloudflare。新账户还需打开 [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)，按页面提示注册一次 `workers.dev` 子域名；这是 Cloudflare 创建 Worker 的账户级前置条件，即使最终只使用自定义域名也需要完成一次。

以后首次发布或修改代码后，都只需要运行：

```bash
npm run deploy:one-click
```

脚本会依次执行：

- 检查 Cloudflare 登录状态，未登录时启动 OAuth；
- 上传 Worker、静态资源和 Durable Object 迁移；
- 从本地 `.dev.vars` 安全读取 Key，更新线上 `GEMINI_API_KEY`；若已配置代理，同时更新 `WEBSHARE_PROXY_URL` Secret；
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
│  └─ deploy.mjs           # 登录、发布、Secret 和健康检查一键脚本
├─ src/
│  ├─ index.ts             # Worker 入口、API 路由与流式响应
│  ├─ youtube.ts           # 视频 ID、YouTube 字幕和示例回退
│  ├─ proxy.ts             # TCP Socket、HTTP CONNECT 与隧道内 TLS 请求
│  ├─ proxy-http.ts        # Webshare 配置和原始 HTTP 响应解析
│  ├─ gemini.ts            # Gemini 流式文章与结构化总结
│  ├─ context.ts           # Durable Object 上下文、缓存与定时清理
│  ├─ sections.ts          # Markdown 章节解析
│  └─ types.ts             # 环境绑定与业务类型
├─ tests/                  # 视频、章节和代理 HTTP 解析单元测试
├─ .dev.vars.example       # 本地密钥模板
├─ wrangler.jsonc          # Worker、资源绑定、迁移和自定义域名
├─ package.json            # 开发、测试和一键部署命令
└─ tsconfig.json           # TypeScript 严格模式配置
```

## 实现说明

### YouTube 字幕

服务端校验并提取 11 位视频 ID，请求 YouTube watch 页面中的 `ytInitialPlayerResponse`，优先选择人工中文字幕，其次是英文字幕与自动字幕。字幕轨道以 JSON3 格式读取，合并片段并保留 `[mm:ss]` 时间戳。输入、字幕长度都有限制，避免异常请求拖垮 Worker。

YouTube 可能对数据中心 IP 返回验证码。现在的处理顺序是：先用 Worker 原生 `fetch` 直连；遇到验证码、字幕轨道缺失或请求失败时，若配置了 Webshare，则自动通过 Cloudflare Worker TCP Socket 重试；代理仍失败才返回明确错误。对题目指定的 `xRh2sVcNXQ8` 仍保留演示字幕作为最后回退，不会悄悄为其他视频生成无来源内容。

代理使用 HTTP CONNECT，而不是把普通 `fetch` 指向代理：Worker 先用 `connect()` 建立到 Webshare 节点的 TCP 连接，发送带 Basic 认证的 `CONNECT youtube-host:443`，收到 200 后通过 `startTls({ expectedServerHostname })` 在隧道内完成 YouTube TLS，再发送原始 HTTP/1.1 请求。重定向目标只允许 YouTube、YouTube NoCookie 和 GoogleVideo 域名，响应大小限制为 8 MiB，因此这不是一个可被外部滥用的开放代理。

在 `.dev.vars` 中任选一种 Webshare HTTP 代理格式：

```dotenv
# 标准 URL 格式（推荐）
WEBSHARE_PROXY_URL="http://username:password@proxy-host:proxy-port"

# 或 Webshare 下载列表常见格式
# WEBSHARE_PROXY_URL="proxy-host:proxy-port:username:password"
```

建议选择 Webshare 的用户名/密码认证 HTTP 代理，不要使用 IP 白名单认证，因为 Worker 出口 IP 不固定。代理密码只保存在本地 `.dev.vars` 和 Cloudflare Worker Secret 中。配置后运行 `npm run deploy:one-click`，健康检查返回的 `youtubeProxy` 应为 `true`。

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
npm run deploy:one-click
```

`wrangler.jsonc` 已声明静态资源绑定和 Durable Object 的首次迁移。部署后可用以下接口做健康检查：

```bash
curl https://<your-worker>.workers.dev/api/health
```

## API

- `POST /api/generate` — `{ videoUrl, instruction? }`，返回 NDJSON 流。
- `POST /api/summary` — `{ generationId, sectionIndex }`，返回固定结构的 5W1H。
- `GET /api/health` — 返回运行模式（`gemini` 或 `demo`）及 `youtubeProxy` 是否启用。
