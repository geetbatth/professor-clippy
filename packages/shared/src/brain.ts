/**
 * What the MCP server and the desktop app agree on about Clippy's own brain. Node-free.
 */

/**
 * `CLIPPY_SENDER` of the headless Claude Code that is Clippy's brain. The MCP server registers its
 * brain-only tools (notes, activity, ...) only for this sender; agents never see them.
 */
export const BRAIN_SENDER = 'clippy-brain';
