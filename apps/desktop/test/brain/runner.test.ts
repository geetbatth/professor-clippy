// The spawn runner, exercised with `node` standing in for the CLI (never the real `claude`).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSpawnRunner } from '../../src/main/brain/runner';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'clippy-runner-'));
  // Echo argv and stdin back as one JSON line, write to stderr, exit 3.
  writeFileSync(
    join(dir, 'echo.cjs'),
    `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(2),stdin:s})+'\\n');process.stderr.write('oops\\n');process.exitCode=3;});`,
  );
  writeFileSync(join(dir, 'sleep.cjs'), `setTimeout(() => {}, 60000);`);
  writeFileSync(join(dir, 'fake-claude.cmd'), `@"${process.execPath}" "%~dp0echo.cjs" %*\r\n`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const request = (args: string[], stdin = 'hello "there" -p') => ({ args, stdin, cwd: dir, env: process.env });

async function collect(runner: ReturnType<typeof createSpawnRunner>, args: string[]) {
  let out = '';
  const run = runner(request(args), (c) => (out += c));
  const result = await run.done;
  return { out, result };
}

describe('createSpawnRunner', () => {
  it('passes args verbatim, the prompt on stdin, and reports stdout, stderr and the exit code', async () => {
    const runner = createSpawnRunner(() => ({ command: process.execPath, viaCmd: false }));
    const args = [join(dir, 'echo.cjs'), '--append-system-prompt', "You are a professor. Don't panic", 'mcp__clippy__*'];
    const { out, result } = await collect(runner, args);
    expect(JSON.parse(out)).toEqual({ args: args.slice(1), stdin: 'hello "there" -p' });
    expect(result).toMatchObject({ code: 3, stderr: 'oops\n' });
    expect(result.spawnError).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')('runs an npm-style claude.cmd shim through cmd.exe with quoting intact', async () => {
    const runner = createSpawnRunner(() => ({ command: join(dir, 'fake-claude.cmd'), viaCmd: true }));
    const args = ['-p', '--allowedTools', 'Read Glob mcp__clippy__*', '--append-system-prompt', "It's a 'quote' & more"];
    const { out } = await collect(runner, args);
    expect(JSON.parse(out).args).toEqual(args);
  });

  it('reports a missing executable as ENOENT', async () => {
    const missing = createSpawnRunner(() => ({ command: join(dir, 'no-such-claude.exe'), viaCmd: false }));
    expect((await collect(missing, [])).result.spawnError?.code).toBe('ENOENT');
    const unresolved = createSpawnRunner(() => undefined);
    expect((await collect(unresolved, [])).result.spawnError?.code).toBe('ENOENT');
  });

  it('kill() ends a run', async () => {
    const runner = createSpawnRunner(() => ({ command: process.execPath, viaCmd: false }));
    const run = runner(request([join(dir, 'sleep.cjs')]), () => {});
    setTimeout(() => run.kill(), 200);
    const result = await run.done;
    expect(result.code).not.toBe(0);
  });
});
