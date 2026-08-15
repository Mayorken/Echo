'use strict';

async function createRemoteMcpServer({ client, userAddress, recoveryKey }) {
  const [{ McpServer }, z] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('zod'),
  ]);
  const server = new McpServer({ name: 'echo-context', version: '1.0.0' });
  const key = Uint8Array.from(Buffer.from(recoveryKey, 'hex'));

  server.registerTool('echo_get_context', {
    title: 'Load Echo context',
    description: 'Load the user’s approved preferences, projects, and decisions from Echo. Use it when this background would improve the response.',
    inputSchema: {},
  }, async () => {
    const context = await client.loadMemory(userAddress, key);
    return {
      content: [{ type: 'text', text: JSON.stringify(context || { message: 'No context saved yet' }) }],
      structuredContent: { context },
    };
  });

  server.registerTool('echo_save_context', {
    title: 'Save Echo context',
    description: 'Save information to Echo only when the user explicitly asks you to remember it.',
    inputSchema: { context: z.record(z.string(), z.unknown()).describe('Context the user explicitly requested to save') },
  }, async ({ context }) => {
    const result = await client.saveMemoryFor(userAddress, context, key);
    return {
      content: [{ type: 'text', text: `Saved securely to Echo (${result.cid})` }],
      structuredContent: { success: true, cid: result.cid },
    };
  });

  return server;
}

async function handleRemoteMcp(req, res, options) {
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const server = await createRemoteMcpServer(options);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

module.exports = { createRemoteMcpServer, handleRemoteMcp };
