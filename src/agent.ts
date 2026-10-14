import Anthropic from "@anthropic-ai/sdk";
import { Ajv, type ValidateFunction } from "ajv";
import type { FigmaBridge } from "./figma.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const EFFORT = (process.env.CLAUDE_EFFORT || "medium") as "low" | "medium" | "high" | "xhigh" | "max";
const MAX_TURNS = 40;

const SYSTEM_PROMPT = `You are a design agent that builds workflows in Figma and FigJam for a user who talks to you by voice.

Each user message is a speech-to-text transcript, so expect filler words, misheard terms and no punctuation; infer the intended meaning. Commands are usually incremental ("add a review step after approval", "make the error path red", "now turn it into a swimlane by team"), so keep track of what you already built in this conversation and edit it rather than starting over.

What "workflow" means here: process flows, user journeys, approval chains, state machines, swimlanes, onboarding funnels and similar diagrams. Prefer FigJam diagrams (generate_diagram) for flow/process requests, and Figma design frames (use_figma) when the user asks for designed screens, styled cards or a polished layout. When the user names an existing file, work in it; otherwise create a new file and tell them its link.

Before writing to Figma, read the relevant Figma guide included below. Act without asking for confirmation on reversible design edits; ask a short question only when the request is genuinely ambiguous.

Your final reply is read aloud: keep it to one to three short spoken sentences, no markdown, no lists, no URLs except a file link when you created a new file. Latency-sensitive; begin your visible answer immediately.`;

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; status: "start" | "ok" | "error"; detail?: string }
  | { type: "done"; reply: string }
  | { type: "error"; message: string };

export class FigmaAgent {
  private client = new Anthropic();
  // Append-only history: earlier turns are never rewritten, so thinking blocks stay valid.
  private messages: Anthropic.Beta.BetaMessageParam[] = [];
  private validators = new Map<string, ValidateFunction>();

  constructor(private figma: FigmaBridge) {
    const ajv = new Ajv({ strict: false, allErrors: true });
    for (const tool of figma.tools) {
      try {
        this.validators.set(tool.name, ajv.compile(tool.input_schema));
      } catch {
        // Unsupported schema dialect: skip validation for this tool, the MCP server validates too.
      }
    }
  }

  private system(): Anthropic.Beta.BetaTextBlockParam[] {
    const blocks: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: SYSTEM_PROMPT }];
    if (this.figma.instructions) blocks.push({ type: "text", text: this.figma.instructions });
    return blocks;
  }

  async run(transcript: string, emit: (e: AgentEvent) => void): Promise<void> {
    this.messages.push({ role: "user", content: transcript });
    let finalText = "";
    let jsonRetries = 0;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const stream = this.client.beta.messages.stream({
        model: MODEL,
        max_tokens: 64000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: EFFORT },
        cache_control: { type: "ephemeral" },
        system: this.system(),
        tools: this.figma.tools,
        messages: this.messages,
      });
      stream.on("text", (delta) => emit({ type: "text", text: delta }));

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // Only an unparseable streamed tool input is retried; API errors propagate.
        if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
        continue;
      }

      finalText = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      if (message.stop_reason === "refusal") {
        emit({ type: "done", reply: "Sorry, I can't help with that request." });
        return;
      }

      this.messages.push({ role: "assistant", content: message.content });

      if (message.stop_reason === "pause_turn") continue;

      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) {
        emit({ type: "done", reply: finalText });
        return;
      }
      if (message.stop_reason === "max_tokens") {
        throw new Error("A Figma tool call was cut off by max_tokens; try a smaller request.");
      }

      // Run every tool call of the turn, then return all results in one user message.
      const results = await Promise.all(
        toolUses.map(async (tool): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
          const validate = this.validators.get(tool.name);
          if (validate && !validate(tool.input)) {
            emit({ type: "tool", name: tool.name, status: "error", detail: "invalid input" });
            return {
              type: "tool_result",
              tool_use_id: tool.id,
              is_error: true,
              content: `INVALID_JSON: input did not match the schema (${JSON.stringify(validate.errors)}). Re-issue the call.`,
            };
          }
          emit({ type: "tool", name: tool.name, status: "start" });
          try {
            const content = await this.figma.callTool(tool.name, tool.input);
            emit({ type: "tool", name: tool.name, status: "ok" });
            return { type: "tool_result", tool_use_id: tool.id, content };
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            emit({ type: "tool", name: tool.name, status: "error", detail });
            return { type: "tool_result", tool_use_id: tool.id, is_error: true, content: detail };
          }
        }),
      );
      this.messages.push({ role: "user", content: results });
    }

    emit({ type: "done", reply: finalText || "I stopped after many steps; tell me how to continue." });
  }
}
