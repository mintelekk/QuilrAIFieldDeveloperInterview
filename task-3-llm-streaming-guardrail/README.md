# LLM Streaming Guardrail

A Node.js HTTP proxy for OpenAI-compatible Chat Completions streams. It forces provider streaming, inspects each SSE delta, and redacts email addresses, SSNs, and Luhn-valid credit card numbers before those bytes are sent to the client.

## Requirements

- Node.js 20 or newer
- No third-party packages required

## Run the local demonstration

Open two PowerShell terminals in this folder.

Terminal 1 starts a mock provider that deliberately splits PII across separate stream deltas:

```powershell
npm run mock
```

Terminal 2 points the gateway at the mock and starts it:

```powershell
$env:LLM_API_KEY = "local-mock-key-not-a-real-secret"
$env:LLM_API_URL = "http://127.0.0.1:4101/v1/chat/completions"
$env:PORT = "4100"
npm start
```

The gateway listens on `http://127.0.0.1:4100/v1/chat/completions`. In another PowerShell window, send a chat request:

```powershell
curl.exe -N http://127.0.0.1:4100/v1/chat/completions `
  -H "Content-Type: application/json" `
  --data '{"model":"mock","messages":[{"role":"user","content":"Generate a sample contact and account details."}]}'
```

The mock emits an email, SSN, and test card number split across deltas. The gateway should stream the surrounding text while replacing each sensitive value with `[REDACTED]`.

## Use a provider

Set `LLM_API_KEY` and optionally `LLM_API_URL` in the gateway process environment. The endpoint accepts an OpenAI-compatible chat completion JSON object with a `messages` array, overrides `stream` to `true`, and authenticates upstream with the configured Bearer key. Provider keys and prompts are never logged.

## Streaming and redaction behavior

- The proxy parses SSE frames incrementally. It does not buffer the full provider response.
- Text deltas are passed through a stateful redactor per choice. A short carry buffer keeps possible email and numeric PII candidates intact across provider chunk boundaries.
- Safe text is emitted as soon as a boundary makes it possible to rule out a partial match. At most 320 trailing characters are retained for candidate detection; each SSE event is limited to 128 KiB.
- Emails, formatted or unformatted SSNs, and 13 to 19 digit card candidates separated by spaces or hyphens are redacted. Card candidates are replaced only when they pass the Luhn check.
- The response uses `text/event-stream`, disables intermediary buffering, and respects client backpressure. If the client disconnects, the provider request is aborted.
- JSON-RPC is not used here; this endpoint proxies HTTP chat completion requests and SSE responses.

This is a focused guardrail example, not a complete DLP system. It scans textual Chat Completions deltas and does not inspect prompts, tool arguments, images, audio, or arbitrary non-text provider events.
