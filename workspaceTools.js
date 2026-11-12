const vscode = require("vscode");
const { z } = require("zod");
const path = require("node:path");
const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const runFile = promisify(execFile);
const { buildProposedEdit } = require("./proposedEdit");
const { reviewEdit } = require("./reviewEdit");

function registerWorkspaceTools(server) {
  server.registerTool(
    "find_files",
    {
      description:
        "Find files in the open VS Code workspace using a glob pattern. " +
        "For example, **/*cli* finds filenames containing cli. Returns up to 30 paths.",
      inputSchema: {
        pattern: z.string().min(1).max(200)
      }
    },
    
    async ({ pattern }) => {
      const excluded = "**/{.git,node_modules,.venv,__pycache__}/**";
      const files = await vscode.workspace.findFiles(pattern, excluded, 31);
      const paths = files.slice(0, 30).map(uri =>
        vscode.workspace.asRelativePath(uri)
      );

      if (files.length > 30) {
        paths.push("More matches exist. Use a narrower pattern.");
      }

      return {
        content: [{
          type: "text",
          text: paths.length ? paths.join("\n") : "No matching files."
        }]
      };
    }
  );
  server.registerTool(
  "read_file",
  {
    description:
      "Read numbered lines from a workspace file found by find_files. " +
      "Use startLine to continue reading.",
    inputSchema: {
      file: z.string().min(1).max(500),
      startLine: z.number().int().min(1).default(1),
      lineCount: z.number().int().min(1).max(100).default(40)
    }
  },
  async ({ file, startLine, lineCount }) => {
    try {
      const folders = vscode.workspace.workspaceFolders;
      if (folders?.length !== 1 || folders[0].uri.scheme !== "file") {
        throw new Error("Open one local project folder to use read_file.");
      }

      const root = await fs.realpath(folders[0].uri.fsPath);
      const target = await fs.realpath(path.resolve(root, file));
      const relative = path.relative(root, target);

      if (relative === ".." || relative.startsWith(".." + path.sep) ||
          path.isAbsolute(relative)) {
        throw new Error("Choose a file inside the open workspace.");
      }

      const info = await fs.stat(target);
      if (!info.isFile() || info.size > 1_000_000) {
        throw new Error("Choose a regular text file under 1 MB.");
      }

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      if (startLine > doc.lineCount) {
        throw new Error(`This file has ${doc.lineCount} lines.`);
      }

      const end = Math.min(startLine + lineCount - 1, doc.lineCount);
      const lines = [`${relative} | lines ${startLine}–${end} of ${doc.lineCount}`];

      for (let n = startLine; n <= end; n++) {
        const text = doc.lineAt(n - 1).text;
        lines.push(`${n}: ${text.length > 300 ? text.slice(0, 300) + "…" : text}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Could not read file: ${error.message}` }]
      };
    }
  }
);
server.registerTool(
  "search_text",
  {
    description:
      "Search tracked workspace files for literal text, ignoring case. " +
      "Returns up to 20 matching lines with file paths and line numbers. " +
      "Use read_file to inspect the surrounding code.",
    inputSchema: {
      query: z.string().trim().min(1).max(200)
    }
  },
  async ({ query }) => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== "file") {
      return {
        isError: true,
        content: [{ type: "text", text: "Open a local Git workspace first." }]
      };
    }

    try {
      const { stdout } = await runGit(
        "git",
        ["grep", "--no-color", "-n", "-I", "-i", "-F", "-e", query, "--", "."],
        { cwd: folder.uri.fsPath, maxBuffer: 1024 * 1024, timeout: 10000 }
      );

      const matches = stdout.trimEnd().split(/\r?\n/);
      const lines = matches.slice(0, 20).map(line =>
        line.length > 350 ? line.slice(0, 350) + "…" : line
      );

      if (matches.length > 20) {
        lines.push(`Showing 20 of ${matches.length} matches. Narrow the query for more detail.`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      // git grep uses exit code 1 when the search finds no matches.
      if (error.code === 1) {
        return { content: [{ type: "text", text: "No matches." }] };
      }

      const message = error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        ? "Too many matches. Search for a more specific phrase."
        : `Search failed: ${error.message}`;

      return { isError: true, content: [{ type: "text", text: message }] };
    }
  }
);
server.registerTool(
  "propose_edit",
  {
    description:
      "Propose an edit to an existing workspace file and show it in VS Code for review. " +
      "Read the file first. Supply exact old text without line numbers and its replacement. " +
      "If the user rejects or cancels, respect that decision. After partial acceptance, " +
      "read the file again before proposing another change.",
    inputSchema: {
      file: z.string().min(1).max(500),
      oldText: z.string().min(1).max(100_000),
      newText: z.string().max(100_000)
    }
  },
  async ({ file, oldText, newText }) => {
    try {
      const folders = vscode.workspace.workspaceFolders;
      if (folders?.length !== 1 || folders[0].uri.scheme !== "file") {
        throw new Error("Open one local project folder to propose an edit.");
      }

      const root = await fs.realpath(folders[0].uri.fsPath);
      const target = await fs.realpath(path.resolve(root, file));
      const relative = path.relative(root, target);

      if (
        relative === ".." ||
        relative.startsWith(".." + path.sep) ||
        path.isAbsolute(relative) ||
        relative.split(path.sep).some(part => part.toLowerCase() === ".git")
      ) {
        throw new Error("Choose a project file inside the open workspace.");
      }

      const info = await fs.stat(target);
      if (!info.isFile() || info.size > 1_000_000) {
        throw new Error("Choose a regular text file under 1 MB.");
      }

      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      const version = document.version;
      const original = document.getText();
      const updated = buildProposedEdit(original, oldText, newText);
      const result = await reviewEdit(document, original, updated, version);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ file: relative, ...result, unsaved: document.isDirty })
        }]
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Could not propose edit: ${error.message}` }]
      };
    }
  }
);

}

module.exports = { registerWorkspaceTools };