/**
 * The MCP surface: seven tools and three prompts, bound to one user per
 * request. Stateless; a new McpServer per HTTP request.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Services, WorkloadItem } from "../services.js";

export const SERVER_INSTRUCTIONS = `You are connected to the student's Canvas planner. It knows every assignment, quiz and discussion across their courses, how long each is likely to take (calibrated to this student once they log times), and the study blocks already planned.

How to plan a week:
1. Call get_workload for the period. It returns items with due dates, status, p50/p80 hour estimates and what is already planned. Mention anything marked missing or late first.
2. Call propose_plan. If the student's calendar is reachable through another connector, read their busy times and pass them as "busy" so blocks avoid them. Show the student the proposed blocks grouped by day, with the hours per day, and anything that did not fit.
3. Only after the student agrees, call commit_plan with the blocks. It writes to their Google Calendar when connected and always publishes an ICS feed they can subscribe to.
4. When an item from "checkIns" comes up, ask one short question ("How long did the lab report take: <1h, 1-2h, 2-4h, 4-8h, 8h+?") and record the answer with log_time. That is what makes the estimates get better.

Keep estimates honest: p50 is the median, p80 is what they beat four times in five. Use p80 for anything due within three days. Never invent assignments; if the workload is empty or stale, say so and point them to the settings page.`;

function hours(h: number): string {
  return h === Math.floor(h) ? `${h}h` : `${h.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}h`;
}

function summariseWorkload(items: WorkloadItem[], from: string, to: string, warnings: string[]): string {
  if (!items.length) return `Nothing due between ${from.slice(0, 10)} and ${to.slice(0, 10)}.${warnings.length ? "\n" + warnings.join("\n") : ""}`;
  const lines = items.map((i) => {
    const flags = [i.status !== "open" ? i.status : undefined, i.late ? "late" : undefined].filter(Boolean).join(", ");
    const planned = i.plannedMinutes ? `, ${Math.round(i.plannedMinutes / 60 * 4) / 4}h planned` : "";
    return `- ${i.dueLocal ?? "no due date"} · ${i.title}${i.course?.code ? ` (${i.course.code})` : ""} · ~${hours(i.estimate.p50Hours)} (p80 ${hours(i.estimate.p80Hours)}, ${i.estimate.basis})${planned}${flags ? ` [${flags}]` : ""}`;
  });
  const total = items.reduce((s, i) => s + i.estimate.p50Hours, 0);
  return `${items.length} item(s), about ${hours(Math.round(total * 4) / 4)} of work at p50:\n${lines.join("\n")}${warnings.length ? "\n\nWarnings:\n" + warnings.join("\n") : ""}`;
}

const Interval = z.object({ start: z.string().describe("ISO 8601 instant"), end: z.string().describe("ISO 8601 instant") });

export function buildMcpServer(services: Services, userId: string): McpServer {
  const server = new McpServer({ name: "canvas-agent", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    "get_workload",
    {
      title: "Get workload",
      description:
        "Everything due in a period across the student's Canvas courses, with status, a time estimate (p50 and p80 hours), what is already planned, and items that need a quick 'how long did it take' check-in. Defaults to the past week through two weeks ahead.",
      inputSchema: {
        from: z.string().optional().describe("ISO 8601 start of the period. Default: 7 days ago."),
        to: z.string().optional().describe("ISO 8601 end of the period. Default: 14 days from now."),
        include_done: z.boolean().optional().describe("Include submitted, graded and completed items. Default false."),
        refresh: z.boolean().optional().describe("Re-sync Canvas first (token and feed accounts). Slower. Default false."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ from, to, include_done, refresh }) => {
      const opts: Parameters<Services["workload"]>[1] = {};
      if (from) opts.from = from;
      if (to) opts.to = to;
      if (include_done !== undefined) opts.includeDone = include_done;
      if (refresh !== undefined) opts.refresh = refresh;
      const w = await services.workload(userId, opts);
      const checkIns = services.pendingCheckIns(userId).slice(0, 5);
      const text = summariseWorkload(w.items, w.from, w.to, w.warnings) + (checkIns.length ? `\n\nCheck-ins to ask about (then log_time): ${checkIns.map((c) => c.title).join("; ")}` : "");
      return { content: [{ type: "text", text }], structuredContent: { ...w, checkIns } };
    },
  );

  server.registerTool(
    "get_assignment",
    {
      title: "Get assignment details",
      description: "The full record for one item: description text, points, rubric size, quiz facts, the estimate with its reasoning and suggested steps, planned blocks, and how long similar work in the same course took this student.",
      inputSchema: { item_id: z.string().describe("The id from get_workload, e.g. canvas:assignment:1234") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ item_id }) => {
      const a = await services.assignment(userId, item_id);
      const i = a.item;
      const text = [
        `${i.title}${i.courseCode ? ` (${i.courseCode})` : ""}`,
        a.dueLocal ? `Due ${a.dueLocal}` : "No due date",
        `Status: ${i.status}${i.pointsPossible !== undefined ? ` · ${i.pointsPossible} points` : ""}${i.submissionTypes?.length ? ` · ${i.submissionTypes.join("/")}` : ""}`,
        `Estimate: ~${hours(a.estimate.p50Hours)} (p80 ${hours(a.estimate.p80Hours)}, ${a.estimate.basis}, ${a.estimate.confidence} confidence). ${a.estimate.reasoning ?? ""}`,
        a.estimate.steps?.length ? `Steps: ${a.estimate.steps.join(" → ")}` : "",
        a.blocks.length ? `Planned: ${a.blocks.map((b) => `${b.startLocal} (${b.minutes} min, ${b.status})`).join("; ")}` : "Nothing planned yet.",
        i.descriptionText ? `\n${i.descriptionText.slice(0, 4000)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { content: [{ type: "text", text }], structuredContent: a as unknown as Record<string, unknown> };
    },
  );

  server.registerTool(
    "propose_plan",
    {
      title: "Propose study blocks",
      description:
        "Computes study blocks for open work inside the student's work windows, around busy time, before each due date with a buffer, under their daily cap. Returns a proposal only; nothing is saved until commit_plan. Pass busy intervals from the student's calendar when you have them.",
      inputSchema: {
        from: z.string().optional().describe("ISO 8601 start of the planning horizon. Default: now."),
        to: z.string().optional().describe("ISO 8601 end of the horizon. Default: 7 days from now."),
        item_ids: z.array(z.string()).optional().describe("Only plan these items."),
        busy: z.array(Interval).optional().describe("Intervals the student is not available, from their calendar."),
        strategy: z.enum(["early", "even"]).optional().describe("early: as soon as possible (default). even: spread each item toward its deadline."),
        conservative: z.boolean().optional().describe("Plan every item at p80 instead of p50. Default false."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ from, to, item_ids, busy, strategy, conservative }) => {
      const opts: Parameters<Services["propose"]>[1] = {};
      if (from) opts.from = from;
      if (to) opts.to = to;
      if (item_ids) opts.itemIds = item_ids;
      if (busy) opts.busy = busy;
      if (strategy) opts.strategy = strategy;
      if (conservative !== undefined) opts.conservative = conservative;
      const p = await services.propose(userId, opts);
      const byDay = new Map<string, string[]>();
      for (const b of p.blocks) {
        const day = b.startLocal.split(",")[0] ?? b.startLocal;
        const arr = byDay.get(day) ?? [];
        arr.push(`${b.startLocal.split(", ").pop()}–${b.endLocal.split(", ").pop()} ${b.title} (${b.minutes} min${b.insideBuffer ? ", inside the due-date buffer" : ""})`);
        byDay.set(day, arr);
      }
      const lines: string[] = [];
      for (const [day, arr] of byDay) lines.push(`${day}:\n  ${arr.join("\n  ")}`);
      const text = [
        p.blocks.length ? `Proposed ${p.blocks.length} block(s), ${hours(Math.round((p.blocks.reduce((s, b) => s + b.minutes, 0) / 60) * 4) / 4)} total, ${hours(p.freeHours)} free in windows (busy time: ${p.busySource}).` : "Nothing to plan in this horizon.",
        ...lines,
        p.unscheduled.length ? `Did not fit: ${p.unscheduled.map((u) => `${u.title} (${u.hoursShort}h short, ${u.reason})`).join("; ")}` : "",
        ...p.notes,
      ]
        .filter(Boolean)
        .join("\n");
      return { content: [{ type: "text", text }], structuredContent: p as unknown as Record<string, unknown> };
    },
  );

  server.registerTool(
    "commit_plan",
    {
      title: "Commit study blocks",
      description: "Saves agreed study blocks. Adds to the student's Google Calendar when connected; always available as an ICS feed. Additive: it never removes existing blocks (use clear_plan for that). Call only after the student has agreed to the blocks.",
      inputSchema: {
        blocks: z.array(z.object({ item_id: z.string(), start: z.string(), end: z.string() })).min(1),
        calendar: z.boolean().optional().describe("Write to Google Calendar when connected. Default true."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ blocks, calendar }) => {
      const input: Parameters<Services["commit"]>[1] = { blocks: blocks.map((b) => ({ itemId: b.item_id, start: b.start, end: b.end })) };
      if (calendar !== undefined) input.calendar = calendar;
      const r = await services.commit(userId, input);
      const text = [
        `Saved ${r.created.length} block(s)${r.calendar === "google" ? " and added them to Google Calendar" : ""}.`,
        r.calendar !== "google" ? `Subscribe to the plan feed to see them in any calendar app: ${r.icsFeedUrl}` : "",
        ...r.created.map((b) => `- ${b.startLocal} · ${b.title} (${b.minutes} min)${b.calendarWritten ? "" : " [not in Google Calendar]"}`),
        r.errors.length ? `Problems: ${r.errors.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { content: [{ type: "text", text }], structuredContent: r as unknown as Record<string, unknown> };
    },
  );

  server.registerTool(
    "clear_plan",
    {
      title: "Clear planned blocks",
      description: "Deletes still-planned (not done) study blocks, and their Google Calendar events, for the given items or the whole period. Use before re-planning.",
      inputSchema: {
        item_ids: z.array(z.string()).optional().describe("Only these items. Omit for every planned block in the period."),
        from: z.string().optional(),
        to: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ item_ids, from, to }) => {
      const victims = services.store
        .listBlocks(userId, { ...(from ? { from } : {}), ...(to ? { to } : {}) })
        .filter((b) => b.status === "planned" && (!item_ids || item_ids.includes(b.itemId)));
      const google = services.google ? services.store.getGoogleAccount(userId) : undefined;
      const token = google ? await services.googleAccessToken(userId).catch(() => undefined) : undefined;
      let removedEvents = 0;
      for (const v of victims) {
        if (v.calendarEventId && token && google && services.google) {
          await services.google.deleteEvent(token, v.calendarId ?? google.calendarId, v.calendarEventId).catch(() => undefined);
          removedEvents++;
        }
        services.store.updateBlock(userId, v.id, { status: "deleted" });
      }
      return { content: [{ type: "text", text: `Cleared ${victims.length} block(s)${removedEvents ? `, removed ${removedEvents} calendar event(s)` : ""}.` }], structuredContent: { cleared: victims.length, removedEvents } };
    },
  );

  server.registerTool(
    "log_time",
    {
      title: "Log time spent",
      description: "Records how long an item actually took, as exact minutes or a bucket (<1h, 1-2h, 2-4h, 4-8h, 8h+). This calibrates every future estimate for the student. Also closes the item's planned blocks.",
      inputSchema: {
        item_id: z.string(),
        minutes: z.number().positive().optional(),
        bucket: z.enum(["<1h", "1-2h", "2-4h", "4-8h", "8h+"]).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ item_id, minutes, bucket }) => {
      const input: { minutes?: number; bucket?: string } = {};
      if (minutes !== undefined) input.minutes = minutes;
      if (bucket) input.bucket = bucket;
      const r = await services.logTime(userId, item_id, input);
      const text = `Logged ${r.minutes} min${r.estimateWas ? ` (the estimate was ${hours(r.estimateWas)})` : ""}.${r.blocksClosed ? ` Closed ${r.blocksClosed} planned block(s).` : ""}`;
      return { content: [{ type: "text", text }], structuredContent: r };
    },
  );

  server.registerTool(
    "get_preferences",
    {
      title: "Get planning preferences",
      description: "Time zone, work windows per weekday, daily cap, block sizes, buffer before due dates, and which assistant the Canvas button opens.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const prefs = services.userOrThrow(userId).prefs;
      return { content: [{ type: "text", text: JSON.stringify(prefs, null, 2) }], structuredContent: prefs as unknown as Record<string, unknown> };
    },
  );

  server.registerTool(
    "set_preferences",
    {
      title: "Set planning preferences",
      description: "Updates any of the planning preferences. Work windows are per weekday (0 = Sunday) with HH:MM local start and end; passing work_windows replaces the whole list.",
      inputSchema: {
        timezone: z.string().optional().describe("IANA time zone, e.g. America/New_York"),
        work_windows: z.array(z.object({ weekday: z.number().int().min(0).max(6), start: z.string(), end: z.string() })).optional(),
        max_hours_per_day: z.number().positive().max(16).optional(),
        min_block_minutes: z.number().int().min(15).max(240).optional(),
        max_block_minutes: z.number().int().min(30).max(480).optional(),
        buffer_hours_before_due: z.number().min(0).max(168).optional(),
        assistant: z.enum(["claude", "chatgpt", "custom"]).optional(),
        assistant_url: z.string().url().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const patch: Record<string, unknown> = {};
      if (args.timezone) patch["timezone"] = args.timezone;
      if (args.work_windows) patch["workWindows"] = args.work_windows;
      if (args.max_hours_per_day !== undefined) patch["maxHoursPerDay"] = args.max_hours_per_day;
      if (args.min_block_minutes !== undefined) patch["minBlockMinutes"] = args.min_block_minutes;
      if (args.max_block_minutes !== undefined) patch["maxBlockMinutes"] = args.max_block_minutes;
      if (args.buffer_hours_before_due !== undefined) patch["bufferHoursBeforeDue"] = args.buffer_hours_before_due;
      if (args.assistant) patch["assistant"] = args.assistant;
      if (args.assistant_url) patch["assistantUrl"] = args.assistant_url;
      const prefs = services.setPreferences(userId, patch);
      return { content: [{ type: "text", text: `Preferences updated.\n${JSON.stringify(prefs, null, 2)}` }], structuredContent: prefs as unknown as Record<string, unknown> };
    },
  );

  server.registerTool(
    "get_profile",
    {
      title: "Get profile",
      description: "A stable identifier for the connected student account, for the assistant to tell accounts apart.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { "openai/profile": true },
    },
    async () => {
      const u = services.userOrThrow(userId);
      const profile = { id: u.id, email: u.email ?? undefined, name: u.name ?? undefined };
      return { content: [{ type: "text", text: `${u.name ?? u.email ?? u.id}` }], structuredContent: profile };
    },
  );

  server.registerPrompt(
    "plan_my_week",
    { title: "Plan my week", description: "Look at everything due, propose study blocks around my calendar, and put them in once I agree." },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Plan my week. Get my workload, ask me about any check-ins first, then propose study blocks around my calendar (read my busy times if you can) and show them by day. Wait for my OK before committing.",
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    "whats_due",
    { title: "What's due", description: "A quick list of what is due soon, with time estimates." },
    () => ({ messages: [{ role: "user", content: { type: "text", text: "What do I have due in the next week? Include anything missing or late first, with your time estimate for each." } }] }),
  );
  server.registerPrompt(
    "weekly_checkin",
    { title: "Weekly check-in", description: "Log how long last week's work actually took, so estimates improve." },
    () => ({ messages: [{ role: "user", content: { type: "text", text: "Run my weekly check-in: for each item in checkIns, ask me how long it took (<1h, 1-2h, 2-4h, 4-8h, 8h+) one at a time and log each answer." } }] }),
  );

  return server;
}
