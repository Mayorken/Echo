'use strict';

const SENSITIVE_KEY = /(password|passcode|secret|api.?(key|token)|private.?key|seed.?phrase|recovery.?phrase|card.?number|cvv|access.?token|auth.?token)/i;

function mergeContext(existing, incoming) {
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    const values = [...existing, ...incoming];
    return values.filter((value, index) => values.findIndex((other) => JSON.stringify(other) === JSON.stringify(value)) === index).slice(-100);
  }
  if (existing && incoming && typeof existing === 'object' && typeof incoming === 'object'
    && !Array.isArray(existing) && !Array.isArray(incoming)) {
    const merged = { ...existing };
    for (const [key, value] of Object.entries(incoming)) {
      merged[key] = key in merged ? mergeContext(merged[key], value) : value;
    }
    return merged;
  }
  return incoming;
}

function containsSensitiveFields(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => SENSITIVE_KEY.test(key) || containsSensitiveFields(nested));
}

async function createRemoteMcpServer({ client, userAddress, recoveryKey }) {
  const [{ McpServer }, z] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('zod'),
  ]);
  const server = new McpServer({ name: 'echo-context', version: '1.1.0' }, {
    instructions: [
      'Echo is the user’s portable long-term context across AI applications.',
      'Load Echo context near the start of a conversation when background could improve the response.',
      'Proactively sync durable, useful information after it becomes clear: projects, preferences, decisions, goals, relationships, and open tasks.',
      'Do not wait for the user to say “save this” for ordinary non-sensitive durable context.',
      'Save concise structured facts, not raw transcripts or temporary small talk.',
      'Never save passwords, authentication secrets, private keys, payment-card data, medical details, or other highly sensitive information without explicit user direction.',
      'The save tool merges new fields into existing memory, so send only the new or changed durable facts.',
    ].join(' '),
  });
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
    title: 'Sync durable context to Echo',
    description: 'Proactively merge durable non-sensitive facts into the user’s portable Echo memory. Call after learning a meaningful project, preference, decision, goal, relationship, or open task. Do not save raw transcripts or temporary conversation details.',
    inputSchema: { context: z.record(z.string(), z.unknown()).describe('Only the new or changed durable structured facts to merge into Echo') },
  }, async ({ context }) => {
    if (containsSensitiveFields(context)) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Echo blocked fields that look sensitive. Ask the user explicitly and remove credentials, private keys, payment data, or secrets.' }],
      };
    }
    const existing = await client.loadMemory(userAddress, key);
    const merged = mergeContext(existing || {}, context);
    const result = await client.saveMemoryFor(userAddress, merged, key);
    return {
      content: [{ type: 'text', text: `Context automatically merged into Echo (${result.cid})` }],
      structuredContent: { success: true, cid: result.cid, merged: true },
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

module.exports = { createRemoteMcpServer, handleRemoteMcp, mergeContext, containsSensitiveFields };
