import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectFigma } from "./figma.js";
import { FigmaAgent, type AgentEvent } from "./agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const figma = await connectFigma();
console.log(`Connected to Figma MCP (${figma.tools.length} tools): ${figma.tools.map((t) => t.name).join(", ")}`);

// One agent (conversation) per browser session.
const sessions = new Map<string, { agent: FigmaAgent; busy: boolean }>();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.post("/api/command", async (req, res) => {
  const { sessionId, transcript } = req.body as { sessionId?: string; transcript?: string };
  if (!sessionId || !transcript?.trim()) {
    res.status(400).json({ error: "sessionId and transcript are required" });
    return;
  }
  let session = sessions.get(sessionId);
  if (!session) {
    session = { agent: new FigmaAgent(figma), busy: false };
    sessions.set(sessionId, session);
  }
  if (session.busy) {
    res.status(409).json({ error: "Still working on the previous command" });
    return;
  }

  // Stream agent progress back as server-sent events.
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const emit = (e: AgentEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);

  session.busy = true;
  try {
    await session.agent.run(transcript.trim(), emit);
  } catch (err) {
    console.error(err);
    emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    session.busy = false;
    res.end();
  }
});

app.post("/api/reset", (req, res) => {
  sessions.delete((req.body as { sessionId?: string }).sessionId ?? "");
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Voice Figma agent on http://localhost:${PORT}`));

process.on("SIGINT", async () => {
  await figma.close();
  process.exit(0);
});
