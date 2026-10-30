/**
 * @clippy/shared — the contracts every Professor Clippy package codes against.
 *
 * The root entry re-exports everything and is **Node-only** (paths/client use
 * node:fs/os/path). Browser, preload and Worker code should import the
 * Node-free subpaths instead: `@clippy/shared/schemas`, `/settings`, `/theme`,
 * `/api`, `/ipc`, `/relay`.
 */
export * from './schemas';
export * from './settings';
export * from './theme';
export * from './api';
export * from './brain';
export * from './paths';
export * from './client';
export * from './ipc';
export * from './relay';
