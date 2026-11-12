const vscode = require("vscode");
const { diffLines } = require("diff");

// Paste your existing getEditHunks function here.
function getEditHunks(original, proposed) {
  const hunks = [];
  let offset = 0;
  let current;

  for (const part of diffLines(original, proposed)) {
    if (!part.added && !part.removed) {
      current = undefined;
      offset += part.value.length;
      continue;
    }

    if (!current) {
      current = { start: offset, end: offset, replacement: "" };
      hunks.push(current);
    }

    if (part.removed) {
      offset += part.value.length;
      current.end = offset;
    } else {
      current.replacement += part.value;
    }
  }

  return hunks;
}
async function reviewEdit(document, original, updated, version) {
  // Paste your existing preview and review code here.
  const preview = await vscode.workspace.openTextDocument({
          language: document.languageId,
          content: updated
        });
        await vscode.commands.executeCommand(
          "vscode.diff",
          document.uri,
          preview.uri,
          "TrueForge: Original ↔ Proposed edit"
        );
        const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
const hunks = getEditHunks(original, updated.replace(/\r\n|\n/g, eol));
const accepted = [];

for (const [index, hunk] of hunks.entries()) {
  const line = document.positionAt(hunk.start).line + 1;
  const before = original.slice(hunk.start, hunk.end).trim();
  const after = hunk.replacement.trim();

  const choice = await vscode.window.showQuickPick(
    [
      { label: "Accept this hunk", detail: after || "(Delete these lines)" },
      { label: "Reject this hunk", detail: before || "(Keep this position empty)" }
    ],
    {
      title: `TrueForge: Hunk ${index + 1} of ${hunks.length} · Line ${line}`,
      placeHolder: "Choose an action. Esc cancels the entire review."
    }
  );

  if (!choice) {
  return { status: "cancelled", applied: 0, total: hunks.length };
}
  if (choice.label === "Accept this hunk") accepted.push(hunk);
}

if (!accepted.length) {
  vscode.window.showInformationMessage("Review finished. All hunks rejected.");
  return { status: "rejected", applied: 0, total: hunks.length };
}

if (document.isClosed || document.version !== version) {
  throw new Error("The source changed during review. Generate a fresh preview.");
}

const sourceEditor = await vscode.window.showTextDocument(document);
if (document.version !== version) {
  throw new Error("The source changed. Generate a fresh preview.");
}

const applied = await sourceEditor.edit(edit => {
  for (const hunk of accepted) {
    const range = new vscode.Range(
      document.positionAt(hunk.start),
      document.positionAt(hunk.end)
    );
    edit.replace(range, hunk.replacement);
  }
});

if (!applied) throw new Error("VS Code could not apply the reviewed changes.");

vscode.window.showInformationMessage(
  `Applied ${accepted.length} of ${hunks.length} hunks. Ctrl+Z undoes this edit.`
);
return {
  status: accepted.length === hunks.length ? "accepted" : "partially_accepted",
  applied: accepted.length,
  total: hunks.length
};
}

module.exports = { reviewEdit };