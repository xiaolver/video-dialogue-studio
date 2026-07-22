# Video Dialogue Studio（译谈）

输入 YouTube 链接，将视频内容整理为中文多人对话文章，并支持章节级 5W1H 总结。在线体验：<https://dialogue.viagoing.com>。安装、配置、部署和排错见 [完整使用说明](docs/USAGE.md)。

## 1. 如何获取和处理 YouTube 字幕

系统优先使用本机字幕助手。助手通过 `yt-dlp` 读取视频元数据，在人工字幕和自动字幕中按“中文、英文、其他语言”的顺序选择轨道，并优先使用 JSON3，其次使用 VTT。字幕解析后会去除标签、合并空白、过滤连续重复内容，并统一整理为带 `[mm:ss]` 时间戳的文本。

如果视频没有公开字幕，助手会下载最佳音频，再用 `ffmpeg` 压缩为 16 kHz、单声道、24 kbps 的 MP3，交给 Gemini 忠实转写。若本机助手不可用，系统依次回退到 Cloudflare Worker 直连 YouTube、Webshare 代理池；云端回退只能读取公开字幕，不能完成无字幕音频转写。

## 2. 如何调用 Gemini 并实现流式输出

Worker 将视频标题、字幕语言、字幕正文和生成要求组成提示词，请求 Gemini 的 `streamGenerateContent?alt=sse` 接口。服务端逐条解析 Gemini 返回的 SSE，把结果转换成 `meta`、`delta`、`done`、`error` 四类 NDJSON 事件，并通过 `ReadableStream` 立即返回浏览器。

前端使用 `response.body.getReader()` 持续读取增量内容，配合 `TextDecoder` 拼接文本并实时渲染 Markdown，因此用户不必等待整篇文章生成完毕就能看到输出。

## 3. 如何根据用户生成要求影响输出结果

页面允许用户选填最多 1200 字的自然语言要求。该内容作为独立的 `<user_preference>` 区块加入文章生成提示词，只允许影响以下范围：

- 任务类型
- 输出风格
- 目标受众
- 篇幅、格式等约束条件

系统提示词仍固定要求输出中文对话文章、保留字幕中的关键事实且不得杜撰。用户要求与核心任务冲突时忽略冲突部分；字幕中的任何指令只作为素材，不会被当作系统指令执行。

## 4. 如何实现章节级 5W1H 总结

每次文章生成都会创建一个 `generationId`。Worker 使用 Durable Object 保存本次字幕、完整文章、章节切分结果和生成要求，保存时间为 24 小时。

用户点击某章的 5W1H 按钮时，前端只提交 `generationId` 和 `sectionIndex`，不会重新上传整篇文章。服务端根据这两个字段读取已保存的完整上下文，请求 Gemini 以 JSON Schema 返回 `who`、`what`、`when`、`where`、`why`、`how` 六个字段，并按章节缓存结果，避免重复调用。

## 5. 主要工程取舍和亮点

- **本机提取、云端生成**：Cloudflare 数据中心 IP 容易触发 YouTube 验证，而且 Worker 不能直接运行 `yt-dlp` 和 `ffmpeg`。因此由本机处理媒体，Worker 负责中继、状态保存和 Gemini 调用。
- **无需开放本机端口**：助手主动建立到 Cloudflare 的加密 WebSocket，由 Durable Object 转发任务；手机和电脑访问同一网站即可共用，不需要公网 IP、端口映射或配对。
- **多级回退**：共享助手失败后自动尝试 Worker 直连和 Webshare TCP 代理池，尽可能提高公开字幕获取成功率。
- **结构化流式协议**：Gemini SSE 在服务端转换成简单的 NDJSON 事件，前端状态清晰，也便于处理错误和完成信号。
- **服务端上下文**：文章和章节保存在 Durable Object，5W1H 请求只传标识符，满足前端不重复提交全文的要求。
- **边界与资源控制**：限制生成要求、字幕和音频大小；临时字幕与音频处理后立即删除；助手任务串行执行，避免少量访客同时请求时占满本机资源。
