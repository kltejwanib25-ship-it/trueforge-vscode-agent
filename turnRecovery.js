const { setTimeout: delay } = require("node:timers/promises");

function retryDelay(message, attempt) {
  // Daily, billing and zero-allocation failures need a quota change or reset.
  if (/per.?day|requestsperday|daily|billing|payment|limit\s*[:=]\s*0\b/i.test(message)) return null;
  if (!/\b429\b|\b503\b|\b502\b|\b504\b|too many requests|high demand|temporarily unavailable|headers timeout|timed? out/i.test(message)) return null;
  const hint = message.match(/(?:retry (?:in|after)|retryDelay["\s:]+)\s*(\d+(?:\.\d+)?)\s*s/i);
  const milliseconds = Math.max(60000 * (attempt + 1), hint ? Math.ceil(Number(hint[1]) * 1000) : 0);
  return milliseconds <= 300000 ? milliseconds : null;
}

async function runTurnWithRecovery({ client, sessionId, message, run, onEvent,
  onAttempt = () => {}, onRetry = () => {}, wait = delay }) {
  let request = { input: [{ type: "user.message", content: message }] };
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (run.controller.signal.aborted) return { status: "cancelled" };
    onAttempt(attempt);
    let terminal;
    run.phase = "streaming";
    try {
      const stream = await client.sessions.createTurnStream(sessionId, request);
      // Cancellation can arrive while the server is creating the turn.
      if (run.controller.signal.aborted) {
        await client.sessions.cancel(sessionId);
        return { status: "cancelled" };
      }
      for await (const { data: event } of stream.withMetadata()) {
        if (event.type === "turn.done") terminal = event.state;
        if (!run.controller.signal.aborted) await onEvent(event);
        if (terminal) break;
      }
    } catch (error) {
      if (run.controller.signal.aborted) return { status: "cancelled" };
      // A failed HTTP stream does not prove server execution has ended.
      throw new Error(`Connection interrupted for session ${sessionId}. Check its state in TrueForge before retrying. ${error.message}`);
    }
    if (run.controller.signal.aborted) return { status: "cancelled" };
    if (!terminal) throw new Error(`Stream ended without a final state. Check session ${sessionId} in TrueForge before retrying.`);
    if (terminal.status !== "error") return terminal;
    const milliseconds = retryDelay(terminal.message || "", attempt);
    if (milliseconds === null || attempt === 2) return terminal;
    run.phase = "waiting";
    onRetry({ attempt: attempt + 1, milliseconds, message: terminal.message });
    try {
      await wait(milliseconds, undefined, { signal: run.controller.signal });
    } catch (error) {
      if (run.controller.signal.aborted) return { status: "cancelled" };
      throw error;
    }
    request = {
      previousTurnId: "auto",
      input: [{ type: "user.message", content:
        "Continue the previous request after the temporary model failure. Read the current workspace before editing. Preserve accepted edits and respect rejected edits. Complete only the remaining work. If the original request specifies an output format, follow it." }]
    };
  }
}

module.exports = { runTurnWithRecovery, retryDelay };
