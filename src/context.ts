import { DurableObject } from "cloudflare:workers";
import { summarizeSection, transcribeAudio } from "./openai";
import type { RelayAudioInput } from "./openai";
import type { Env, FiveWOneH, StoredGeneration } from "./types";

const GENERATION_KEY = "generation";
const TRANSCRIPT_KEY = "transcript";
const ARTICLE_KEY = "article";
const SECTIONS_KEY = "sections";
const CONTEXT_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_AUDIO_BASE64_LENGTH = 16 * 1024 * 1024;

type GenerationMetadata = Omit<StoredGeneration, "transcript" | "article" | "sections">;
type RelayResult = { transcript?: unknown; error?: string };

function validRelayAudio(value: unknown): value is RelayAudioInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const audio = value as Partial<RelayAudioInput>;
  return typeof audio.videoId === "string" && /^[\w-]{11}$/.test(audio.videoId)
    && typeof audio.title === "string" && audio.title.length <= 300
    && typeof audio.duration === "number" && Number.isFinite(audio.duration) && audio.duration >= 0 && audio.duration <= 34_200
    && audio.mimeType === "audio/mpeg"
    && typeof audio.data === "string" && audio.data.length > 0 && audio.data.length <= MAX_AUDIO_BASE64_LENGTH;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export class GenerationContext extends DurableObject<Env> {
  private readonly pendingRelayRequests = new Map<string, (result: RelayResult) => void>();

  private async readGeneration(): Promise<StoredGeneration | null> {
    const values = await this.ctx.storage.get([GENERATION_KEY, TRANSCRIPT_KEY, ARTICLE_KEY, SECTIONS_KEY]);
    const metadata = values.get(GENERATION_KEY) as GenerationMetadata | undefined;
    if (!metadata) return null;
    return {
      ...metadata,
      transcript: (values.get(TRANSCRIPT_KEY) as string | undefined) ?? "",
      article: (values.get(ARTICLE_KEY) as string | undefined) ?? "",
      sections: (values.get(SECTIONS_KEY) as StoredGeneration["sections"] | undefined) ?? [],
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/helper/connect") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "Expected WebSocket upgrade" }, 426);
      }
      for (const existing of this.ctx.getWebSockets("helper")) {
        try { existing.close(1000, "Replaced by a new helper connection"); } catch { /* already closed */ }
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, ["helper"]);
      server.serializeAttachment({ role: "helper", connectedAt: Date.now() });
      const protocol = request.headers.get("Sec-WebSocket-Protocol");
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : undefined,
      });
    }

    if (request.method === "GET" && url.pathname === "/helper/status") {
      const connected = this.ctx.getWebSockets("helper").some((socket) => socket.readyState === WebSocket.OPEN);
      return json({ connected });
    }

    if (request.method === "POST" && url.pathname === "/helper/extract") {
      const socket = this.ctx.getWebSockets("helper").find((candidate) => candidate.readyState === WebSocket.OPEN);
      if (!socket) return json({ error: "本机助手尚未连接云端。请重新运行 npm run helper。" }, 409);
      const { videoUrl } = await request.json<{ videoUrl?: string }>();
      const requestId = crypto.randomUUID();
      const result = await new Promise<RelayResult>((resolve) => {
        const timeout = setTimeout(() => {
          this.pendingRelayRequests.delete(requestId);
          resolve({ error: "本机助手提取字幕超时。" });
        }, 5 * 60_000);
        this.pendingRelayRequests.set(requestId, (value) => {
          clearTimeout(timeout);
          this.pendingRelayRequests.delete(requestId);
          resolve(value);
        });
        try {
          socket.send(JSON.stringify({ type: "extract", requestId, videoUrl }));
        } catch {
          clearTimeout(timeout);
          this.pendingRelayRequests.delete(requestId);
          resolve({ error: "向本机助手发送任务失败。" });
        }
      });
      return result.error ? json({ error: result.error }, 422) : json({ transcript: result.transcript });
    }

    if (request.method === "PUT" && url.pathname === "/generation") {
      const generation = await request.json<StoredGeneration>();
      const { transcript, article, sections, ...metadata } = generation;
      await this.ctx.storage.put({
        [GENERATION_KEY]: metadata,
        [TRANSCRIPT_KEY]: transcript,
        [ARTICLE_KEY]: article,
        [SECTIONS_KEY]: sections,
      });
      if (!(await this.ctx.storage.getAlarm())) {
        await this.ctx.storage.setAlarm(Date.now() + CONTEXT_TTL_MS);
      }
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/summary") {
      const { sectionIndex } = await request.json<{ sectionIndex: number }>();
      if (!Number.isInteger(sectionIndex) || sectionIndex < 0) return json({ error: "无效的章节编号。" }, 400);

      const generation = await this.readGeneration();
      if (!generation) return json({ error: "生成上下文已不存在。" }, 404);
      if (generation.status !== "ready") return json({ error: "文章仍在生成，请稍后再试。" }, 409);
      if (!generation.sections[sectionIndex]) return json({ error: "章节不存在。" }, 404);

      const cacheKey = `summary:${sectionIndex}`;
      const cached = await this.ctx.storage.get<FiveWOneH>(cacheKey);
      if (cached) return json({ summary: cached, cached: true });

      try {
        const summary = await summarizeSection(
          generation,
          sectionIndex,
          this.env.OPENAI_API_KEY,
          this.env.OPENAI_MODEL,
        );
        await this.ctx.storage.put(cacheKey, summary);
        return json({ summary, cached: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : "5W1H 总结失败。";
        return json({ error: message }, 502);
      }
    }

    return json({ error: "Not found" }, 404);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async webSocketMessage(_socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      const payload = JSON.parse(text) as {
        type?: string;
        requestId?: string;
        transcript?: unknown;
        audio?: unknown;
        error?: string;
      };
      if (!payload.requestId) return;
      const resolve = this.pendingRelayRequests.get(payload.requestId);
      if (!resolve) return;
      if (payload.type === "result") {
        resolve({ transcript: payload.transcript, error: payload.error });
        return;
      }
      if (payload.type === "audio") {
        if (!validRelayAudio(payload.audio)) {
          resolve({ error: "本机助手返回的音频数据无效或过大。" });
          return;
        }
        try {
          const transcriptText = await transcribeAudio(
            payload.audio,
            this.env.OPENAI_API_KEY,
            this.env.OPENAI_TRANSCRIPTION_MODEL,
          );
          resolve({
            transcript: {
              videoId: payload.audio.videoId,
              title: payload.audio.title,
              language: "audio-transcription",
              text: transcriptText,
              source: "local-helper",
            },
          });
        } catch (error) {
          resolve({ error: error instanceof Error ? error.message : "OpenAI 音频转写失败。" });
        }
      }
    } catch {
      // Ignore malformed helper messages; the pending request will time out.
    }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    try { socket.close(code, reason); } catch { /* runtime may have completed the close */ }
  }
}
