const sessionId = crypto.randomUUID();
const log = document.getElementById("log");
const mic = document.getElementById("mic");
const interim = document.getElementById("interim");
const typed = document.getElementById("typed");
const textInput = document.getElementById("text");
const speakToggle = document.getElementById("speak");

let busy = false;

function add(cls, text) {
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = text;
  log.appendChild(el);
  el.scrollIntoView({ behavior: "smooth", block: "end" });
  return el;
}

function speak(text) {
  if (!speakToggle.checked || !text || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

async function send(transcript) {
  transcript = transcript.trim();
  if (!transcript || busy) return;
  busy = true;
  add("msg user", transcript);
  let reply = add("msg", "…");
  let text = "";

  try {
    const res = await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, transcript }),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop();
      for (const frame of frames) {
        if (!frame.startsWith("data: ")) continue;
        const e = JSON.parse(frame.slice(6));
        if (e.type === "text") {
          text += e.text;
          reply.textContent = text;
        } else if (e.type === "tool") {
          if (e.status === "start") {
            // Text before a tool call is narration: keep it, and start a fresh bubble after the tool line.
            if (!text) reply.remove();
            add("tool", `⚙︎ ${e.name}…`);
            reply = add("msg", "…");
            text = "";
          }
          if (e.status === "error") add("tool error", `✗ ${e.name}: ${e.detail}`);
        } else if (e.type === "done") {
          reply.textContent = text || e.reply || "Done.";
          log.appendChild(reply);
          speak(e.reply);
        } else if (e.type === "error") {
          add("msg error", e.message);
        }
      }
    }
  } catch (err) {
    add("msg error", String(err.message || err));
  } finally {
    busy = false;
  }
}

// --- Voice input (Web Speech API: Chrome, Edge, Safari) ---
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let finalTranscript = "";

if (SR) {
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "en-US";
  recognition.onresult = (ev) => {
    let partial = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalTranscript += r[0].transcript + " ";
      else partial += r[0].transcript;
    }
    interim.textContent = finalTranscript + partial;
  };
  recognition.onend = () => {
    mic.classList.remove("rec");
    const t = finalTranscript;
    finalTranscript = "";
    interim.textContent = "";
    send(t);
  };
} else {
  mic.disabled = true;
  mic.title = "Speech recognition isn't supported in this browser; type instead.";
}

function startTalking() {
  if (!recognition || busy || mic.classList.contains("rec")) return;
  speechSynthesis?.cancel();
  finalTranscript = "";
  mic.classList.add("rec");
  recognition.start();
}
function stopTalking() {
  if (recognition && mic.classList.contains("rec")) recognition.stop();
}

mic.addEventListener("pointerdown", startTalking);
mic.addEventListener("pointerup", stopTalking);
mic.addEventListener("pointerleave", stopTalking);
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && document.activeElement !== textInput && !e.repeat) { e.preventDefault(); startTalking(); }
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && document.activeElement !== textInput) { e.preventDefault(); stopTalking(); }
});

typed.addEventListener("submit", (e) => {
  e.preventDefault();
  send(textInput.value);
  textInput.value = "";
});
