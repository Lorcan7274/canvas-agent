import { z } from "zod";
import type { WorkItem } from "../types.js";
export declare const TaskCardSchema: z.ZodObject<{
    shape: z.ZodEnum<["exam", "project", "presentation", "lab", "paper", "reading", "problem_set", "discussion", "quiz", "reflection", "generic"]>;
    steps: z.ZodArray<z.ZodString, "many">;
    quantities: z.ZodObject<{
        pages: z.ZodNullable<z.ZodNumber>;
        words: z.ZodNullable<z.ZodNumber>;
        problems: z.ZodNullable<z.ZodNumber>;
        questions: z.ZodNullable<z.ZodNumber>;
        sources: z.ZodNullable<z.ZodNumber>;
        stated_minutes: z.ZodNullable<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        pages: number | null;
        words: number | null;
        problems: number | null;
        questions: number | null;
        sources: number | null;
        stated_minutes: number | null;
    }, {
        pages: number | null;
        words: number | null;
        problems: number | null;
        questions: number | null;
        sources: number | null;
        stated_minutes: number | null;
    }>;
    p50_hours: z.ZodNumber;
    p80_hours: z.ZodNumber;
    confidence: z.ZodEnum<["low", "medium", "high"]>;
    reasoning: z.ZodString;
}, "strip", z.ZodTypeAny, {
    shape: "quiz" | "discussion" | "exam" | "project" | "presentation" | "lab" | "paper" | "reading" | "problem_set" | "reflection" | "generic";
    confidence: "low" | "medium" | "high";
    steps: string[];
    quantities: {
        pages: number | null;
        words: number | null;
        problems: number | null;
        questions: number | null;
        sources: number | null;
        stated_minutes: number | null;
    };
    p50_hours: number;
    p80_hours: number;
    reasoning: string;
}, {
    shape: "quiz" | "discussion" | "exam" | "project" | "presentation" | "lab" | "paper" | "reading" | "problem_set" | "reflection" | "generic";
    confidence: "low" | "medium" | "high";
    steps: string[];
    quantities: {
        pages: number | null;
        words: number | null;
        problems: number | null;
        questions: number | null;
        sources: number | null;
        stated_minutes: number | null;
    };
    p50_hours: number;
    p80_hours: number;
    reasoning: string;
}>;
export type TaskCard = z.infer<typeof TaskCardSchema>;
export interface LlmEstimator {
    taskCard(item: WorkItem): Promise<TaskCard | undefined>;
}
export declare class ClaudeEstimator implements LlmEstimator {
    private readonly client;
    private readonly model;
    constructor(opts?: {
        apiKey?: string;
        model?: string;
    });
    taskCard(item: WorkItem): Promise<TaskCard | undefined>;
}
