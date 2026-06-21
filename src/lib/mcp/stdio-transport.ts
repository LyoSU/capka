import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { mcpStart, mcpRpc } from "@/lib/sandbox/client";

/**
 * MCP client transport for a stdio server running inside the session sandbox.
 *
 * The server process is launched via the controller (`docker exec`) and we relay
 * JSON-RPC frames over the controller's authenticated HTTP — see mcp-bridge.js.
 * v1 is request/response: a request is POSTed and its reply handed to `onmessage`;
 * a notification is fire-and-forget. Server→client notifications aren't delivered
 * yet (tools/list + tools/call don't need them).
 */
export class SandboxStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private readonly sessionKey: string,
    private readonly name: string,
    private readonly spec: { command: string; args?: string[]; env?: Record<string, string> },
  ) {}

  async start(): Promise<void> {
    await mcpStart(this.sessionKey, this.name, this.spec);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const isRequest = "id" in message && message.id != null && "method" in message;
    try {
      const response = await mcpRpc(this.sessionKey, this.name, message);
      if (isRequest && response) this.onmessage?.(response as JSONRPCMessage);
    } catch (e) {
      this.onerror?.(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
  }

  async close(): Promise<void> {
    // The controller tears the process down with the sandbox session; nothing to do.
    this.onclose?.();
  }
}
