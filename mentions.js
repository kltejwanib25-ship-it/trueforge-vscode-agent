const fs = require("node:fs/promises");
const path = require("node:path");

function getFileMentions(message) {
  const pattern = /(?:^|\s)@file:(?:"([^"\r\n]+)"|([^\s"]+))/g;
  const files = new Set();
  for (const match of message.matchAll(pattern)) {
    files.add(match[1] ?? match[2]);
  }
  return [...files];
}

function getSymbolMentions(message) {
  const pattern = /(?:^|\s)@symbol:(?:"([^"\r\n]+)"|([^\s"#]+))#([A-Za-z_]\w*)/g;
  return Array.from(message.matchAll(pattern), match => ({
    file: match[1] ?? match[2],
    name: match[3]
  }));
}

function excerpt(text) {
  const limit = 6000;
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "\n[Excerpt truncated.]";
}

function flattenSymbols(items) {
  const entries = [];
  for (const item of items) {
    entries.push(item);
    if (item.children?.length) {
      entries.push(...flattenSymbols(item.children));
    }
  }
  return entries;
}

async function getFileContext(message) {
  const files = getFileMentions(message);
  const symbols = getSymbolMentions(message);
  const paths = new Set([...files, ...symbols.map(symbol => symbol.file)]);

  if (paths.size === 0) return "";
  if (files.length + symbols.length > 3) {
    throw new Error("Mention up to 3 files or symbols per request.");
  }

  const vscode = require("vscode");
  const folders = vscode.workspace.workspaceFolders;
  if (folders?.length !== 1 || folders[0].uri.scheme !== "file") {
    throw new Error("Open one local project folder to use mentions.");
  }

  const root = await fs.realpath(folders[0].uri.fsPath);
  const sections = [];

  for (const file of paths) {
    const target = await fs.realpath(path.resolve(root, file));
    const relative = path.relative(root, target);
    if (
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).some(part => part.toLowerCase() === ".git")
    ) {
      throw new Error(`Choose a project file inside the workspace: ${file}`);
    }

    const info = await fs.stat(target);
    if (!info.isFile() || info.size > 1_000_000) {
      throw new Error(`Choose a regular file under 1 MB: ${file}`);
    }

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    if (files.includes(file)) {
      sections.push(`File: ${relative}\n${excerpt(doc.getText())}`);
    }

    const requested = symbols.filter(symbol => symbol.file === file);
    if (requested.length === 0) continue;

    const outline = await vscode.commands.executeCommand(
      "vscode.executeDocumentSymbolProvider",
      doc.uri
    );
    if (!outline?.length) {
      throw new Error(`No symbol outline available for ${file}. Open it and retry.`);
    }

    const entries = flattenSymbols(outline);
    for (const { name } of requested) {
      const matches = entries.filter(item => item.name === name);
      if (matches.length !== 1) {
        throw new Error(`Found ${matches.length} symbols named ${name} in ${file}.`);
      }
      const range = matches[0].range ?? matches[0].location?.range;
      if (!range) throw new Error(`No source range available for ${name}.`);

      sections.push(
        `Symbol: ${name} in ${relative}, starting at line ${range.start.line + 1}\n` +
        excerpt(doc.getText(range))
      );
    }
  }

  return "\n\nMentioned context:\n" + sections.join("\n\n");
}

module.exports = { getFileMentions, getFileContext, getSymbolMentions };