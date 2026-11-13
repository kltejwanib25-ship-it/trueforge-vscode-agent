const vscode = require("vscode");
const { reviewEdit } = require("./reviewEdit");
const { startWorkspaceServer } = require("./workspaceServer");


function activate(context) {
  const output = vscode.window.createOutputChannel("TrueForge");
  startWorkspaceServer()
  .then(server => {
    context.subscriptions.push(server);
    output.appendLine(`Workspace MCP server listening at ${server.url}`);
  })
  .catch(error => {
    const message = `Could not start workspace MCP server: ${error.message}`;
    output.appendLine(message);
    vscode.window.showErrorMessage(message);
  });
  let busy = false;
  let activeRun;

const cancelCommand = vscode.commands.registerCommand(
  "trueforge.cancelRun",
  async () => {
    const run = activeRun;
    if (!run) {
      vscode.window.showInformationMessage("No Ask Agent response is streaming.");
      return;
    }

    try {
      await run.client.sessions.cancel(run.sessionId);
      output.appendLine("\nCancellation requested.");
    } catch (error) {
      vscode.window.showErrorMessage(`Could not cancel the run: ${error.message}`);
    }
  }
);

context.subscriptions.push(cancelCommand);

  const command = vscode.commands.registerCommand("trueforge.askAgent", async () => {
    if (busy) {
      vscode.window.showInformationMessage("A TrueForge request is already open.");
      return;
    }

    busy = true;
    try {
      const input = await vscode.window.showInputBox({
        title: "TrueForge: Ask Agent",
        prompt: "What would you like the agent to do?"
      });

      const instruction = input?.trim();
      if (!instruction) return;

      output.show(true);
      output.appendLine(`\nYou: ${instruction}`);

      const { TrueForge } = await import("@truefoundry/trueforge-sdk");
      const client = new TrueForge({ baseUrl: "http://localhost:8790" });

      const { data: session } = await client.sessions.create({
        agent: { name: "forge-code-agent" }
      });

      output.appendLine(`Session: ${session.id}`);
      output.appendLine("Agent:");

      const editor = vscode.window.activeTextEditor;
      let message = instruction;

      if (editor && !editor.selection.isEmpty) {
           const selectedCode = editor.document.getText(editor.selection);
           const file = vscode.workspace.asRelativePath(editor.document.uri);
           message = `${instruction}\n\nSelected code from ${file}:\n${selectedCode}`;
        }
      const stream = await client.sessions.createTurnStream(session.id, {
        input: [{ type: "user.message", content: message }]
      });
      activeRun = { client, sessionId: session.id };
      for await (const { data: event } of stream.withMetadata()) {
        
        if (event.type === "model.message.delta") {
          output.append(event.content ?? "");
        }
        if (event.type === "turn.done") {
          output.appendLine(`\nStatus: ${event.state.status}`);
        }
      }
    } catch (error) {
      const message = `TrueForge request failed: ${error.message}`;
      output.appendLine(`\n${message}`);
      vscode.window.showErrorMessage(message);
    } finally {
      activeRun = undefined;
      busy = false;
    }
  });

  const editCommand = vscode.commands.registerCommand("trueforge.editSelection", async () => {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showInformationMessage("Highlight the code you want to edit first.");
    return;
  }

  const document = editor.document;
  const selection = editor.selection;
  const version = document.version;
  const original = document.getText();
  const start = document.offsetAt(selection.start);
  const end = document.offsetAt(selection.end);

  const instruction = await vscode.window.showInputBox({
    title: "TrueForge: Edit Selection",
    prompt: "What should change in the highlighted code?"
  });
  if (!instruction?.trim()) return;

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "TrueForge is preparing your edit…" },
      async () => {
        const { TrueForge } = await import("@truefoundry/trueforge-sdk");
        const client = new TrueForge({ baseUrl: "http://localhost:8790" });
        const { data: session } = await client.sessions.create({
          agent: { name: "forge-code-agent" }
        });

        const prompt = [
          "Edit the selected code according to the instruction.",
          'Return a JSON object with one string field named "replacement".',
          "Preserve indentation and any necessary trailing newline.",
          "Return only JSON, without Markdown fences or explanations.",
          JSON.stringify({
            language: document.languageId,
            instruction: instruction.trim(),
            selectedCode: original.slice(start, end)
          })
        ].join("\n");

        const stream = await client.sessions.createTurnStream(session.id, {
          input: [{ type: "user.message", content: prompt }]
        });

        let reply = "";
        let status;
        for await (const { data: event } of stream.withMetadata()) {
          if (event.type === "model.message.delta" && event.threadId === "main") {
            reply += event.content ?? "";
          }
          if (event.type === "turn.done") status = event.state.status;
        }

        if (status !== "done") {
          throw new Error(`The turn ended with status ${status ?? "unknown"}.`);
        }

        const proposal = JSON.parse(reply);
        if (typeof proposal?.replacement !== "string") {
          throw new Error("The agent did not return a replacement string.");
        }
        if (document.isClosed || document.version !== version) {
          throw new Error("The source changed during generation. Select the code and try again.");
        }

        const updated = original.slice(0, start) + proposal.replacement + original.slice(end);
        if (updated === original) {
          vscode.window.showInformationMessage("The agent proposed no changes.");
          return;
        }

        await reviewEdit(document, original, updated, version);
      }
    );
  } catch (error) {
    vscode.window.showErrorMessage(`Edit preview failed: ${error.message}`);
  }
});

context.subscriptions.push(output, command, editCommand);
}

module.exports = { activate };
