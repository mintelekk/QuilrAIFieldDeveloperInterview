import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 4101);
// Split sample PII across separate deltas to exercise stateful redaction.
const DELTA_EVENTS = [
  "Contact ",
  "alice@",
  "example.com. SSN ",
  "123-",
  "45-6789. Card ",
  "4111 1111 1111 ",
  "1111.",
];

function sseData(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const mock = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }

  // Consume the request body like a provider, but do not log prompt text or credentials.
  for await (const _chunk of req) {
    // The demo provider does not need to inspect prompt content.
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.flushHeaders?.();

  for (const content of DELTA_EVENTS) {
    res.write(sseData({
      id: "mock-completion",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    }));
    await delay(60);
  }

  res.write(sseData({
    id: "mock-completion",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  }));
  res.write("data: [DONE]\n\n");
  res.end();
});

mock.listen(PORT, "127.0.0.1", () => {
  console.error(`Mock LLM provider listening on http://127.0.0.1:${PORT}/v1/chat/completions`);
});
