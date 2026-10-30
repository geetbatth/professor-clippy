/**
 * Professor Clippy MCP server (stdio). Agents call its tools (leave_message,
 * remind_me, ask_user, ...); each forwards to the desktop app's local API via
 * `ClippyClient` from @clippy/shared. stdout carries the MCP protocol, so
 * anything diagnostic goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClippyServer } from './server';

await createClippyServer().connect(new StdioServerTransport());
