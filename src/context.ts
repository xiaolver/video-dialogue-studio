import { DurableObject } from "cloudflare:workers";
import { summarizeSection } from "./gemini";
import type { Env, FiveWOneH, StoredGeneration } from "./types";

const GENERATION_KEY = "generation";
const TRANSCRIPT_KEY = "transcript";
const ARTICLE_KEY = "article";
const SECTIONS_KEY = "sections";
const CONTEXT_TTL_MS = 24 * 60 * 60 * 1_000;

type GenerationMetadata = Omit<StoredGeneration, "transcript" | "article" | "sections">;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export class GenerationContext extends DurableObject<Env> {
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
          this.env.GEMINI_API_KEY,
          this.env.GEMINI_MODEL,
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
}
