/**
 * Reads an assignment the way a careful student would and returns a task
 * card: the steps, the quantities it found, and p50/p80 hours. One call per
 * assignment version, shared by everyone who has that assignment.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { WorkItem } from "../types.js";
import { truncate } from "../text.js";

export const TaskCardSchema = z.object({
  shape: z.enum(["exam", "project", "presentation", "lab", "paper", "reading", "problem_set", "discussion", "quiz", "reflection", "generic"]),
  steps: z.array(z.string()).min(1).max(10),
  quantities: z.object({
    pages: z.number().nullable(),
    words: z.number().nullable(),
    problems: z.number().nullable(),
    questions: z.number().nullable(),
    sources: z.number().nullable(),
    stated_minutes: z.number().nullable(),
  }),
  p50_hours: z.number(),
  p80_hours: z.number(),
  confidence: z.enum(["low", "medium", "high"]),
  reasoning: z.string(),
});

export type TaskCard = z.infer<typeof TaskCardSchema>;

const SYSTEM = `You estimate how long a university student will take to complete a piece of coursework, from its Canvas record alone.

Method:
1. Name the kind of work (shape).
2. Unpack it into the concrete steps a student actually performs, including reading the brief, gathering material, doing, checking and submitting.
3. Pull every quantity the brief states (pages, words, problems, questions, sources, a stated time limit). Null when absent. Ranges take the upper bound.
4. Estimate hours for a typical student in that course: p50 is the median, p80 the value they beat four times in five. Students systematically underestimate; your p50 should already correct for that. Quizzes: time limit plus revision. Discussions: post plus required replies. Readings: about ten pages an hour for dense text, thirty for easy text.
5. Confidence is high when the brief states quantities, medium when the kind is clear but not the size, low otherwise.

Return only the task card. Never invent quantities the brief does not state.`;

export interface LlmEstimator {
  taskCard(item: WorkItem): Promise<TaskCard | undefined>;
}

export class ClaudeEstimator implements LlmEstimator {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    this.client = opts.apiKey ? new Anthropic({ apiKey: opts.apiKey }) : new Anthropic();
    this.model = opts.model ?? "claude-opus-5-5";
  }

  async taskCard(item: WorkItem): Promise<TaskCard | undefined> {
    const card = [
      `Title: ${item.title}`,
      item.courseCode ? `Course: ${item.courseCode}${item.courseName ? ` (${item.courseName})` : ""}` : undefined,
      `Kind in Canvas: ${item.kind}${item.canvasType ? ` / ${item.canvasType}` : ""}`,
      item.pointsPossible !== undefined ? `Points: ${item.pointsPossible}` : undefined,
      item.submissionTypes?.length ? `Submission types: ${item.submissionTypes.join(", ")}` : undefined,
      item.allowedAttempts !== undefined ? `Allowed attempts: ${item.allowedAttempts === -1 ? "unlimited" : item.allowedAttempts}` : undefined,
      item.rubricCriteria !== undefined ? `Rubric criteria: ${item.rubricCriteria}` : undefined,
      item.peerReviews ? "Peer review required" : undefined,
      item.isGroup ? "Group assignment" : undefined,
      item.quiz?.timeLimitMinutes ? `Quiz time limit: ${item.quiz.timeLimitMinutes} minutes` : undefined,
      item.quiz?.questionCount ? `Quiz questions: ${item.quiz.questionCount}` : undefined,
      "",
      "Description:",
      item.descriptionText ? truncate(item.descriptionText, 6000) : "(none)",
    ]
      .filter((l) => l !== undefined)
      .join("\n");

    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 4000,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: card }],
      output_config: { effort: "low", format: zodOutputFormat(TaskCardSchema) },
    });
    if (response.stop_reason === "refusal") return undefined;
    const parsed = response.parsed_output;
    if (!parsed) return undefined;
    if (!(parsed.p50_hours > 0) || !(parsed.p80_hours >= parsed.p50_hours)) return undefined;
    return parsed;
  }
}
