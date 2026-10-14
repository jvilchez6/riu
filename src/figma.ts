import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type Anthropic from "@anthropic-ai/sdk";

// Figma ships usage guides as MCP resources; the server instructions ask agents
// to read them before calling the matching tools.
const SKILL_RESOURCES = [
  "skill://figma/figma-use/SKILL.md",
  "skill://figma/figma-use-figjam/SKILL.md",
  "skill://figma/figma-generate-diagram/SKILL.md",
  "skill://figma/figma-generate-design/SKILL.md",
];

export interface FigmaBridge {
  tools: Anthropic.Beta.BetaTool[];
  instructions: string;
  callTool(name: string, input: unknown): Promise<Anthropic.Beta.BetaToolResultBlockParam["content"]>;
  close(): Promise<void>;
}

export async function connectFigma(): Promise<FigmaBridge> {
  const url = process.env.FIGMA_MCP_URL || "http://127.0.0.1:3845/mcp";
  const token = process.env.FIGMA_MCP_TOKEN;
  const allow = (process.env.FIGMA_TOOLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  const client = new Client({ name: "voice-figma-agent", version: "0.1.0" });
  await client.connect(transport);

  const { tools: mcpTools } = await client.listTools();
  const tools: Anthropic.Beta.BetaTool[] = mcpTools
    .filter((t) => allow.length === 0 || allow.includes(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      // Figma tool inputs (e.g. use_figma scripts) can be large; stream them as generated.
      eager_input_streaming: true,
    }));

  const parts: string[] = [];
  const serverInstructions = client.getInstructions();
  if (serverInstructions) parts.push(serverInstructions);
  for (const uri of SKILL_RESOURCES) {
    try {
      const res = await client.readResource({ uri });
      for (const c of res.contents) {
        if ("text" in c && typeof c.text === "string") parts.push(`<figma_skill uri="${uri}">\n${c.text}\n</figma_skill>`);
      }
    } catch {
      // Not every Figma MCP server (desktop vs remote) exposes every guide.
    }
  }

  return {
    tools,
    instructions: parts.join("\n\n"),
    async callTool(name, input) {
      const result = await client.callTool({ name, arguments: input as Record<string, unknown> });
      const content = (result.content ?? []) as Array<Record<string, unknown>>;
      const blocks: Exclude<Anthropic.Beta.BetaToolResultBlockParam["content"], string | undefined> = [];
      for (const c of content) {
        if (c.type === "text") blocks.push({ type: "text", text: String(c.text) });
        else if (c.type === "image")
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: c.mimeType as "image/png", data: String(c.data) },
          });
        else blocks.push({ type: "text", text: JSON.stringify(c) });
      }
      if (result.isError) throw new Error(blocks.map((b) => ("text" in b ? b.text : "")).join("\n") || "Figma tool error");
      return blocks.length ? blocks : "(no output)";
    },
    close: () => client.close(),
  };
}
