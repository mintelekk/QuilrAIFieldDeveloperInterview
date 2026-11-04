# Customer and Refund MCP Server

A runnable TypeScript MCP server exposing `get_customer_record` and `trigger_refund` over stdio. It uses the official Model Context Protocol TypeScript SDK and Zod 4.

## Requirements and run

Node.js 20 or newer and npm are required.

```sh
npm install
npm start
```

The process reads MCP JSON-RPC messages from stdin and writes protocol frames to stdout. Startup and fatal diagnostic messages use stderr. Keep `console.log` out of the server because stdout belongs to the protocol.

## Tools

- `get_customer_record`: `{ "customer_id": "CUST-ABCDE" }`
- `trigger_refund`: `{ "customer_id": "CUST-ABCDE", "amount": 12.5, "reason": "Duplicate purchase" }`

IDs must match `CUST-` followed by exactly five uppercase ASCII letters or digits. Refund amounts must be finite numbers greater than zero, and reasons must contain at least 10 characters. Both schemas reject unknown fields. The server validates every `tools/call`; invalid arguments return JSON-RPC `InvalidParams` (`-32602`) before the tool handler runs.

This demonstration returns sample customer data and simulated refund acknowledgements. It does not connect to customer or payment systems.
