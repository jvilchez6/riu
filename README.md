# Voice Figma Agent

Talk to a Claude agent and it builds the workflows in **Figma / FigJam** for you: process flows, approval chains, swimlanes, user journeys, state machines.

```
 Browser (mic) ──speech-to-text──▶ Node server ──▶ Claude (claude-opus-5-5)
      ▲                                │                 │ tool calls
      └──── spoken reply (TTS) ◀───────┘                 ▼
                                               Figma MCP server ──▶ your Figma files
```

- **Voice in:** hold the mic button or the **Space** bar and speak. The browser's Web Speech API turns it into text (Chrome, Edge or Safari).
- **Agent:** each transcript goes to a Claude agent loop. The agent can call every tool the Figma MCP server exposes (`generate_diagram`, `use_figma`, `create_new_file`, `get_screenshot`, …). It also loads Figma's own usage guides from the MCP server.
- **Iterative:** each browser tab has its own conversation, so you can follow up with "add a rejection branch after manager review" or "color the IT lane blue".
- **Voice out:** the short final reply is read aloud. Untick *Speak replies* to turn this off.

## Setup

1. **Node 20+**, then:
   ```bash
   npm install
   cp .env.example .env
   ```
2. **Anthropic API key:** set `ANTHROPIC_API_KEY` in `.env`.
3. **Figma MCP server:** pick one and set `FIGMA_MCP_URL` (plus `FIGMA_MCP_TOKEN` if needed):
   - **Desktop app (local):** in Figma desktop, open *Preferences → Enable Dev Mode MCP Server*, then use `http://127.0.0.1:3845/mcp`. No token needed.
   - **Remote server:** `https://mcp.figma.com/mcp` with an OAuth access token in `FIGMA_MCP_TOKEN`.

   Which tools you get (including the ones that write to Figma) depends on the server and your Figma plan. On startup the console lists the tools it found.
4. Run it:
   ```bash
   npm run dev        # or: npm run build && npm start
   ```
   Then open http://localhost:3000.

## Example commands

- "Create a FigJam flowchart for employee onboarding with swimlanes for HR, IT and the manager."
- "Add a decision after background check: if it fails, go to offer withdrawn."
- "Make a polished design frame of this workflow as cards, using our brand purple."
- "Take a screenshot and tell me if anything overlaps."

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Claude API key |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model the agent runs on |
| `CLAUDE_EFFORT` | `medium` | `low` gives faster voice turns; `high` or `xhigh` handles complex layouts better |
| `FIGMA_MCP_URL` | `http://127.0.0.1:3845/mcp` | Figma MCP endpoint |
| `FIGMA_MCP_TOKEN` | none | Bearer token for the remote Figma MCP server |
| `FIGMA_TOOLS` | all | Comma-separated allowlist of Figma tools to expose |
| `PORT` | `3000` | HTTP port |

## Project layout

- `src/server.ts`: Express server, one agent per browser session, streams progress over server-sent events
- `src/agent.ts`: Claude agent loop (streaming, tool-input validation, refusal fallback, prompt caching)
- `src/figma.ts`: Figma MCP client that maps MCP tools to Claude tools and loads Figma's skill guides
- `public/`: voice UI (speech recognition, live transcript, spoken replies)

## Notes

- Speech recognition runs in the browser. Chrome sends the audio to Google's speech service, and Safari uses Apple's.
- Conversations live in memory and reset when the server restarts.
