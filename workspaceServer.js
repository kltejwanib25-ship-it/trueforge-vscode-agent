const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { createMcpExpressApp } = require("@modelcontextprotocol/sdk/server/express.js");
const {
  StreamableHTTPServerTransport
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { registerWorkspaceTools } = require("./workspaceTools");

async function startWorkspaceServer() {
  const host = "127.0.0.1";
  const port = 8791;
  const app = createMcpExpressApp({ host });

  app.post("/mcp", async (request, response) => {
    const server = new McpServer({
      name: "vscode-workspace",
      version: "0.0.1"
    });
    registerWorkspaceTools(server);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    response.on("close", () => {
      server.close().catch(error => console.error("MCP cleanup failed:", error));
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("Workspace MCP request failed:", error);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Workspace tool request failed." }
        });
      }
    }
  });

  return new Promise((resolve, reject) => {
    const listener = app.listen(port, host, () => {
      resolve({
        url: `http://${host}:${port}/mcp`,
        dispose: () => listener.close()
      });
    });
    listener.once("error", reject);
  });
}

module.exports = { startWorkspaceServer };