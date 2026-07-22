import { streamArticle } from "./gemini";
import { parseArticleSections } from "./sections";
import type { Env, StoredGeneration } from "./types";
import { getYouTubeTranscript, TranscriptError } from "./youtube";

export { GenerationContext } from "./context";

const MAX_INSTRUCTION_LENGTH = 1_200;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
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

async function handleGenerate(request: Request, env: Env, execution: ExecutionContext): Promise<Response> {
  let body: { videoUrl?: string; instruction?: string };
  try {
    body = await readJson(request);
  } catch (error) {
    return json({ error: errorMessage(error) }, 400);
  }

  const videoUrl = body.videoUrl?.trim() ?? "";
  const instruction = body.instruction?.trim() ?? "";
  if (!videoUrl || videoUrl.length > 500) return json({ error: "请输入有效的 YouTube 视频链接。" }, 400);
  if (instruction.length > MAX_INSTRUCTION_LENGTH) return json({ error: `生成要求不能超过 ${MAX_INSTRUCTION_LENGTH} 字。` }, 400);

  let transcript;
  try {
    transcript = await getYouTubeTranscript(videoUrl);
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
    if (request.method === "POST" && url.pathname === "/api/generate") return handleGenerate(request, env, execution);
    if (request.method === "POST" && url.pathname === "/api/summary") return handleSummary(request, env);
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json({ ok: true, mode: env.GEMINI_API_KEY ? "gemini" : "demo" });
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
