# Rate-Limiting and Fallback Router

A Node.js HTTP gateway that reserves estimated prompt plus requested completion tokens against a per-tenant rolling 60-second window, persists usage in a local SQLite database, and retries through a backup model provider when the primary returns HTTP 429 or exceeds the 3-second attempt timeout.

## Requirements

- Node.js 24 or newer (`node:sqlite` is built into Node)
- No third-party packages

## Configure and run with the mock providers

Open two PowerShell terminals in this folder.

Terminal 1 starts a mock provider on port 4201:

```powershell
npm run mock
```

Terminal 2 configures the gateway and uses a primary mode that always returns 429, so the request demonstrates backup routing:

```powershell
$env:PORT = "4200"
$env:TOKEN_LIMIT_PER_MINUTE = "50000"
$env:DATABASE_PATH = ".\data\gateway.sqlite"
$env:PRIMARY_API_URL = "http://127.0.0.1:4201/primary?mode=429"
$env:PRIMARY_API_KEY = "local-primary-mock-key"
$env:PRIMARY_MODEL = "primary-test-model"
$env:SECONDARY_API_URL = "http://127.0.0.1:4201/secondary"
$env:SECONDARY_API_KEY = "local-backup-mock-key"
$env:SECONDARY_MODEL = "backup-test-model"
npm start
```

Try a request with a tenant key:

```powershell
curl.exe -i http://127.0.0.1:4200/v1/chat/completions `
  -H "Authorization: Bearer tenant-alpha-key" `
  -H "Content-Type: application/json" `
  --data '{"messages":[{"role":"user","content":"Summarize this request."}],"max_tokens":300}'
```

The successful response includes `x-gateway-provider: backup`. Change `mode=429` to `mode=timeout` to exercise the 3000 ms timeout failover, or `mode=error` to verify that a non-429 upstream error becomes a sanitized gateway error.

## Provider configuration

Set `PRIMARY_API_URL`, `PRIMARY_API_KEY`, `PRIMARY_MODEL`, `SECONDARY_API_URL`, `SECONDARY_API_KEY`, and `SECONDARY_MODEL`. Both providers use an OpenAI-compatible non-streaming Chat Completions JSON contract. The gateway replaces the incoming model with the configured provider model and does not forward the tenant Bearer key upstream.

## Rate limiting and accounting

- Tenant identity is a SHA-256 digest of the incoming Bearer key; raw tenant keys are not written to SQLite.
- The default limit is 50,000 tokens per rolling 60 seconds. `TOKEN_LIMIT_PER_MINUTE` can lower or raise it for deployments and local exercises.
- Before routing, the gateway atomically reserves a conservative prompt estimate plus `max_tokens` or `max_completion_tokens` (default 1024). Reservations prevent concurrent requests from passing the same remaining quota.
- The estimator counts message JSON, treats CJK and emoji code points individually, and estimates other word pieces at roughly four characters per token. If provider usage reports `usage.total_tokens`, SQLite settles to that actual number; otherwise it keeps the reservation to avoid undercounting.
- SQLite uses a file-backed database in `DATABASE_PATH`, WAL mode, indexed time-window queries, and atomic `BEGIN IMMEDIATE` reservations. Expired events are pruned on each reservation and periodically for quiet tenants.

## Error contract

All gateway errors use this shape and never include upstream bodies, stack traces, or internal exception messages:

```json
{
  "error": {
    "type": "gateway_error",
    "code": "upstream_error",
    "message": "Model provider request failed",
    "request_id": "..."
  }
}
```

Streaming requests are rejected because this router settles quota from the complete response usage object. The project focuses on non-streaming request routing and rate-limit/fallback behavior.
