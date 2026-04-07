Claude becomes Jane (Jupyter-like Agentic Notebook Engine) in a two-step process:

1. The MCP gate into Selva: this gives claude a new streamlined way of interacting handle with the human researcher via the notebook cells and selva interface. That interaction within selva is what formalizes the whole research process. This specific part turns claude into a useful Agentic Research Collaborator.  

2. The prompt architecture: the ARC takes Jane's persona via the INIT and SYSTEM propmts. Then during the project Jane can take different 'Tasks' leading down different research paths and outcomes.


┌─────────────────────────┬──────────────────────────┐
│  Task Instructions     │  Bitácora (read-only)    │
│  (human → Jane)         │  (Jane → future Jane)    │
│                         │                          │
│  [editable textarea]    │  [read-only display]     │
│                         │                          │
│  "Always show error     │  "ML project for image   │
│   bars on plots"        │   classification. Dataset │
│  "Use uproot, not       │   has 50k events. Loss   │
│   ROOT directly"        │   plateaus at epoch 15   │
│                         │   with lr=0.001."        │
└─────────────────────────┴──────────────────────────┘


----

Here's the full flow:

How Claude becomes Jane — the mechanical sequence
Step 1: You click the "Connect MCP" button in Selva's header

This triggers connectCodingAgent() in extension.js:610.

Step 2: Selva prepares two things

a) The MCP config — ensureWorkspaceSelvaMcpConfig() writes/updates .mcp.json in your workspace:


{
  "mcpServers": {
    "selva": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/selva/mcp-server.js", "/your/workspace"]
    }
  }
}
This tells Claude Code where to find Selva's MCP server.

b) The connect prompt — buildCodingAgentConnectPrompt() generates a text string. This is the only prompt text Claude receives from Selva. It's currently a dry procedural script: "call jane_init, hydrate session, use tools."

Step 3: Selva launches Claude Code in a terminal

createTerminalLaunchScript() writes a shell script to /tmp/selva-coding-agent/ and runs it:


#!/bin/zsh
claude --permission-mode dontAsk \
       --allowedTools mcp__selva \
       --mcp-config /your/workspace/.mcp.json \
       -- "You are connecting to Selva as Claude Code..."
The -- at the end passes the connect prompt as Claude's initial user message — the first thing Claude sees when it starts. The --mcp-config flag tells Claude where to find the MCP server. The --allowedTools mcp__selva pre-authorizes all Selva MCP tools.

Step 4: Claude Code starts and connects to MCP

Claude reads the .mcp.json, spawns node mcp-server.js /your/workspace, and establishes a stdio MCP connection. Now Claude can call any of Selva's ~20 tools.

Step 5: Claude follows the connect prompt

Claude reads the initial message ("call jane_init first...") and does it. jane_init returns a workspace snapshot. Claude now knows the files, dashboard state, and task info. From here on, Claude acts through MCP tool calls.
