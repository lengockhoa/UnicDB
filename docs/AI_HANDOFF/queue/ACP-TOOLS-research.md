# ACP-TOOLS-research — TASK-012 Stage 1 probe results

Live probe against the actually-installed `omp/18.0.1` binary, run from this worktree on
2026-08-25. Goal: empirically determine whether/how omp's ACP transport accepts
host-provided MCP tool servers via the `mcpServers` array param in `session/new`.

## Method

Probe script: `/tmp/task012_probe.mjs` (not checked in — throwaway probe tool, per task
budget of "at most 2 descriptor shapes tried").

1. Spawn real `omp acp --cwd <tmpdir>` exactly as `acpProcess.ts` does today (same args,
   same stdio pipes).
2. Do the real handshake: `initialize` request → `initialized` notification →
   `session/new` request.
3. `session/new`'s `mcpServers` param carries ONE entry using the ACP `McpServer` HTTP
   variant (ground-truth shape from `packages/utils/src/acp/protocol.ts` in the upstream
   `can1357/oh-my-pi` repo, tag `v18.0.1`):
   ```json
   { "type": "http", "name": "UnicDB_probe", "url": "http://127.0.0.1:<port>", "headers": [] }
   ```
4. `<port>` is a real local `node:http` server started by the probe script BEFORE spawning
   omp. It implements just enough of MCP Streamable HTTP to observe traffic:
   - `initialize` → replies `{protocolVersion, capabilities: {tools: {}}, serverInfo}`
     (must advertise `capabilities.tools` truthy — omp's MCP client only calls
     `tools/list` at all if this is present; confirmed by reading
     `packages/coding-agent/src/mcp/manager.ts`/`client.ts` upstream).
   - `notifications/initialized` → 202, no body (best-effort, per MCP spec).
   - `tools/list` → replies with one fake tool (`list_tables`).
   - `tools/call` → replies with a fake `[]` text result.
   - Every inbound POST is logged verbatim (method, params, headers) before being answered.
5. Acceptance bar (per task Discussion): "accepted" = at least one INBOUND `tools/list` or
   `tools/call` frame observed arriving at the bridge from omp. A clean `session/new`
   response with no inbound tool traffic does NOT count.
6. Budget: at most 2 descriptor shapes (HTTP first, then stdio if HTTP fails), one session
   each, 60s wait per session.

## Result: HTTP shape — ACCEPTED on the first shape tried

Stage 1 stopped after shape 1; the acceptance bar was met immediately, so the stdio shape
was not attempted (task budget explicitly allows stopping once accepted).

### `initialize` (ACP) response — confirms `mcpCapabilities.http: true`

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": 1,
    "agentInfo": { "name": "oh-my-pi", "title": "Oh My Pi", "version": "18.0.1" },
    "authMethods": [
      {
        "id": "agent",
        "name": "Use existing local credentials",
        "description": "Authenticate via the provider keys/OAuth state already configured under ~/.omp."
      }
    ],
    "agentCapabilities": {
      "loadSession": true,
      "mcpCapabilities": { "http": true, "sse": true },
      "promptCapabilities": { "embeddedContext": true, "image": true },
      "sessionCapabilities": { "list": {}, "fork": {}, "resume": {}, "close": {} }
    }
  }
}
```

No `stdio` key under `mcpCapabilities` — HTTP/SSE are the only ACP-session-level
advertised MCP transports for `mcpServers` entries in this omp version. This matches the
upstream protocol.ts type definition (`McpServer` union: `stdio` variant vs
`http | sse | acp` variant with `url`).

### `session/new` request sent (exact params, mirrors real `acpProcess.ts`/`acp.ts` call sites)

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "cwd": "/var/folders/ts/19rcd7fx4fs3cfl66t1vbpq00000gn/T/task012-probe-nVgYKF",
    "mcpServers": [
      { "type": "http", "name": "UnicDB_probe", "url": "http://127.0.0.1:51108", "headers": [] }
    ]
  }
}
```

### Raw inbound frames captured at the local MCP HTTP server (verbatim, all 4 arrived within
4ms of each other, synchronously as part of omp resolving `session/new` — BEFORE the
`session/new` JSON-RPC response even came back over stdio)

```json
[
  {
    "dir": "in",
    "frame": {
      "jsonrpc": "2.0",
      "id": 1,
      "method": "initialize",
      "params": {
        "protocolVersion": "2025-11-25",
        "capabilities": { "roots": { "listChanged": false } },
        "clientInfo": { "name": "omp-coding-agent", "version": "1.0.0" }
      }
    },
    "headers": {
      "accept": "application/json, text/event-stream",
      "content-type": "application/json",
      "user-agent": "Bun/1.4.0",
      "host": "127.0.0.1:51108"
    }
  },
  {
    "dir": "in",
    "frame": { "jsonrpc": "2.0", "method": "notifications/initialized", "params": {} },
    "headers": {
      "accept": "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
      "user-agent": "Bun/1.4.0"
    }
  },
  { "dir": "in", "note": "non-POST", "method": "GET", "url": "/" },
  {
    "dir": "in",
    "frame": { "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} },
    "headers": {
      "accept": "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
      "user-agent": "Bun/1.4.0"
    }
  }
]
```

**INBOUND `tools/list` frame observed** (id=2, no params) — acceptance bar met.

### `session/new` response received back over ACP stdio (truncated `configOptions`, full
`sessionId` preserved)

```json
{
  "sessionId": "01a03717-01d0-73a1-a4f3-366d84411e9a",
  "configOptions": ["...mode/model/thinking select options, omitted..."],
  "modes": {
    "availableModes": [
      { "id": "default", "name": "Default", "description": "Standard ACP headless mode" },
      { "id": "plan", "name": "Plan", "description": "..." }
    ],
    "currentModeId": "default"
  }
}
```

## Interpretation

- omp's ACP agent, on receiving a non-empty `mcpServers` array with an HTTP-shaped entry
  in `session/new`, connects to that URL **synchronously as part of handling
  `session/new`** (via `MCPManager.connectServers` → `listTools`, per upstream
  `packages/coding-agent/src/mcp/manager.ts`) and performs the full MCP handshake
  (`initialize` → `notifications/initialized` → `tools/list`) before ever getting to a
  prompt turn. **No `session/prompt` / actual model credentials were needed to trigger
  tool discovery** — this significantly de-risks the bridge, since discovery does not
  depend on the model choosing to call a tool.
- The `headers` field on the HTTP `McpServer` variant is confirmed to be an array of
  `{name, value}` pairs (empty array `[]` accepted with no error).
- Only HTTP (or SSE) MCP servers are viable for `mcpServers` entries at the ACP-session
  level for this omp version — `mcpCapabilities` does not advertise `stdio` support at
  that layer (stdio MCP servers are only used for omp's own config-file-based server
  definitions, a separate code path not exercised via `session/new`).

## Stage 1 verdict

**ACCEPTED.** HTTP transport for `mcpServers` in `session/new` is real, working, and
triggers inbound `tools/list` traffic without any extra prompt/model step. Stage 2 (the
`mcpBridge.ts` implementation) proceeds using an in-process HTTP MCP server, bound to
`127.0.0.1` (loopback only — DB credentials/tool execution never leave the extension
host process; the HTTP hop is purely local IPC between omp's child process and the
extension host on the same machine).
