import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

const customerIdSchema = z.string().regex(/^CUST-[A-Z0-9]{5}$/, {
  message: "customer_id must match CUST-XXXXX (five uppercase letters or digits)",
});

const customerInput = z.object({ customer_id: customerIdSchema }).strict();
const refundInput = z
  .object({
    customer_id: customerIdSchema,
    amount: z.number().finite().positive(),
    reason: z.string().min(10),
  })
  .strict();

const server = new Server(
  { name: "customer-refunds", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_customer_record",
      description: "Fetch a customer record by ID (CUST- followed by five uppercase letters or digits).",
      inputSchema: z.toJSONSchema(customerInput),
    },
    {
      name: "trigger_refund",
      description: "Create a simulated refund request. This demo does not issue a real payment refund.",
      inputSchema: z.toJSONSchema(refundInput),
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  let parsed:
    | z.infer<typeof customerInput>
    | z.infer<typeof refundInput>;

  if (name === "get_customer_record") {
    const result = customerInput.safeParse(args ?? {});
    if (!result.success) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid arguments for tool ${name}: ${result.error.message}`,
      );
    }
    parsed = result.data;
    const { customer_id } = parsed;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            customer_id,
            name: "Example Customer",
            email: `${customer_id.toLowerCase()}@example.invalid`,
            status: "active",
          }),
        },
      ],
    };
  }

  if (name === "trigger_refund") {
    const result = refundInput.safeParse(args ?? {});
    if (!result.success) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid arguments for tool ${name}: ${result.error.message}`,
      );
    }
    parsed = result.data;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "accepted",
            refund_id: `REF-${crypto.randomUUID()}`,
            customer_id: parsed.customer_id,
            amount: parsed.amount,
            reason: parsed.reason,
            simulated: true,
          }),
        },
      ],
    };
  }

  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
server.connect(transport).catch((error: unknown) => {
  console.error("Customer/refund MCP server failed:", error);
  process.exitCode = 1;
});
console.error("Customer/refund MCP server running over stdio.");
