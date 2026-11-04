import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 4000);
const DOWNSTREAM_URL = new URL(
  process.env.DOWNSTREAM_URL ?? "http://127.0.0.1:4001/mcp",
);
// Bound memory use when parsing an untrusted request body.
const MAX_BODY_BYTES = 1024 * 1024;

// Fail at startup rather than silently running with a missing or weak credential.
function requiredToken(name) {
  const value = process.env[name];
  if (!value || value.length < 16) {
    throw new Error(`${name} must be configured with at least 16 characters`);
  }
  return value;
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT must be an integer from 1 through 65535");
}
if (!["http:", "https:"].includes(DOWNSTREAM_URL.protocol)) {
  throw new Error("DOWNSTREAM_URL must use http or https");
}

// Store fixed-size digests and compare them in constant time; never log raw tokens.
const roleTokens = [
  { role: "admin", digest: createHash("sha256").update(requiredToken("GATEWAY_ADMIN_TOKEN")).digest() },
  { role: "viewer", digest: createHash("sha256").update(requiredToken("GATEWAY_VIEWER_TOKEN")).digest() },
];
if (timingSafeEqual(roleTokens[0].digest, roleTokens[1].digest)) {
  throw new Error("GATEWAY_ADMIN_TOKEN and GATEWAY_VIEWER_TOKEN must be different");
}

// Map a valid Bearer credential to one configured role; unknown tokens fail closed.
function getRole(authorization) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization ?? "");
  if (!match) return null;

  const candidate = createHash("sha256").update(match[1]).digest();
  for (const entry of roleTokens) {
    if (timingSafeEqual(candidate, entry.digest)) return entry.role;
  }
  return null;
}

function writeJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

// Keep gateway failures in JSON-RPC error shape so clients can handle them uniformly.
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Forward MCP transport headers only; the caller Bearer token stays at the gateway.
function forwardedHeaders(req) {
  const headers = new Headers();
  for (const name of [
    "accept",
    "content-type",
    "mcp-protocol-version",
    "mcp-session-id",
    "last-event-id",
  ]) {
    const value = req.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  return headers;
}

// Authorize at the HTTP edge before any downstream call can execute.
const gateway = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    writeJson(res, 405, rpcError(null, -32600, "Only POST is supported"));
    return;
  }

  let rawBody;
  try {
    rawBody = await readBody(req);
  } catch (error) {
    const statusCode = error.statusCode ?? 400;
    writeJson(res, statusCode, rpcError(null, -32700, "Unable to read request body"));
    return;
  }

  let message;
  try {
    message = JSON.parse(rawBody);
  } catch {
    writeJson(res, 400, rpcError(null, -32700, "Parse error"));
    return;
  }

  // Validate the JSON-RPC envelope before reading method-specific fields.
  const hasId = Boolean(message && typeof message === "object" && Object.hasOwn(message, "id"));
  const id = hasId ? message.id : null;
  const validId = id === null || typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
  const validParams =
    message && typeof message === "object" &&
    (!Object.hasOwn(message, "params") || (message.params !== null && typeof message.params === "object" && !Array.isArray(message.params)));

  if (
    !message || typeof message !== "object" || Array.isArray(message) ||
    message.jsonrpc !== "2.0" || typeof message.method !== "string" || message.method.length === 0 ||
    !validParams || (hasId && !validId)
  ) {
    writeJson(res, 400, rpcError(null, -32600, "Invalid Request"));
    return;
  }

  // MCP request methods need a response ID. Reject them rather than treating
  // them as notifications with no response channel.
  if (!hasId && ["initialize", "ping", "tools/list", "tools/call"].includes(message.method)) {
    writeJson(res, 400, rpcError(null, -32600, "Invalid Request: request ID is required"));
    return;
  }

  const role = getRole(req.headers.authorization);
  if (!role) {
    if (!hasId) {
      res.writeHead(401, { "cache-control": "no-store" });
      res.end();
      return;
    }
    writeJson(res, 401, rpcError(id, -32001, "Unauthorized Tool Call"));
    return;
  }

  // Block privileged calls before the downstream can execute them.
  if (
    message.method === "tools/call" &&
    typeof message.params?.name === "string" &&
    message.params.name.startsWith("admin_") &&
    role !== "admin"
  ) {
    writeJson(res, 200, rpcError(id, -32001, "Unauthorized Tool Call"));
    return;
  }

  // Forward the original JSON body unchanged after authorization.
  try {
    const downstream = await fetch(DOWNSTREAM_URL, {
      method: "POST",
      headers: forwardedHeaders(req),
      body: rawBody,
      redirect: "manual",
    });
    // Preserve the downstream status and response payload for the MCP client.
    const body = Buffer.from(await downstream.arrayBuffer());
    const headers = {
      "content-length": body.length,
      "cache-control": downstream.headers.get("cache-control") ?? "no-store",
    };
    for (const name of ["content-type", "mcp-session-id", "www-authenticate", "retry-after"]) {
      const value = downstream.headers.get(name);
      if (value) headers[name] = value;
    }
    res.writeHead(downstream.status, headers);
    res.end(body);
  } catch {
    console.error("Gateway could not reach the downstream MCP server.");
    writeJson(res, 502, rpcError(id, -32000, "Downstream server unavailable"));
  }
});

// Loopback binding keeps this demo local; production needs explicit network controls.
gateway.listen(PORT, "127.0.0.1", () => {
  console.error(`MCP security gateway listening on http://127.0.0.1:${PORT}/mcp`);
  console.error(`Downstream MCP server: ${DOWNSTREAM_URL.origin}${DOWNSTREAM_URL.pathname}`);
});

