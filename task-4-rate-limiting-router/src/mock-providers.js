import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 4201);

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
  });
  res.end(body);
}

// Keep the timeout fixture just beyond the gateway's 3-second attempt deadline.
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const mock = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }

  let payload;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    sendJson(res, 400, { error: { message: "Invalid JSON" } });
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  // These modes exercise failover and confirm that upstream diagnostics never reach clients.
  if (url.pathname === "/primary" && url.searchParams.get("mode") === "429") {
    // The gateway must discard this deliberately sensitive diagnostic body.
    sendJson(res, 429, { error: { message: "quota exhausted", stack: "internal mock stack trace" } });
    return;
  }
  if (url.pathname === "/primary" && url.searchParams.get("mode") === "timeout") {
    await delay(3_500);
    if (!res.destroyed) {
      sendJson(res, 200, { choices: [], usage: { total_tokens: 99 } });
    }
    return;
  }
  if (url.pathname === "/primary" && url.searchParams.get("mode") === "error") {
    sendJson(res, 500, { error: { message: "internal failure", stack: "mock stack trace" } });
    return;
  }

  sendJson(res, 200, {
    id: "mock-completion",
    object: "chat.completion",
    model: payload.model,
    choices: [{ index: 0, message: { role: "assistant", content: `served-by-${url.pathname.slice(1)}` }, finish_reason: "stop" }],
    usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
  });
});

mock.listen(PORT, "127.0.0.1", () => {
  console.error(`Mock model providers listening on http://127.0.0.1:${PORT}`);
});
