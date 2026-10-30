import type { StandingOrder } from '@clippy/shared';
import { describe, expect, it } from 'vitest';
import { buildOrderPrompt, createOrderMatcher, parseOrderReply } from '../src/main/orders';
import { fakeRunner } from './brain/fixtures';

const A = '01JB2Z3K4M5N6P7Q8R9S0T1V2A';
const B = '01JB2Z3K4M5N6P7Q8R9S0T1V2B';
const orders: StandingOrder[] = [
  { id: A, text: 'When an agent asks which branch to use, answer: staging', active: true, createdAt: 1 },
  { id: B, text: 'When an agent asks to run the tests, answer: yes', active: true, createdAt: 2 },
];

/** The CLI's `--output-format json` result object, as one stdout blob. */
const cliJson = (result: string) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result });

describe('buildOrderPrompt', () => {
  it('lists every order with its id, the question and the options, and asks for exactly one JSON object', () => {
    const prompt = buildOrderPrompt('Which branch?', ['main', 'staging'], orders);
    expect(prompt).toContain(`${A}: When an agent asks which branch to use, answer: staging`);
    expect(prompt).toContain(`${B}: When an agent asks to run the tests, answer: yes`);
    expect(prompt).toContain('Which branch?');
    expect(prompt).toContain('main');
    expect(prompt).toContain('staging');
    expect(prompt).toMatch(/"order"/);
    expect(prompt).toMatch(/clearly covers/);
  });

  it('leaves the options out when there are none', () => {
    expect(buildOrderPrompt('Which branch?', undefined, orders)).not.toMatch(/Options/);
    expect(buildOrderPrompt('Which branch?', [], orders)).not.toMatch(/Options/);
  });
});

describe('parseOrderReply', () => {
  it('returns the order and answer of a match', () => {
    expect(parseOrderReply(`{"order":"${A}","answer":"staging"}`, orders, undefined)).toEqual({ orderId: A, answer: 'staging' });
  });

  it('is no match for a null order, an unknown id, or a missing or empty answer', () => {
    expect(parseOrderReply('{"order":null}', orders, undefined)).toBeUndefined();
    expect(parseOrderReply('{"order":null,"answer":""}', orders, undefined)).toBeUndefined();
    expect(parseOrderReply('{"order":"01JB2Z3K4M5N6P7Q8R9S0T1V2Z","answer":"x"}', orders, undefined)).toBeUndefined();
    expect(parseOrderReply(`{"order":"${A}"}`, orders, undefined)).toBeUndefined();
    expect(parseOrderReply(`{"order":"${A}","answer":"  "}`, orders, undefined)).toBeUndefined();
    expect(parseOrderReply(`{"order":"${A}","answer":7}`, orders, undefined)).toBeUndefined();
  });

  it('finds the JSON object inside prose or a code fence, and gives up on garbage', () => {
    expect(parseOrderReply(`Sure! \`\`\`json\n{"order":"${B}","answer":"yes"}\n\`\`\` Done.`, orders, undefined)).toEqual({ orderId: B, answer: 'yes' });
    expect(parseOrderReply('I cannot decide', orders, undefined)).toBeUndefined();
    expect(parseOrderReply('{"order": ', orders, undefined)).toBeUndefined();
    expect(parseOrderReply('[1,2]', orders, undefined)).toBeUndefined();
    expect(parseOrderReply('', orders, undefined)).toBeUndefined();
  });

  it('stays bounded on a reply with a great many braces', () => {
    const noise = '{ } '.repeat(5_000);
    expect(parseOrderReply(`${noise} {"order":"${A}","answer":"x"} ${noise}`, orders, undefined)).toBeUndefined();
    expect(parseOrderReply(`{"order":"${A}","answer":"x"}`.padStart(30, ' '), orders, undefined)).toEqual({ orderId: A, answer: 'x' });
  });

  it("snaps an answer to an option to the option's own casing, and refuses one that is not an option", () => {
    const options = ['yes', 'no'];
    expect(parseOrderReply(`{"order":"${B}","answer":"Yes"}`, orders, options)).toEqual({ orderId: B, answer: 'yes' });
    expect(parseOrderReply(`{"order":"${B}","answer":" NO "}`, orders, ['Yes', 'No'])).toEqual({ orderId: B, answer: 'No' });
    expect(parseOrderReply(`{"order":"${B}","answer":"maybe"}`, orders, options)).toBeUndefined();
  });

  it('takes any answer when the question has no options', () => {
    expect(parseOrderReply(`{"order":"${B}","answer":"Yes, go ahead"}`, orders, [])).toEqual({ orderId: B, answer: 'Yes, go ahead' });
  });
});

describe('createOrderMatcher', () => {
  const run = (stdout: string | undefined, opts: Parameters<typeof createOrderMatcher>[0] = {}, hold = false) => {
    const fake = fakeRunner([{ ...(stdout !== undefined && { stdout }), ...(hold && { hold }) }]);
    const match = createOrderMatcher({
      runner: fake.runner,
      env: { PATH: 'x', ELECTRON_RUN_AS_NODE: '1' },
      cwd: 'C:/home',
      settingsPath: 'C:/data/brain/brain-settings.json',
      ...opts,
    });
    return { fake, match };
  };

  it('runs one tool-less, hook-less haiku turn and returns the match', async () => {
    const { fake, match } = run(cliJson(`{"order":"${A}","answer":"staging"}`));
    await expect(match('Which branch?', undefined, orders)).resolves.toEqual({ orderId: A, answer: 'staging' });

    const call = fake.calls[0]!;
    const flag = (name: string) => call.args[call.args.indexOf(name) + 1];
    expect(call.args[0]).toBe('-p');
    expect(flag('--model')).toBe('haiku');
    expect(flag('--tools')).toBe('');
    expect(flag('--output-format')).toBe('json');
    expect(call.args).toContain('--strict-mcp-config');
    expect(call.args).not.toContain('--mcp-config');
    expect(call.args).not.toContain('--resume');
    expect(call.args).toContain('--no-session-persistence');
    expect(flag('--settings')).toBe('C:/data/brain/brain-settings.json');
    expect(call.cwd).toBe('C:/home');
    expect(call.env.CLIPPY_BRAIN).toBe('1');
    expect(call.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(call.stdin).toBe(buildOrderPrompt('Which branch?', undefined, orders));
  });

  it('is no match when the model says no order covers it', async () => {
    const { match } = run(cliJson('{"order":null}'));
    await expect(match('Delete everything?', undefined, orders)).resolves.toBeUndefined();
  });

  it("is no match for output that is not the CLI's JSON, or that reports an error", async () => {
    await expect(run('not json at all').match('q', undefined, orders)).resolves.toBeUndefined();
    const failed = JSON.stringify({ type: 'result', is_error: true, result: `{"order":"${A}","answer":"x"}` });
    await expect(run(failed).match('q', undefined, orders)).resolves.toBeUndefined();
  });

  it('is no match, and kills the run, when it takes longer than timeoutMs', async () => {
    const { fake, match } = run(undefined, { timeoutMs: 20 }, true);
    await expect(match('q', undefined, orders)).resolves.toBeUndefined();
    expect(fake.killed).toBe(1);
  });

  it('is no match when the CLI cannot be started or exits badly', async () => {
    const spawnFail = fakeRunner([{ result: { code: null, spawnError: Object.assign(new Error('nope'), { code: 'ENOENT' }) } }]);
    await expect(createOrderMatcher({ runner: spawnFail.runner })('q', undefined, orders)).resolves.toBeUndefined();
    const bad = fakeRunner([{ stdout: cliJson(`{"order":"${A}","answer":"x"}`), result: { code: 1 } }]);
    await expect(createOrderMatcher({ runner: bad.runner })('q', undefined, orders)).resolves.toBeUndefined();
  });

  it('never throws, even if the runner does', async () => {
    const match = createOrderMatcher({
      runner: () => {
        throw new Error('boom');
      },
    });
    await expect(match('q', undefined, orders)).resolves.toBeUndefined();
  });
});
