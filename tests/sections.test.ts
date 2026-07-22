import { describe, expect, it } from "vitest";
import { parseArticleSections } from "../src/sections";

describe("parseArticleSections", () => {
  it("extracts only level-two article sections", () => {
    const markdown = "# 标题\n\n导语\n\n## 第一章\n\n内容一\n\n### 小标题\n\n更多\n\n## 第二章 [5W1H]\n\n内容二";
    expect(parseArticleSections(markdown)).toEqual([
      { heading: "第一章", body: "内容一\n\n### 小标题\n\n更多" },
      { heading: "第二章", body: "内容二" },
    ]);
  });
});
