# Known Issues

## Multi-process concurrency on .svnb / .svctx

**Status:** Not yet addressed — low priority unless multi-agent workflows become common.

**Problem:** When two separate processes (e.g., two Claude Code instances, or Claude Code + Codex) connect via MCP to the same workspace simultaneously, they can race on `.svnb` writes. The file lock (`withFileLockSync`) serializes writes within a single process, but the read-modify-write window across processes can cause lost updates: process A reads, process B reads the same state, A writes, B overwrites A's changes.

**Current mitigations:**
- Single-process subagent parallelism is safe — `withFileLockSync` serializes all `updateJaneSession` calls within the same Node.js process.
- Webview ↔ agent concurrency is handled by the `_agentRunning` guard: the webview skips persists while the agent is working, and flushes before any session rebuild.
- Stale entry/cell references from MCP are handled gracefully (fall through instead of throwing).

**When it matters:**
- Two Claude Code terminals connected to the same workspace via MCP.
- Any scenario with multiple extension host processes writing to the same task.

**Potential fix:** Replace the read-modify-write pattern with an append-only event log. Each actor appends operations (add entry, update cell, modify dashboard state) to a log file. A single reducer materializes the log into the current `.svnb` state. This eliminates write conflicts entirely since appends are atomic at the OS level for small payloads. This is a significant architectural change — not worth pursuing until multi-agent workflows are a real use case.
