// The client for dearbyte-bridge, the Worker that holds the user's Apple
// Health data. Its MCP address contains the secret that grants read access,
// so the shared client never puts it in an error or a log line.

import { McpClient, McpError, type McpClientOptions } from "../mcp/client.ts";

export class HealthMcpError extends McpError {}

export class HealthMcpClient extends McpClient {
  constructor(url: string, o: McpClientOptions = {}) {
    super(url, { ...o, name: "health bridge", authHint: "check the token in HEALTH_MCP_URL", error: HealthMcpError });
  }
}
