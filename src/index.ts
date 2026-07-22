import { streamArticle } from "./gemini";
import { validateLocalTranscript } from "./local-transcript";
import { parseArticleSections } from "./sections";
import type { Env, StoredGeneration, TranscriptResult } from "./types";
import { getYouTubeTranscript, parseYouTubeVideoId, TranscriptError } from "./youtube";

export { GenerationContext } from "./context";

const MAX_INSTRUCTION_LENGTH = 1_200;
const LOCAL_APP_ORIGINS = new Set([
  "http://127.0.0.1:3210",
  "http://localhost:3210",
]);
const HELPER_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function withApiCors(request: Request, response: Response): Response {
  const origin = request.headers.get("Origin");
  if (origin && LOCAL_APP_ORIGINS.has(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Vary", "Origin");
  }
  return response;
}

function apiPreflight(request: Request): Response {
  const origin = request.headers.get("Origin");
  if (!origin || !LOCAL_APP_ORIGINS.has(origin)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  });
}

async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new Error("请求必须使用 JSON。 ");
  return request.json<T>();
}

function errorMessage(error: unknown): string {
  if (error instanceof TranscriptError) return error.message;
  if (error instanceof Error) return error.message;
  return "发生未知错误。";
}

function contextStub(env: Env, generationId: string): DurableObjectStub {
  return env.GENERATION_CONTEXTS.get(env.GENERATION_CONTEXTS.idFromName(generationId));
}

function helperStub(env: Env, token: string): DurableObjectStub {
  return env.GENERATION_CONTEXTS.get(env.GENERATION_CONTEXTS.idFromName(`helper:${token}`));
}

function validHelperToken(value: unknown): value is string {
  return typeof value === "string" && HELPER_TOKEN_PATTERN.test(value);
}

async function handleHelperConnect(request: Request, env: Env): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  if (!validHelperToken(token)) return json({ error: "无效的本机助手配对令牌。" }, 400);
  return helperStub(env, token).fetch("https://context/helper/connect", {
    headers: { Upgrade: request.headers.get("Upgrade") || "" },
  });
}

async function handleHelperStatus(request: Request, env: Env): Promise<Response> {
  let body: { token?: unknown };
  try { body = await readJson(request); } catch (error) { return json({ error: errorMessage(error) }, 400); }
  if (!validHelperToken(body.token)) return json({ error: "无效的本机助手配对令牌。" }, 400);
  return helperStub(env, body.token).fetch("https://context/helper/status");
}

async function handleHelperExtract(request: Request, env: Env): Promise<Response> {
  let body: { token?: unknown; videoUrl?: unknown };
  try { body = await readJson(request); } catch (error) { return json({ error: errorMessage(error) }, 400); }
  if (!validHelperToken(body.token)) return json({ error: "无效的本机助手配对令牌。" }, 400);
  if (typeof body.videoUrl !== "string" || !parseYouTubeVideoId(body.videoUrl)) {
    return json({ error: "请输入有效的 YouTube 视频链接。" }, 400);
  }
  return helperStub(env, body.token).fetch("https://context/helper/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoUrl: body.videoUrl }),
  });
}

async function handleGenerate(request: Request, env: Env, execution: ExecutionContext): Promise<Response> {
  let body: { videoUrl?: string; instruction?: string; localTranscript?: unknown };
  try {
    body = await readJson(request);
  } catch (error) {
    return json({ error: errorMessage(error) }, 400);
  }

  const videoUrl = body.videoUrl?.trim() ?? "";
  const instruction = body.instruction?.trim() ?? "";
  if (!videoUrl || videoUrl.length > 500) return json({ error: "请输入有效的 YouTube 视频链接。" }, 400);
  if (instruction.length > MAX_INSTRUCTION_LENGTH) return json({ error: `生成要求不能超过 ${MAX_INSTRUCTION_LENGTH} 字。` }, 400);

  let transcript: TranscriptResult;
  try {
    transcript = body.localTranscript
      ? validateLocalTranscript(body.localTranscript, videoUrl)
      : await getYouTubeTranscript(videoUrl, env.WEBSHARE_PROXY_URLS || env.WEBSHARE_PROXY_URL);
  } catch (error) {
    return json({ error: errorMessage(error) }, error instanceof TranscriptError && error.code === "INVALID_URL" ? 400 : 422);
  }

  const generationId = crypto.randomUUID();
  const stub = contextStub(env, generationId);
  const generation: StoredGeneration = {
    id: generationId,
    createdAt: new Date().toISOString(),
    status: "generating",
    videoUrl,
    videoId: transcript.videoId,
    videoTitle: transcript.title,
    transcriptLanguage: transcript.language,
    transcriptSource: transcript.source,
    transcript: transcript.text,
    instruction,
    article: "",
    sections: [],
  };
  await stub.fetch("https://context/generation", { method: "PUT", body: JSON.stringify(generation) });

  const encoder = new TextEncoder();
  let outputOpen = true;
  let article = "";
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

  const send = (event: unknown): void => {
    if (!outputOpen || !controllerRef) return;
    try {
      controllerRef.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    } catch {
      outputOpen = false;
    }
  };

  const job = async (): Promise<void> => {
    send({
      type: "meta",
      generationId,
      videoTitle: transcript.title,
      transcriptSource: transcript.source,
      transcriptLanguage: transcript.language,
      provider: env.GEMINI_API_KEY ? "gemini" : "demo",
    });
    try {
      for await (const delta of streamArticle(transcript, instruction, env.GEMINI_API_KEY, env.GEMINI_MODEL)) {
        article += delta;
        send({ type: "delta", text: delta });
      }
      generation.status = "ready";
      generation.article = article;
      generation.sections = parseArticleSections(article);
      await stub.fetch("https://context/generation", { method: "PUT", body: JSON.stringify(generation) });
      send({ type: "done", sectionCount: generation.sections.length });
    } catch (error) {
      generation.status = "failed";
      generation.article = article;
      generation.error = errorMessage(error);
      await stub.fetch("https://context/generation", { method: "PUT", body: JSON.stringify(generation) });
      send({ type: "error", message: generation.error });
    } finally {
      if (outputOpen && controllerRef) {
        try { controllerRef.close(); } catch { /* client disconnected */ }
      }
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      execution.waitUntil(job());
    },
    cancel() { outputOpen = false; },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function handleSummary(request: Request, env: Env): Promise<Response> {
  let body: { generationId?: string; sectionIndex?: number };
  try {
    body = await readJson(request);
  } catch (error) {
    return json({ error: errorMessage(error) }, 400);
  }

  if (!body.generationId || !/^[0-9a-f-]{36}$/i.test(body.generationId)) return json({ error: "无效的生成记录。" }, 400);
  if (!Number.isInteger(body.sectionIndex) || (body.sectionIndex ?? -1) < 0) return json({ error: "无效的章节编号。" }, 400);

  return contextStub(env, body.generationId).fetch("https://context/summary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sectionIndex: body.sectionIndex }),
  });
}

export default {
  async fetch(request: Request, env: Env, execution: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) return apiPreflight(request);
    if (request.method === "GET" && url.pathname === "/api/helper/connect") return handleHelperConnect(request, env);
    if (request.method === "POST" && url.pathname === "/api/helper/status") {
      return withApiCors(request, await handleHelperStatus(request, env));
    }
    if (request.method === "POST" && url.pathname === "/api/helper/extract") {
      return withApiCors(request, await handleHelperExtract(request, env));
    }
    if (request.method === "POST" && url.pathname === "/api/generate") {
      return withApiCors(request, await handleGenerate(request, env, execution));
    }
    if (request.method === "POST" && url.pathname === "/api/summary") {
      return withApiCors(request, await handleSummary(request, env));
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      const proxySetting = env.WEBSHARE_PROXY_URLS || env.WEBSHARE_PROXY_URL;
      return withApiCors(request, json({
        ok: true,
        mode: env.GEMINI_API_KEY ? "gemini" : "demo",
        youtubeProxy: Boolean(proxySetting),
        youtubeProxyCount: proxySetting?.split(/[\r\n,;]+/).filter((value) => value.trim()).length ?? 0,
        helperRelay: true,
      }));
    }
    if (url.pathname.startsWith("/api/")) return withApiCors(request, json({ error: "Not found" }, 404));
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
