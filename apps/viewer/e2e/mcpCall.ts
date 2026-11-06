// A small streamable-HTTP MCP client for specs: the agent's side of a real
// canopy_mcp, so a spec calls `get_workspace` / `set_workspace` exactly as an
// agent does (POST <origin>/mcp, JSON-RPC 2.0, answered as JSON or as an SSE
// stream of `message` events).
//
// One McpClient is one MCP session: `connect()` runs initialize and
// notifications/initialized and keeps the Mcp-Session-Id the server minted.
// `call(name, args)` runs tools/call and returns the tool's structured result
// (structuredContent, else the first text content parsed as JSON); a tool
// error (isError) or a JSON-RPC error throws.
//
// A server restart ends the session; `call` then re-connects once and retries.

const PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** The JSON-RPC messages of an SSE body (`data:` lines of each event, joined). */
function sseMessages(body: string): JsonRpcResponse[] {
  const out: JsonRpcResponse[] = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data) out.push(JSON.parse(data) as JsonRpcResponse);
  }
  return out;
}

export class McpClient {
  private session: string | null = null;
  private nextId = 1;

  constructor(private readonly origin: string) {}

  private async post(message: Record<string, unknown>): Promise<JsonRpcResponse | null> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
    };
    if (this.session) headers['mcp-session-id'] = this.session;
    const response = await fetch(`${this.origin}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
    });
    const minted = response.headers.get('mcp-session-id');
    if (minted) this.session = minted;
    const text = await response.text();
    if (!response.ok) {
      const err = new Error(`MCP ${String(message.method)}: HTTP ${response.status} ${text}`);
      (err as Error & { status?: number }).status = response.status;
      throw err;
    }
    if (!('id' in message)) return null;
    const type = response.headers.get('content-type') ?? '';
    const messages = type.includes('text/event-stream')
      ? sseMessages(text)
      : [JSON.parse(text) as JsonRpcResponse];
    const answer = messages.find((m) => m.id === message.id);
    if (!answer) throw new Error(`MCP ${String(message.method)}: no answer in ${text}`);
    return answer;
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const answer = await this.post({ jsonrpc: '2.0', id: this.nextId++, method, params });
    if (answer?.error) {
      throw new Error(`MCP ${method}: ${answer.error.code} ${answer.error.message}`);
    }
    return answer?.result;
  }

  /** Opens a session (initialize + notifications/initialized). */
  async connect(): Promise<void> {
    this.session = null;
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'viewer-e2e', version: '0' },
    });
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  /** The names of the tools the server offers. */
  async tools(): Promise<string[]> {
    if (!this.session) await this.connect();
    const result = (await this.request('tools/list', {})) as { tools: { name: string }[] };
    return result.tools.map((t) => t.name);
  }

  /** Calls tool `name`; resolves with its structured result. */
  async call<T = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<T> {
    if (!this.session) await this.connect();
    let result: ToolResult;
    try {
      result = (await this.request('tools/call', { name, arguments: args })) as ToolResult;
    } catch (err) {
      // A restarted server no longer knows the session: open a new one, once.
      const status = (err as { status?: number }).status;
      if (status !== 400 && status !== 404) throw err;
      await this.connect();
      result = (await this.request('tools/call', { name, arguments: args })) as ToolResult;
    }
    const text = result.content?.find((c) => c.type === 'text')?.text;
    if (result.isError) throw new Error(`tool ${name} failed: ${text ?? JSON.stringify(result)}`);
    if (result.structuredContent !== undefined) return result.structuredContent as T;
    if (text === undefined) throw new Error(`tool ${name}: no content`);
    return JSON.parse(text) as T;
  }
}
