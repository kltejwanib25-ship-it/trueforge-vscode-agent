# TrueForge VS Code Coding Agent

A VS Code extension that sends coding requests to a TrueForge agent and exposes workspace tools through a local MCP server. Agent execution runs on TrueForge. File edits are reviewed inside VS Code.

## Requirements

- Windows with PowerShell
- VS Code 1.85 or later
- Node.js and npm available in the terminal
- Git
- A model provider configured in TrueForge with available API quota

Development and local testing used Node.js 24.

## Install

```powershell
git clone https://github.com/kltejwanib25-ship-it/trueforge-vscode-agent.git
cd trueforge-vscode-agent
npm.cmd ci
```

## Start TrueForge

In PowerShell:

```powershell
$env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1","localhost"]'
npx.cmd @truefoundry/trueforge@latest
```

Keep this terminal open. Open http://localhost:8790 in your browser.

Configure your model provider in TrueForge using your own credentials. The model must be available to your account.

## Launch the extension

From the extension repository, run the following in a second PowerShell window. Replace the workspace path with the repository you want the agent to work on.

```powershell
code --new-window --extensionDevelopmentPath="$PWD" "C:\path\to\your\repository"
```

In the Extension Development Host, open the Command Palette and run:

```text
TrueForge: Open Agent Panel
```

Check View → Output → TrueForge for:

```text
Workspace MCP server listening at http://127.0.0.1:8791/mcp
```

Use one Extension Development Host at a time because the MCP server uses a fixed port.

## Configure the agent

In TrueForge:

1. Add an MCP connection using Streamable HTTP at http://127.0.0.1:8791/mcp.
2. Name the connection `vscode-workspace`.
3. Create an agent named `forge-code-agent`.
4. Select your configured model.
5. Copy the instructions from `manifest.instructions` in `forge-code-agent.json`.
6. Attach `vscode-workspace` and enable these tools:
   - `find_files`
   - `read_file`
   - `search_text`
   - `propose_edit`
   - `run_terminal`
7. Save the agent.

`forge-code-agent.json` records the agent configuration. Its saved instance identifiers belong to the development environment. Creating the named agent in your own TrueForge instance is required.

## Use

Open the TrueForge panel, enter a request, and click Send. Replies and run status appear in the panel.

Available commands:

- **TrueForge: Ask Agent** — submit a coding request.
- **TrueForge: Open Agent Panel** — open the chat panel.
- **TrueForge: Edit Selection** — propose a replacement for selected text.
- **TrueForge: Cancel Run** — request cancellation.

Use Ctrl+Alt+E for Edit Selection.

Prompts support file and symbol references:

```text
@file:src/flask/helpers.py
@symbol:src/flask/helpers.py#get_debug_flag
```

## Workspace tools

- `find_files` finds files by glob pattern.
- `read_file` reads bounded sections with line numbers.
- `search_text` searches tracked workspace files through Git.
- `propose_edit` proposes a replacement in an existing file.
- `run_terminal` runs `git status --short`.

`run_terminal` currently supports only the Git status operation. Run test commands separately in a terminal.

## Review edits

Each proposed edit opens a diff with hunk-by-hunk accept or reject choices. Pressing Escape cancels the review. Accepted hunks are applied after the review completes.

The extension checks the document version before applying changes. Ctrl+Z can undo an applied edit.

Accepted edits may remain unsaved in the editor. Save the affected source files before running tests or inspecting changes with Git.

## Failure handling

Chat and inline-edit requests share bounded recovery logic:

- Confirmed transient failed turns can receive up to two continuation attempts in the same session.
- Default waits are 60 seconds and 120 seconds.
- Recognized textual retry hints can extend the wait up to five minutes.
- Recognized daily-quota, zero-allocation, and billing failures stop recovery.
- Cancellation interrupts a retry wait and prevents further continuation attempts.
- Errors and status are reported to the user.

A continuation asks the agent to inspect the current workspace, preserve accepted edits, and respect rejected edits.

Interrupted connections and streams without a final state require inspection of the reported session in TrueForge before retrying. The server may still be executing.

Automatic model failover and per-model request pacing are not implemented. Continuation does not provide an exactly-once execution guarantee.

## Automated checks

Run from the extension repository:

```powershell
node --check extension.js
node --check workspaceTools.js
node --check turnRecovery.js
node --test turnRecovery.test.js
```

The recovery suite contains 10 simulated tests covering success, transient failures, retry bounds, quota handling, cancellation, retry hints, and interrupted streams. These tests make no model API calls.

## Verification record

The recovery tests passed: 10 passed, 0 failed.

Manual checks after the recovery update verified:

- A model reply in the panel.
- Workspace text search.
- Inline edit preview.
- Hunk rejection preserving the source.
- Cancellation ending with `Status: cancelled`.

A Flask 3.1.3 rehearsal added a `flask config` command, a CLI test, and documentation. Its CLI test file passed with 56 passed and 3 skipped.

That rehearsal required follow-up prompts and review corrections. The Flask changes are in a separate workspace and are not included in this extension repository.

Live recovery through a provider failure remains unverified.

## Troubleshooting

- **Cannot find module 'vscode'** — launch the extension through the Extension Development Host using the command above.
- **Port 8791 is already in use** — close the earlier Extension Development Host before starting another.
- **Agent cannot see a tool** — check the enabled tools on `forge-code-agent`, save it, and retry.
- **Outbound URL blocked** — start TrueForge in the terminal where the JSON host allow-list is set.
- **429 or 503** — inspect the reported error and recovery status. Quota limits and provider availability can prevent completion.
- **Source changed during review** — generate a fresh proposal against the current file.

The local services are intended to run on your own machine. Keep provider credentials out of the repository.