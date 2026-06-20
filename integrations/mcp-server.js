#!/usr/bin/env node

/**
 * integrations/mcp-server.js
 *
 * Model Context Protocol (MCP) server for Echo. Exposes Echo's context
 * portability operations as MCP tools that Claude Desktop (and any other
 * MCP-compatible AI tool) can call directly.
 *
 * Uses stdio transport (JSON-RPC over stdin/stdout) — the standard MCP
 * transport for local tool servers.
 *
 * Setup in Claude Desktop config (~/.claude/claude_desktop_config.json):
 *
 *   {
 *     "mcpServers": {
 *       "echo": {
 *         "command": "node",
 *         "args": ["path/to/Echo/integrations/mcp-server.js"],
 *         "env": {
 *           "RPC_URL": "https://api.calibration.node.glif.io/rpc/v1",
 *           "CONTRACT_ADDRESS": "0x...",
 *           "PRIVATE_KEY": "0x...",
 *           "LIGHTHOUSE_API_KEY": "...",
 *           "ENCRYPTION_KEY": "..."
 *         }
 *       }
 *     }
 *   }
 *
 * Environment variables:
 *   RPC_URL            — FEVM RPC endpoint
 *   CONTRACT_ADDRESS   — Deployed EchoMemoryRegistry proxy address
 *   PRIVATE_KEY        — Wallet private key for signing transactions
 *   LIGHTHOUSE_API_KEY — Lighthouse API key for Filecoin storage
 *   ENCRYPTION_KEY     — Hex-encoded 32-byte encryption key
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { EchoClient, generateEncryptionKey } = require('../echo-sdk');
const { createLighthouseStorage } = require('../lib/storage');

// Vault tool names use a consistent prefix so AI tools can filter them
const VAULT_TOOLS = [
  'echo_create_vault',
  'echo_save_vault_context',
  'echo_load_vault_context',
  'echo_grant_vault_access',
  'echo_revoke_vault_access',
  'echo_has_vault_access',
];

const TOOL_DEFINITIONS = [
  {
    name: 'echo_save_context',
    description:
      'Save or update the user\'s AI context to Echo (encrypted, stored on Filecoin). ' +
      'Use this to persist project context, preferences, architecture decisions, or any ' +
      'information the user wants portable across AI tools.',
    inputSchema: {
      type: 'object',
      properties: {
        context: {
          type: 'object',
          description: 'The context object to save. Can contain any JSON-serializable data: ' +
            'project info, preferences, decisions, current task, etc.',
        },
      },
      required: ['context'],
    },
  },
  {
    name: 'echo_load_context',
    description:
      'Load a user\'s portable AI context from Echo. Returns the decrypted context ' +
      'object if access has been granted, or null if no context exists.',
    inputSchema: {
      type: 'object',
      properties: {
        userAddress: {
          type: 'string',
          description: 'Ethereum address of the user whose context to load.',
        },
      },
      required: ['userAddress'],
    },
  },
  {
    name: 'echo_grant_access',
    description:
      'Grant another AI tool (by its wallet address) read access to the user\'s context. ' +
      'This is how the user controls which tools can see their portable context.',
    inputSchema: {
      type: 'object',
      properties: {
        appAddress: {
          type: 'string',
          description: 'Ethereum address of the AI tool to grant access to.',
        },
      },
      required: ['appAddress'],
    },
  },
  {
    name: 'echo_revoke_access',
    description:
      'Revoke a previously granted AI tool\'s access to the user\'s context.',
    inputSchema: {
      type: 'object',
      properties: {
        appAddress: {
          type: 'string',
          description: 'Ethereum address of the AI tool to revoke access from.',
        },
      },
      required: ['appAddress'],
    },
  },
  {
    name: 'echo_list_access',
    description:
      'List all AI tools that have been granted access to a user\'s context, ' +
      'with their current active/revoked status.',
    inputSchema: {
      type: 'object',
      properties: {
        userAddress: {
          type: 'string',
          description: 'Ethereum address of the user.',
        },
      },
      required: ['userAddress'],
    },
  },
  {
    name: 'echo_fund_renewal',
    description:
      'Fund the perpetual-storage renewal endowment for the user\'s context vault. ' +
      'This ensures the context stays stored on Filecoin permanently.',
    inputSchema: {
      type: 'object',
      properties: {
        amountInFil: {
          type: 'string',
          description: 'Amount of FIL to fund (e.g. "0.1").',
        },
      },
      required: ['amountInFil'],
    },
  },
  {
    name: 'echo_generate_key',
    description: 'Generate a new 256-bit encryption key for Echo context encryption.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // ── Team Vault tools (V3) ───────────────────────────────────────────────
  {
    name: 'echo_create_vault',
    description:
      'Create a new shared team vault with the current signer as owner. ' +
      'The vaultName is a human-readable identifier (e.g. "team-alpha") that is ' +
      'hashed on-chain to a bytes32 vault ID. Once created, use echo_grant_vault_access ' +
      'to add teammates. To switch between a personal vault and a team vault, change ' +
      'which tool you call (echo_save_context vs echo_save_vault_context) and supply ' +
      'the vaultName. No central server needed — the RBAC lives entirely on-chain.',
    inputSchema: {
      type: 'object',
      properties: {
        vaultName: {
          type: 'string',
          description: 'Human-readable vault name, e.g. "team-alpha". Must be consistent across all callers.',
        },
      },
      required: ['vaultName'],
    },
  },
  {
    name: 'echo_save_vault_context',
    description:
      'Save or update the shared AI context for a team vault. Any current vault member ' +
      'can write. Context is encrypted client-side with the shared encryption key — ' +
      'the Keeper and any intermediary see only ciphertext.',
    inputSchema: {
      type: 'object',
      properties: {
        vaultName: {
          type: 'string',
          description: 'Name of the team vault to write to.',
        },
        context: {
          type: 'object',
          description: 'The shared context object to save (any JSON-serializable data).',
        },
      },
      required: ['vaultName', 'context'],
    },
  },
  {
    name: 'echo_load_vault_context',
    description:
      'Load and decrypt the shared AI context from a team vault. ' +
      'Caller must be a current vault member — non-members receive NotAuthorized.',
    inputSchema: {
      type: 'object',
      properties: {
        vaultName: {
          type: 'string',
          description: 'Name of the team vault to read from.',
        },
      },
      required: ['vaultName'],
    },
  },
  {
    name: 'echo_grant_vault_access',
    description:
      'Grant a teammate access to a team vault. Only the vault owner can call this. ' +
      'After granting, the new member can read and write the vault context.',
    inputSchema: {
      type: 'object',
      properties: {
        vaultName: {
          type: 'string',
          description: 'Name of the team vault.',
        },
        memberAddress: {
          type: 'string',
          description: 'Ethereum address of the teammate to add.',
        },
      },
      required: ['vaultName', 'memberAddress'],
    },
  },
  {
    name: 'echo_revoke_vault_access',
    description:
      'Revoke a member\'s access to a team vault. Only the vault owner can call this. ' +
      'The owner cannot revoke themselves.',
    inputSchema: {
      type: 'object',
      properties: {
        vaultName: {
          type: 'string',
          description: 'Name of the team vault.',
        },
        memberAddress: {
          type: 'string',
          description: 'Ethereum address of the member to remove.',
        },
      },
      required: ['vaultName', 'memberAddress'],
    },
  },
  {
    name: 'echo_has_vault_access',
    description: 'Check whether an address is currently a member of a team vault.',
    inputSchema: {
      type: 'object',
      properties: {
        vaultName: {
          type: 'string',
          description: 'Name of the team vault.',
        },
        memberAddress: {
          type: 'string',
          description: 'Ethereum address to check.',
        },
      },
      required: ['vaultName', 'memberAddress'],
    },
  },
];

function createMcpHandler(config) {
  const { rpcUrl, contractAddress, signer, storage, encryptionKey } = config;
  const client = new EchoClient(rpcUrl, contractAddress, signer, storage);

  return async function handleToolCall(name, args) {
    switch (name) {
      case 'echo_save_context': {
        const result = await client.saveMemory(args.context, encryptionKey);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, cid: result.cid, integrityHash: result.integrityHash }) }] };
      }
      case 'echo_load_context': {
        if (!args.userAddress || !ethers.isAddress(args.userAddress)) {
          throw new Error('Valid userAddress is required');
        }
        const context = await client.loadMemory(args.userAddress, encryptionKey);
        if (context === null) {
          return { content: [{ type: 'text', text: JSON.stringify({ context: null, message: 'No context stored for this user' }) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ context }) }] };
      }
      case 'echo_grant_access': {
        if (!args.appAddress || !ethers.isAddress(args.appAddress)) {
          throw new Error('Valid appAddress is required');
        }
        await client.grantAccess(args.appAddress);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, granted: args.appAddress }) }] };
      }
      case 'echo_revoke_access': {
        if (!args.appAddress || !ethers.isAddress(args.appAddress)) {
          throw new Error('Valid appAddress is required');
        }
        await client.revokeAccess(args.appAddress);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, revoked: args.appAddress }) }] };
      }
      case 'echo_list_access': {
        if (!args.userAddress || !ethers.isAddress(args.userAddress)) {
          throw new Error('Valid userAddress is required');
        }
        const apps = await client.listAccess(args.userAddress);
        return { content: [{ type: 'text', text: JSON.stringify({ apps }) }] };
      }
      case 'echo_fund_renewal': {
        if (!args.amountInFil || isNaN(Number(args.amountInFil)) || Number(args.amountInFil) <= 0) {
          throw new Error('Valid amountInFil is required');
        }
        await client.fundRenewal(args.amountInFil);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, funded: args.amountInFil }) }] };
      }
      case 'echo_generate_key': {
        const key = await generateEncryptionKey();
        const hex = Buffer.from(key).toString('hex');
        return { content: [{ type: 'text', text: JSON.stringify({ key: hex }) }] };
      }

      // ── Team Vault handlers (V3) ─────────────────────────────────────────
      case 'echo_create_vault': {
        if (!args.vaultName || typeof args.vaultName !== 'string') {
          throw new Error('vaultName is required');
        }
        await client.createVault(args.vaultName);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, vault: args.vaultName }) }] };
      }
      case 'echo_save_vault_context': {
        if (!args.vaultName || typeof args.vaultName !== 'string') {
          throw new Error('vaultName is required');
        }
        if (!args.context || typeof args.context !== 'object') {
          throw new Error('context must be an object');
        }
        const result = await client.saveVaultMemory(args.vaultName, args.context, encryptionKey);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, vault: args.vaultName, cid: result.cid, integrityHash: result.integrityHash }) }] };
      }
      case 'echo_load_vault_context': {
        if (!args.vaultName || typeof args.vaultName !== 'string') {
          throw new Error('vaultName is required');
        }
        const context = await client.loadVaultMemory(args.vaultName, encryptionKey);
        if (context === null) {
          return { content: [{ type: 'text', text: JSON.stringify({ context: null, message: 'No context stored for this vault' }) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ context }) }] };
      }
      case 'echo_grant_vault_access': {
        if (!args.vaultName || typeof args.vaultName !== 'string') throw new Error('vaultName is required');
        if (!args.memberAddress || !ethers.isAddress(args.memberAddress)) throw new Error('Valid memberAddress is required');
        await client.grantVaultAccess(args.vaultName, args.memberAddress);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, vault: args.vaultName, granted: args.memberAddress }) }] };
      }
      case 'echo_revoke_vault_access': {
        if (!args.vaultName || typeof args.vaultName !== 'string') throw new Error('vaultName is required');
        if (!args.memberAddress || !ethers.isAddress(args.memberAddress)) throw new Error('Valid memberAddress is required');
        await client.revokeVaultAccess(args.vaultName, args.memberAddress);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, vault: args.vaultName, revoked: args.memberAddress }) }] };
      }
      case 'echo_has_vault_access': {
        if (!args.vaultName || typeof args.vaultName !== 'string') throw new Error('vaultName is required');
        if (!args.memberAddress || !ethers.isAddress(args.memberAddress)) throw new Error('Valid memberAddress is required');
        const hasAccess = await client.hasVaultAccess(args.vaultName, args.memberAddress);
        return { content: [{ type: 'text', text: JSON.stringify({ vault: args.vaultName, member: args.memberAddress, hasAccess }) }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };
}

function startStdioServer() {
  const rpcUrl = process.env.RPC_URL;
  const contractAddress = process.env.CONTRACT_ADDRESS;
  const privateKey = process.env.PRIVATE_KEY;
  const lighthouseApiKey = process.env.LIGHTHOUSE_API_KEY;
  const encryptionKeyHex = process.env.ENCRYPTION_KEY;

  if (!rpcUrl || !contractAddress || !privateKey || !lighthouseApiKey) {
    process.stderr.write('Error: RPC_URL, CONTRACT_ADDRESS, PRIVATE_KEY, and LIGHTHOUSE_API_KEY are required\n');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
  const signer = new ethers.Wallet(privateKey, provider);
  const storage = createLighthouseStorage(lighthouseApiKey);

  let encryptionKey;
  if (encryptionKeyHex) {
    encryptionKey = Uint8Array.from(Buffer.from(encryptionKeyHex, 'hex'));
  } else {
    const { randomBytes } = require('crypto');
    encryptionKey = new Uint8Array(randomBytes(32));
    process.stderr.write('Warning: No ENCRYPTION_KEY set — using ephemeral key\n');
  }

  const handleToolCall = createMcpHandler({ rpcUrl, contractAddress, signer, storage, encryptionKey });

  let buffer = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      handleMessage(line.trim(), handleToolCall).catch((err) => {
        process.stderr.write(`Error: ${err.message}\n`);
      });
    }
  });

  process.stderr.write('Echo MCP server started (stdio transport)\n');
}

async function handleMessage(line, handleToolCall) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === 'initialize') {
    const response = {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'echo-context', version: '0.1.0' },
      },
    };
    process.stdout.write(JSON.stringify(response) + '\n');
    return;
  }

  if (msg.method === 'notifications/initialized') {
    return;
  }

  if (msg.method === 'tools/list') {
    const response = {
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: TOOL_DEFINITIONS },
    };
    process.stdout.write(JSON.stringify(response) + '\n');
    return;
  }

  if (msg.method === 'tools/call') {
    try {
      const result = await handleToolCall(msg.params.name, msg.params.arguments || {});
      const response = {
        jsonrpc: '2.0',
        id: msg.id,
        result,
      };
      process.stdout.write(JSON.stringify(response) + '\n');
    } catch (err) {
      const response = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        },
      };
      process.stdout.write(JSON.stringify(response) + '\n');
    }
    return;
  }

  if (msg.id !== undefined) {
    const response = {
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    };
    process.stdout.write(JSON.stringify(response) + '\n');
  }
}

if (require.main === module) {
  startStdioServer();
}

module.exports = { createMcpHandler, handleMessage, TOOL_DEFINITIONS };
