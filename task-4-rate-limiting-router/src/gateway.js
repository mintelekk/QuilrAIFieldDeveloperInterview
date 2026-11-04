import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.PORT ?? 4200);
const TOKEN_LIMIT_PER_MINUTE = Number(process.env.TOKEN_LIMIT_PER_MINUTE ?? 50_000);
const WINDOW_MS = 60_000;
const PROVIDER_TIMEOUT_MS = 3_000;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_COMPLETION_TOKENS = 1024;
const DATABASE_PATH = resolve(process.env.DATABASE_PATH ?? "./data/gateway.sqlite");

function readProvider(name, defaults) {
  const url = process.env[`${name}_API_URL`];
  const apiKey = process.env[`${name}_API_KEY`];
  const model = process.env[`${name}_MODEL`];
  if (!url || !apiKey || !model) {
    throw new Error(`${name} provider requires API_URL, API_KEY, and MODEL environment variables`);
  }
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${name}_API_URL must use http or https`);
  }
  return { name: defaults.name, url: parsed, apiKey, model };
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT must be an integer from 1 through 65535");
}
if (!Number.isSafeInteger(TOKEN_LIMIT_PER_MINUTE) || TOKEN_LIMIT_PER_MINUTE < 1) {
  throw new Error("TOKEN_LIMIT_PER_MINUTE must be a positive safe integer");
}

const primary = readProvider("PRIMARY", { name: "primary" });
const secondary = readProvider("SECONDARY", { name: "backup" });
await mkdir(dirname(DATABASE_PATH), { recursive: true });

// SQLite serializes reservation writes across concurrent gateway processes.
const database = new DatabaseSync(DATABASE_PATH, { timeout: 5_000 });
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS token_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL UNIQUE,
    tenant_hash TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens >= 0),
    actual_tokens INTEGER CHECK (actual_tokens IS NULL OR actual_tokens >= 0)
  );
  CREATE INDEX IF NOT EXISTS token_events_tenant_window
    ON token_events (tenant_hash, started_at_ms);
`);

class RateLimitExceeded extends Error {
  constructor(usedTokens, requestedTokens, retryAfterSeconds) {
    super("Tenant token window would exceed its limit");
    this.usedTokens = usedTokens;
    this.requestedTokens = requestedTokens;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function cleanExpiredEvents(now = Date.now()) {
  // A request stops consuming the rolling-window budget once its minute has elapsed.
  database.prepare("DELETE FROM token_events WHERE started_at_ms <= ?").run(now - WINDOW_MS);
}

function reserveTokens({ requestId, tenantHash, tokens, now = Date.now() }) {
  // Lock before reading usage so concurrent requests cannot all approve against the same balance.
  database.exec("BEGIN IMMEDIATE");
  try {
    cleanExpiredEvents(now);
    const events = database.prepare(`
      SELECT started_at_ms,
             COALESCE(actual_tokens, reserved_tokens) AS tokens
      FROM token_events
      WHERE tenant_hash = ? AND started_at_ms > ?
      ORDER BY started_at_ms ASC, event_id ASC
    `).all(tenantHash, now - WINDOW_MS);
    const usedTokens = events.reduce((sum, event) => sum + Number(event.tokens), 0);

    if (usedTokens + tokens > TOKEN_LIMIT_PER_MINUTE) {
      // Find when enough oldest usage will expire to admit this request again.
      let excess = usedTokens + tokens - TOKEN_LIMIT_PER_MINUTE;
      let retryAt = now + WINDOW_MS;
      for (const event of events) {
        excess -= Number(event.tokens);
        if (excess <= 0) {
          retryAt = Number(event.started_at_ms) + WINDOW_MS;
          break;
        }
      }
      throw new RateLimitExceeded(
        usedTokens,
        tokens,
        Math.max(1, Math.ceil((retryAt - now) / 1000)),
      );
    }

    database.prepare(`
      INSERT INTO token_events (request_id, tenant_hash, started_at_ms, reserved_tokens)
      VALUES (?, ?, ?, ?)
    `).run(requestId, tenantHash, now, tokens);
    database.exec("COMMIT");
    return { usedTokens, remainingTokens: TOKEN_LIMIT_PER_MINUTE - usedTokens - tokens };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function settleTokens(requestId, actualTokens) {
  if (!Number.isSafeInteger(actualTokens) || actualTokens < 0) return;
  if (actualTokens === 0) {
    // Rejected or failed provider calls did not consume tokens, so release their reservation.
    database.prepare("DELETE FROM token_events WHERE request_id = ?").run(requestId);
    return;
  }
  database.prepare(`
    UPDATE token_events SET actual_tokens = ?
    WHERE request_id = ? AND actual_tokens IS NULL
  `).run(actualTokens, requestId);
}

// A conservative tokenizer estimate reserves prompt plus maximum completion before upstream work.
function estimateTokens(text) {
  const parts = text.match(/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Extended_Pictographic}|[\p{L}\p{N}]+|[^\s]/gu) ?? [];
  let total = 0;
  for (const part of parts) {
    if (/^(?:\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Extended_Pictographic})$/u.test(part)) {
      total += 1;
    } else {
      total += Math.max(1, Math.ceil(Array.from(part).length / 4));
    }
  }
  return total;
}

function bearerTenantHash(header) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(header ?? "");
  return match ? createHash("sha256").update(match[1]).digest("hex") : null;
}

function sendGatewayError(res, statusCode, code, message, requestId, details = {}) {
  const body = Buffer.from(JSON.stringify({
    error: {
      type: "gateway_error",
      code,
      message,
      request_id: requestId,
      ...details,
    },
  }));
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "x-request-id": requestId,
    ...(details.retry_after_seconds ? { "retry-after": String(details.retry_after_seconds) } : {}),
  });
  res.end(body);
}

async function readRequestJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw Object.assign(new Error("request too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readProviderJson(response) {
  if (!response.body) throw new Error("provider returned no response body");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("provider response exceeded size limit");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function callProvider(provider, requestPayload, clientSignal) {
  const attemptController = new AbortController();
  let timedOut = false;
  // Each provider gets its own deadline; the caller's abort also cancels the active attempt.
  const timer = setTimeout(() => {
    timedOut = true;
    attemptController.abort();
  }, PROVIDER_TIMEOUT_MS);
  const signal = AbortSignal.any([clientSignal, attemptController.signal]);

  try {
    // Keep the provider-specific model choice private to this outbound request.
    const response = await fetch(provider.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ ...requestPayload, model: provider.model, stream: false }),
      signal,
    });

    if (response.status === 429) {
      response.body?.cancel().catch(() => {});
      return { kind: "rate_limited" };
    }
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      return { kind: "upstream_error" };
    }

    const payload = await readProviderJson(response);
    if (!payload || typeof payload !== "object" || payload.error) {
      return { kind: "invalid_response" };
    }
    return { kind: "success", payload };
  } catch {
    if (clientSignal.aborted) return { kind: "client_aborted" };
    if (timedOut) return { kind: "timeout" };
    return { kind: "upstream_error" };
  } finally {
    clearTimeout(timer);
  }
}

function actualUsageTokens(payload, reservation) {
  const total = payload?.usage?.total_tokens;
  return Number.isSafeInteger(total) && total >= 0 ? total : reservation;
}

async function handleGatewayRequest(req, res, requestId) {
  // Validate the gateway contract before reserving quota or contacting either provider.
  if (req.method !== "POST" || new URL(req.url ?? "/", "http://localhost").pathname !== "/v1/chat/completions") {
    res.setHeader("allow", "POST");
    sendGatewayError(res, req.method === "POST" ? 404 : 405, "invalid_route", "Expected POST /v1/chat/completions", requestId);
    return;
  }

  const tenantHash = bearerTenantHash(req.headers.authorization);
  if (!tenantHash) {
    sendGatewayError(res, 401, "unauthorized", "A Bearer tenant API key is required", requestId);
    return;
  }

  let payload;
  try {
    payload = await readRequestJson(req);
  } catch (error) {
    sendGatewayError(res, error.statusCode ?? 400, "invalid_request", "Request body must be valid JSON and no larger than 1 MiB", requestId);
    return;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.messages)) {
    sendGatewayError(res, 400, "invalid_request", "A chat completion request with a messages array is required", requestId);
    return;
  }
  if (payload.stream === true) {
    sendGatewayError(res, 400, "streaming_not_supported", "This router accepts non-streaming completion requests", requestId);
    return;
  }
  if (payload.max_tokens !== undefined && payload.max_completion_tokens !== undefined) {
    sendGatewayError(res, 400, "invalid_request", "Use only one completion token limit field", requestId);
    return;
  }

  const requestedCompletionTokens = payload.max_completion_tokens ?? payload.max_tokens ?? DEFAULT_MAX_COMPLETION_TOKENS;
  if (!Number.isSafeInteger(requestedCompletionTokens) || requestedCompletionTokens < 1) {
    sendGatewayError(res, 400, "invalid_request", "Completion token limit must be a positive integer", requestId);
    return;
  }
  // Count tools and response-format schemas too; they can consume prompt tokens alongside messages.
  const promptPayload = { ...payload };
  delete promptPayload.model;
  delete promptPayload.max_tokens;
  delete promptPayload.max_completion_tokens;
  delete promptPayload.stream;
  const promptTokens = estimateTokens(JSON.stringify(promptPayload));
  const reservation = promptTokens + requestedCompletionTokens;
  if (!Number.isSafeInteger(reservation)) {
    sendGatewayError(res, 400, "invalid_request", "Estimated token reservation is invalid", requestId);
    return;
  }

  const providerPayload = { ...payload };
  if (providerPayload.max_tokens === undefined && providerPayload.max_completion_tokens === undefined) {
    providerPayload.max_tokens = requestedCompletionTokens;
  }
  const reservationId = requestId;
  try {
    // Reserve the estimated maximum up front; SQLite makes this decision atomic per tenant.
    reserveTokens({ requestId: reservationId, tenantHash, tokens: reservation });
  } catch (error) {
    if (error instanceof RateLimitExceeded) {
      sendGatewayError(res, 429, "token_limit_exceeded", "Tenant token limit exceeded for the rolling 60-second window", requestId, {
        limit_tokens: TOKEN_LIMIT_PER_MINUTE,
        used_tokens: error.usedTokens,
        requested_tokens: error.requestedTokens,
        retry_after_seconds: error.retryAfterSeconds,
      });
      return;
    }
    console.error("SQLite token reservation failed.");
    sendGatewayError(res, 503, "rate_limiter_unavailable", "Gateway rate limiter is temporarily unavailable", requestId);
    return;
  }

  const clientController = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) clientController.abort();
  });

  let routedProvider = primary;
  let outcome = await callProvider(primary, providerPayload, clientController.signal);
  // Only throttling and deadline expiry trigger failover; other errors stay visible as sanitized gateway failures.
  if (outcome.kind === "rate_limited" || outcome.kind === "timeout") {
    routedProvider = secondary;
    outcome = await callProvider(secondary, providerPayload, clientController.signal);
  }

  if (outcome.kind === "client_aborted" || clientController.signal.aborted) {
    settleTokens(reservationId, reservation);
    return;
  }
  if (outcome.kind !== "success") {
    settleTokens(reservationId, 0);
    if (outcome.kind === "rate_limited" || outcome.kind === "timeout") {
      sendGatewayError(res, 503, "providers_unavailable", "Primary and backup providers are unavailable", requestId);
    } else {
      sendGatewayError(res, 502, "upstream_error", "Model provider request failed", requestId);
    }
    return;
  }

  // Replace the estimate with provider-reported usage when available, then return the completion unchanged.
  settleTokens(reservationId, actualUsageTokens(outcome.payload, reservation));
  const body = Buffer.from(JSON.stringify(outcome.payload));
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "x-request-id": requestId,
    "x-gateway-provider": routedProvider.name,
  });
  res.end(body);
}

const gateway = createServer((req, res) => {
  const requestId = randomUUID();
  void handleGatewayRequest(req, res, requestId).catch(() => {
    console.error("Unhandled gateway request failure.");
    if (!res.headersSent) {
      sendGatewayError(res, 500, "internal_error", "Gateway request failed", requestId);
    } else if (!res.writableEnded) {
      res.end();
    }
  });
});

// Prune quiet tenants too; reserveTokens also removes expired events transactionally.
const cleanupTimer = setInterval(() => {
  try {
    cleanExpiredEvents();
  } catch {
    console.error("SQLite token-window cleanup failed.");
  }
}, WINDOW_MS);
cleanupTimer.unref();

gateway.listen(PORT, "127.0.0.1", () => {
  console.error(`Rate-limit and fallback gateway listening on http://127.0.0.1:${PORT}`);
  console.error(`SQLite database: ${DATABASE_PATH}`);
});

function shutdown() {
  clearInterval(cleanupTimer);
  gateway.close(() => {
    database.close();
    process.exit(0);
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
