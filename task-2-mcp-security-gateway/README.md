# MCP Security Gateway

A small Node.js HTTP reverse proxy that authenticates MCP JSON-RPC requests with Bearer tokens and applies role-based filtering to `tools/call`. It includes a downstream mock server so the flow can run locally without an external MCP service.

## Requirements

- Node.js 20 or newer
- No third-party packages required

## Configure and run

Open two PowerShell terminals in this folder.

Terminal 1, start the mock downstream server:

```powershell
npm run mock
```

Terminal 2, configure two distinct tokens and start the gateway:

```powershell
$env:GATEWAY_ADMIN_TOKEN = "local-admin-token-change-me"
$env:GATEWAY_VIEWER_TOKEN = "local-viewer-token-change-me"
$env:DOWNSTREAM_URL = "http://127.0.0.1:4001/mcp"
$env:PORT = "4000"
npm start
```

The gateway listens on `http://127.0.0.1:4000/mcp`. Tokens must each be at least 16 characters. The gateway does not log token values and binds to loopback by default.

## Behavior

- Every request requires `Authorization: Bearer <token>`. The configured admin token maps to role `admin`; the viewer token maps to `viewer`. Missing, malformed, or unknown tokens receive HTTP 401 with JSON-RPC error `-32001`.
- `tools/list` and other well-formed JSON-RPC methods are forwarded to the configured downstream server. The JSON request body is forwarded unchanged, with MCP transport headers (`Accept`, `Content-Type`, `MCP-Protocol-Version`, `Mcp-Session-Id`, and `Last-Event-ID`) preserved.
- A viewer calling a tool whose name starts with `admin_` is blocked at the gateway. The response is HTTP 200 with the original JSON-RPC `id` and error code `-32001`, message `Unauthorized Tool Call`.
- Admin calls and non-admin tool calls continue downstream. The gateway preserves downstream status, body, and relevant response headers.
- Malformed JSON receives `-32700`; invalid JSON-RPC envelopes (including invalid IDs or non-object MCP params), missing IDs on MCP request methods, and JSON-RPC batches are rejected rather than forwarded. Rejecting batches avoids hiding a privileged call inside an uninspected batch. Notifications without IDs do not receive JSON-RPC response bodies.
- Request bodies are limited to 1 MiB. Downstream connection failures return HTTP 502 with `-32000`.

## Quick manual requests

Run these from another PowerShell window after starting both servers:

```powershell
$viewer = "local-viewer-token-change-me"
$admin = "local-admin-token-change-me"

# Viewer can list tools; response is forwarded from the mock server.
curl.exe -i http://127.0.0.1:4000/mcp `
  -H "Authorization: Bearer $viewer" -H "Content-Type: application/json" `
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Viewer is denied with JSON-RPC error -32001.
curl.exe -i http://127.0.0.1:4000/mcp `
  -H "Authorization: Bearer $viewer" -H "Content-Type: application/json" `
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"admin_reset_key","arguments":{"user_id":"u-123"}}}'

# Admin call is forwarded and receives the mock acknowledgement.
curl.exe -i http://127.0.0.1:4000/mcp `
  -H "Authorization: Bearer $admin" -H "Content-Type: application/json" `
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"admin_reset_key","arguments":{"user_id":"u-123"}}}'
```

