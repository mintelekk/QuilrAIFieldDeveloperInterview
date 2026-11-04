// OpenAI-compatible chat proxy: scrub generated text before any stream bytes reach the client.
import { createServer } from "node:http";

// Keep provider credentials in the process environment, never in source or request logs.
const PORT = Number(process.env.PORT ?? 4100);
const LLM_API_URL = new URL(
  process.env.LLM_API_URL ?? "https://api.openai.com/v1/chat/completions",
);
const LLM_API_KEY = process.env.LLM_API_KEY;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_SSE_EVENT_CHARS = 128 * 1024;
const MAX_CARRY_CHARS = 320;
const MAX_CHOICE_STATES = 32;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT must be an integer from 1 through 65535");
}
if (!["http:", "https:"].includes(LLM_API_URL.protocol)) {
  throw new Error("LLM_API_URL must use http or https");
}
if (!LLM_API_KEY) {
  throw new Error("LLM_API_KEY must be configured in the environment");
}

// These patterns run on completed safe text; the carry buffer below protects partial matches.
const EMAIL_PATTERN = /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SSN_PATTERN = /\b(?:\d{3}-\d{2}-\d{4}|\d{9})\b/g;
const CARD_PATTERN = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const EMAIL_TAIL_PATTERN = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~@-]+$/;
const NUMBER_TAIL_PATTERN = /(?<![A-Za-z0-9])(?:\d[ -]?){1,19}\p{P}?$/u;
const REDACTED = "[REDACTED]";

// Luhn filtering reduces false positives from ordinary long numeric identifiers.
function passesLuhn(candidate) {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (doubleDigit) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

// Apply replacements only after a boundary proves the candidate is complete.
function redactCompleteText(text) {
  return text
    .replace(EMAIL_PATTERN, REDACTED)
    .replace(CARD_PATTERN, (match) => (passesLuhn(match) ? REDACTED : match))
    .replace(SSN_PATTERN, REDACTED);
}

// Each choice gets independent carry state so interleaved deltas cannot join together.
class StreamingTextRedactor {
  pending = "";

  push(fragment) {
    const combined = this.pending + fragment;
    let safeLength = combined.length;

    // Keep a possible email token intact until its right-hand boundary arrives.
    const emailTail = EMAIL_TAIL_PATTERN.exec(combined);
    if (emailTail) safeLength = Math.min(safeLength, emailTail.index);

    // Card numbers can contain spaces or hyphens, so retain a trailing numeric run.
    const numberTail = NUMBER_TAIL_PATTERN.exec(combined);
    if (numberTail) safeLength = Math.min(safeLength, numberTail.index);

    // Valid supported PII patterns fit inside this bound; cap carry for hostile long tokens.
    if (combined.length - safeLength > MAX_CARRY_CHARS) {
      safeLength = combined.length - MAX_CARRY_CHARS;
    }

    const ready = combined.slice(0, safeLength);
    this.pending = combined.slice(safeLength);
    return redactCompleteText(ready);
  }

  flush() {
    const finalText = redactCompleteText(this.pending);
    this.pending = "";
    return finalText;
  }
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function makeSseFrame(payload, fields = []) {
  return `${fields.join("\n")}${fields.length ? "\n" : ""}data: ${JSON.stringify(payload)}\n\n`;
}

// Parse one SSE event at a time; never retain the complete provider response.
class ChatCompletionStreamGuard {
  buffer = "";
  decoder = new TextDecoder();
  redactors = new Map();

  // Streaming decode preserves UTF-8 characters split between network chunks.
  push(bytes) {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    return this.drainFrames();
  }

  // EOF may leave a final unterminated event and an unfinished PII candidate to redact.
  finish() {
    this.buffer += this.decoder.decode();
    let output = "";

    if (this.buffer.length > 0) {
      output += this.processFrame(this.buffer);
      this.buffer = "";
    }
    output += this.flushAll();
    return output;
  }

  // Only complete SSE frames are parsed; the trailing partial frame stays bounded in buffer.
  drainFrames() {
    let output = "";
    while (true) {
      const boundary = /\r?\n\r?\n/.exec(this.buffer);
      if (!boundary) break;

      const end = boundary.index + boundary[0].length;
      if (end > MAX_SSE_EVENT_CHARS) throw new Error("Upstream SSE event exceeded the configured size limit");
      const frame = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      output += this.processFrame(frame);
    }

    if (this.buffer.length > MAX_SSE_EVENT_CHARS) {
      throw new Error("Upstream SSE event exceeded the configured size limit");
    }
    return output;
  }

  getRedactor(index) {
    if (!this.redactors.has(index)) {
      if (this.redactors.size >= MAX_CHOICE_STATES) throw new Error("Upstream stream exceeded the choice-state limit");
      this.redactors.set(index, new StreamingTextRedactor());
    }
    return this.redactors.get(index);
  }

  processFrame(frame) {
    const normalized = frame.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    const dataLines = lines.filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) return frame;

    const data = dataLines.map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    // Release any withheld final text before forwarding the provider terminator.
    if (data === "[DONE]") return this.flushAll() + frame;

    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      // Never pass an unparseable data frame through because it cannot be inspected.
      throw new Error("Malformed JSON in upstream SSE event");
    }

    // Sanitize each textual delta before it is serialized back to the client.
    if (Array.isArray(payload?.choices)) {
      for (const [position, choice] of payload.choices.entries()) {
        const delta = choice?.delta;
        if (typeof delta?.content !== "string") continue;

        const index = Number.isInteger(choice.index) ? choice.index : position;
        const redactor = this.getRedactor(index);
        delta.content = redactor.push(delta.content);
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          delta.content += redactor.flush();
        }
      }
    }

    // Keep event and id metadata while replacing the original data field with sanitized JSON.
    const preservedFields = lines.filter((line) => line !== "" && !line.startsWith("data:"));
    return makeSseFrame(payload, preservedFields);
  }

  // Emit any final safe text or redaction marker before the stream terminates.
  flushAll() {
    let output = "";
    for (const [index, redactor] of this.redactors) {
      const content = redactor.flush();
      if (!content) continue;
      output += makeSseFrame({
        choices: [{ index, delta: { content }, finish_reason: null }],
      });
    }
    return output;
  }
}

// Pause reading upstream whenever the client socket cannot accept more bytes.
function writeWithBackpressure(res, chunk) {
  if (!chunk) return Promise.resolve();
  if (res.destroyed) return Promise.reject(new Error("Client disconnected"));
  if (res.write(chunk)) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Client disconnected"));
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

const gateway = createServer(async (req, res) => {
  if (req.method !== "POST" || new URL(req.url ?? "/", "http://localhost").pathname !== "/v1/chat/completions") {
    res.setHeader("allow", "POST");
    sendJson(res, req.method === "POST" ? 404 : 405, rpcError(null, -32600, "Expected POST /v1/chat/completions"));
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    const statusCode = error.statusCode ?? 400;
    sendJson(res, statusCode, rpcError(null, -32600, "Invalid JSON request body"));
    return;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.messages)) {
    sendJson(res, 400, rpcError(null, -32600, "Expected a chat completion request with a messages array"));
    return;
  }

  // Tie upstream work to the downstream client lifetime.
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  let providerResponse;
  try {
    // The client controls the prompt; the gateway controls upstream auth and streaming.
    providerResponse = await fetch(LLM_API_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${LLM_API_KEY}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({ ...payload, stream: true }),
      signal: controller.signal,
    });
  } catch {
    sendJson(res, 502, rpcError(null, -32000, "LLM provider unavailable"));
    return;
  }

  // Do not expose a non-stream provider error body, which has not passed redaction.
  const contentType = providerResponse.headers.get("content-type") ?? "";
  if (!providerResponse.ok || !providerResponse.body || !contentType.toLowerCase().includes("text/event-stream")) {
    sendJson(res, providerResponse.status >= 400 ? providerResponse.status : 502, rpcError(null, -32000, "LLM provider did not return a stream"));
    return;
  }

  // Disable intermediary buffering so each sanitized SSE event can reach the client promptly.
  res.writeHead(providerResponse.status, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();

  const guard = new ChatCompletionStreamGuard();
  try {
    // Await each client write before reading again so socket backpressure reaches the provider stream.
    for await (const chunk of providerResponse.body) {
      await writeWithBackpressure(res, guard.push(chunk));
    }
    await writeWithBackpressure(res, guard.finish());
    res.end();
  } catch {
    if (controller.signal.aborted || res.destroyed) return;
    console.error("LLM stream ended before it could be safely processed.");
    if (!res.writableEnded) {
      const safeError = `event: error\ndata: ${JSON.stringify({ error: "Stream interrupted" })}\n\n`;
      res.end(safeError);
    }
  }
});

gateway.listen(PORT, "127.0.0.1", () => {
  console.error(`LLM streaming guardrail listening on http://127.0.0.1:${PORT}`);
  console.error(`LLM provider: ${LLM_API_URL.origin}${LLM_API_URL.pathname}`);
});
