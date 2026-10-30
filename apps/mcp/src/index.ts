/**
 * Professor Clippy MCP server (stdio). Agents call its tools (leave_message,
 * remind_me, ask_user, ...); each forwards to the desktop app's local API via
 * `ClippyClient` from @clippy/shared. Tools are added by the MCP task.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'clippy', version: '0.1.0' });
await server.connect(new StdioServerTransport());
