// A small MCP client for the services DearByte reads: dearbyte-bridge (health)
// and MindGo (money). MCP over HTTP is JSON-RPC 2.0 in POST requests: the
// client initializes once, then calls tools; each tool answers with a text
// block, which these servers fill with JSON.
//
// An MCP address or token can be the secret that grants access, so neither
// appears in an error message or a log line.

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 20_000;

export class McpError extends Error {}

type RpcResponse = { result?: unknown; error?: { code?: number; message?: string } };
type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

export type McpClientOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Extra request headers, such as a bearer token. */
  headers?: Record<string, string>;
};

export class McpClient {
  private nextId = 1;
  private initialized: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly o: McpClientOptions & {
      /** How errors name the server: "The health bridge could not connect". */
      name: string;
      /** What to check when the server answers 401 or 404. */
      authHint: string;
      /** The error class to throw, so callers can tell servers apart. */
      error?: new (message: string) => McpError;
    },
  ) {}

  /** Calls a tool and returns its JSON answer. Throws the client's McpError when it can't. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.initialized ??= this.initialize().catch((err) => {
      this.initialized = null; // try again next time
      throw err;
    });
    await this.initialized;
    const result = (await this.request("tools/call", { name, arguments: args })) as ToolResult;
    const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
    if (result?.isError) throw this.fail(`${name} failed: ${text.slice(0, 300) || "no details"}`);
    try {
      return JSON.parse(text);
    } catch {
      throw this.fail(`${name} returned something that isn't JSON`);
    }
  }

  private fail(message: string): McpError {
    return new (this.o.error ?? McpError)(message);
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "dearbyte", version: "0.1.0" } });
    await this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const res = await this.send({ jsonrpc: "2.0", id: this.nextId++, method, params });
    const body = (await res.json().catch(() => null)) as RpcResponse | null;
    if (!body) throw this.fail(`${method}: the ${this.o.name} answered with something that isn't JSON`);
    if (body.error) throw this.fail(`${method}: ${body.error.message ?? "error"} (${body.error.code ?? "?"})`);
    return body.result;
  }

  private async send(body: Record<string, unknown>): Promise<Response> {
    const name = `The ${this.o.name}`;
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": PROTOCOL_VERSION,
          ...this.o.headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      // Network errors can quote the URL; only the reason is kept.
      const reason = (err as Error).name === "TimeoutError" ? "timed out" : "could not connect";
      throw this.fail(`${name} ${reason}`);
    }
    if (res.status === 401 || res.status === 404) throw this.fail(`${name} answered ${res.status}: ${this.o.authHint}`);
    if (!res.ok && res.status !== 202) throw this.fail(`${name} answered HTTP ${res.status}`);
    return res;
  }
}
