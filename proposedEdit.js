function buildProposedEdit(original, oldText, newText) {
  if (!oldText.length) {
    throw new Error("Include existing text to identify where the edit belongs.");
  }

  // Match the file's line endings, including Windows CRLF.
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const before = oldText.replace(/\r\n|\n/g, eol);
  const after = newText.replace(/\r\n|\n/g, eol);

  const start = original.indexOf(before);
  if (start === -1) {
    throw new Error("Text not found. Read the file again and use its exact text.");
  }
  if (original.indexOf(before, start + 1) !== -1) {
    throw new Error("Multiple matches. Include more surrounding lines.");
  }
  if (before === after) {
    throw new Error("The proposed edit makes no change.");
  }

  return original.slice(0, start) + after + original.slice(start + before.length);
}

module.exports = { buildProposedEdit };