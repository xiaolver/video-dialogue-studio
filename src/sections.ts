import type { ArticleSection } from "./types";

export function parseArticleSections(markdown: string): ArticleSection[] {
  const matches = [...markdown.matchAll(/^##\s+(.+?)\s*$/gm)];

  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    return {
      heading: match[1].replace(/\s*\[5W1H\]\s*$/i, "").trim(),
      body: markdown.slice(start, end).trim(),
    };
  });
}
