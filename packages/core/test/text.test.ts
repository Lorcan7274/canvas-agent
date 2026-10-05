import { describe, expect, it } from "vitest";
import { extractQuantities, htmlToText, truncate } from "../src/text.js";

describe("htmlToText", () => {
  it("flattens tags, lists and entities", () => {
    const t = htmlToText("<p>Read <b>chapter&nbsp;4</b> &amp; answer:</p><ul><li>Q1</li><li>Q2</li></ul>");
    expect(t).toBe("Read chapter 4 & answer:\n• Q1\n• Q2");
  });
  it("drops scripts and styles", () => {
    expect(htmlToText("<style>p{}</style><script>x()</script>hi")).toBe("hi");
  });
  it("handles numeric entities", () => {
    expect(htmlToText("a&#8211;b &#x27;c&#x27;")).toBe("a–b 'c'");
  });
});

describe("extractQuantities", () => {
  it("reads counts with units", () => {
    expect(extractQuantities("Complete 12 problems from chapter 4")).toMatchObject({ problems: 12, chapters: 1 });
    expect(extractQuantities("Write a 1500-word essay")).toMatchObject({ words: 1500 });
    expect(extractQuantities("a lab report (4-5 pages, double-spaced)")).toMatchObject({ pages: 5 });
    expect(extractQuantities("Read chapters 6 and 7")).toMatchObject({ chapters: 2 });
    expect(extractQuantities("You have 30 minutes")).toMatchObject({ minutes: 30 });
    expect(extractQuantities("at least two peer-reviewed sources")).toMatchObject({ sources: 2 });
  });
  it("returns nothing for prose without quantities", () => {
    expect(extractQuantities("Reflect on the lecture.")).toEqual({});
  });
});

describe("truncate", () => {
  it("adds an ellipsis", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
  });
});
