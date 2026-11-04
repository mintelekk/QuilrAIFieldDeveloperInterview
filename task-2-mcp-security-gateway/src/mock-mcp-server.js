import { createServer } from "node:http";

// This server supplies deterministic responses for local gateway development only.
const PORT = Number(process.env.MOCK_PORT ?? 4001);
// Expose one regular tool and one protected tool to exercise the gateway policy.
const tools = [
  {
    name: "lookup_status",
    description: "Return a sample service status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "admin_reset_key",
    description: "Simulate an administrative key reset.",
    inputSchema: {
      type: "object",
      properties: { user_id: { type: "string" } },
      required: ["user_id"],
      additionalProperties: false,
    },
  },
];

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
  });
  res.end(body);
}

// The mock speaks enough MCP JSON-RPC for an end-to-end local proxy walkthrough.
const mock = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }

  let message;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }

  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    sendJson(res, 400, { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "Invalid Request" } });
    return;
  }
  // JSON-RPC notifications have no response body.
  if (!Object.hasOwn(message, "id")) {
    res.writeHead(202);
    res.end();
    return;
  }

  const { id, method, params } = message;
  if (method === "initialize") {
    sendJson(res, 200, {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-downstream", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "ping") {
    sendJson(res, 200, { jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    sendJson(res, 200, { jsonrpc: "2.0", id, result: { tools } });
    return;
  }
  if (method === "tools/call") {
    if (params?.name === "lookup_status") {
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: "Mock service status: operational" }] },
      });
      return;
    }
    // Never perform a real key reset in the mock downstream.
    if (params?.name === "admin_reset_key") {
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `Mock key reset accepted for ${params.arguments?.user_id ?? "unknown user"}` }],
        },
      });
      return;
    }
    sendJson(res, 200, {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "Unknown tool" },
    });
    return;
  }
  sendJson(res, 200, {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not found" },
  });
});

mock.listen(PORT, "127.0.0.1", () => {
  console.error(`Mock MCP server listening on http://127.0.0.1:${PORT}/mcp`);
});
