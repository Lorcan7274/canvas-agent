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
  it("leaves out-of-range code points alone instead of throwing", () => {
    expect(htmlToText("x &#1114112; y &#x110000; z &#99999999999;")).toBe("x &#1114112; y &#x110000; z &#99999999999;");
  });
  it("stays linear on unclosed tags and blocks", () => {
    // ~190k characters, all inside the 200k cap.
    const nasty = "<a".repeat(30_000) + "<li".repeat(20_000) + "</p ".repeat(5_000) + "<script".repeat(10_000) + "x";
    const t0 = Date.now();
    htmlToText(nasty);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it("drops an unclosed script to the end and reads at most 200k characters", () => {
    expect(htmlToText("keep<script>secret()")).toBe("keep");
    expect(htmlToText("a".repeat(300_000)).length).toBe(200_000);
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
  it("reads ranges after the unit, lists, word ranges and thousands separators", () => {
    expect(extractQuantities("Section 2.3 exercises 1-15")).toEqual({ problems: 15 });
    expect(extractQuantities("Problems 3.1-3.15")).toEqual({ problems: 15 });
    expect(extractQuantities("exercises 1-15 odd")).toEqual({ problems: 8 });
    expect(extractQuantities("Read pages 112-140")).toEqual({ pages: 29 });
    expect(extractQuantities("pp. 45–67")).toEqual({ pages: 23 });
    expect(extractQuantities("Answer questions 1-10")).toEqual({ questions: 10 });
    expect(extractQuantities("Read chapters 3 and 9")).toEqual({ chapters: 2 });
    expect(extractQuantities("chapters 2, 5 and 9")).toEqual({ chapters: 3 });
    expect(extractQuantities("two to three pages")).toEqual({ pages: 3 });
    expect(extractQuantities("1.500 words")).toEqual({ words: 1500 });
    expect(extractQuantities("between 1,000 and 1,500 words")).toEqual({ words: 1500 });
    expect(extractQuantities("Write a five (5) page paper")).toEqual({ pages: 5 });
  });
  it("leaves alone what is not a count", () => {
    for (const s of ["Read Chapter 4.12", "due 11:59 pm", "2 attempts", "100 points", "Covers sections 5.1-5.4.", "see page 5", "Answer in 10 words"]) {
      const q = extractQuantities(s);
      expect(q.pages ?? q.words ?? q.problems ?? q.questions ?? q.minutes, s).toBeUndefined();
    }
    expect(extractQuantities("Read Chapter 4")).toEqual({ chapters: 1 });
  });
  it("reads a duration only when it is effort or a time limit, never a window", () => {
    expect(extractQuantities("a 90-minute exam").minutes).toBe(90);
    expect(extractQuantities("time limit of 60 minutes").minutes).toBe(60);
    expect(extractQuantities("This should take about 2 hours").minutes).toBe(120);
    expect(extractQuantities("The exam is 2 hours long").minutes).toBe(120);
    for (const s of ["Post within 48 hours", "You have 24 hours to complete this take-home", "Spend 2 hours per week", "Available for 24 hours", "You may spend up to 3 hours", "due 2 hours before class", "Late work accepted up to 48 hours after"]) {
      expect(extractQuantities(s).minutes, s).toBeUndefined();
    }
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
