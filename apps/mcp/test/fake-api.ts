/**
 * In-process fake of the desktop app's local HTTP API (the routes in
 * `@clippy/shared/api`), backed by in-memory arrays. Long-polls on
 * `GET /asks/:id?wait=` really wait, like the real server.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { AnsweredVia, AskResult, Message, Reminder } from '@clippy/shared';

export const TOKEN = 'f'.repeat(64);

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
}

let seq = 0;
/** A valid ULID-shaped id (Crockford base32 digits only). */
const nextId = () => `01JB2Z3K4M5N6P7Q8R9S0${String(++seq).padStart(5, '0')}`;

export async function startFakeApi(appDataDir?: string) {
  const requests: RecordedRequest[] = [];
  const messages: Message[] = [];
  const reminders: Reminder[] = [];
  const waiters = new Map<string, Array<() => void>>();

  const askResult = (m: Message): AskResult =>
    m.answer === undefined
      ? { id: m.id, status: 'pending' }
      : { id: m.id, status: 'answered', answer: m.answer, answeredVia: m.answeredVia };

  function answer(id: string, text: string, via: AnsweredVia): AskResult | undefined {
    const ask = messages.find((m) => m.id === id && m.kind === 'ask');
    if (!ask) return undefined;
    ask.answer = text;
    ask.answeredVia = via;
    ask.state = 'done';
    for (const wake of waiters.get(id) ?? []) wake();
    waiters.delete(id);
    return askResult(ask);
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method ?? '', path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    const send = (status: number, payload?: unknown) => {
      res.writeHead(status, payload === undefined ? {} : { 'content-type': 'application/json' });
      res.end(payload === undefined ? undefined : JSON.stringify(payload));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });

    const [, a, id, action] = url.pathname.split('/');
    const route = `${req.method} /${a}${id ? (id === 'pending' ? '/pending' : '/:id') : ''}${action ? `/${action}` : ''}`;
    switch (route) {
      case 'GET /health':
        return send(200, { ok: true, version: '0.0.0-fake' });
      case 'POST /messages': {
        const m: Message = {
          id: nextId(),
          kind: 'note',
          body: body.body,
          title: body.title,
          sender: body.sender,
          project: body.project,
          urgent: body.urgent ?? false,
          state: 'unread',
          createdAt: Date.now(),
        };
        messages.push(m);
        return send(201, m);
      }
      case 'POST /reminders': {
        const r: Reminder = {
          id: nextId(),
          body: body.body,
          sender: body.sender,
          project: body.project,
          dueAt: Date.parse(body.when),
          rrule: body.rrule,
          active: true,
          createdAt: Date.now(),
        };
        reminders.push(r);
        return send(201, r);
      }
      case 'GET /reminders':
        return send(200, reminders.filter((r) => r.active));
      case 'DELETE /reminders/:id': {
        const r = reminders.find((x) => x.id === id);
        if (!r) return send(404, { error: 'no such reminder' });
        r.active = false;
        return send(204);
      }
      case 'POST /asks': {
        const m: Message = {
          id: nextId(),
          kind: 'ask',
          body: body.question,
          options: body.options,
          sender: body.sender,
          project: body.project,
          urgent: body.urgent ?? false,
          state: 'unread',
          createdAt: Date.now(),
        };
        messages.push(m);
        return send(201, m);
      }
      case 'GET /asks/pending':
        return send(200, messages.filter((m) => m.kind === 'ask' && m.answer === undefined));
      case 'GET /asks/:id': {
        const ask = messages.find((m) => m.id === id && m.kind === 'ask');
        if (!ask) return send(404, { error: 'no such ask' });
        const wait = Math.min(Number(url.searchParams.get('wait') ?? 0), 60);
        if (ask.answer === undefined && wait > 0) {
          await new Promise<void>((resolve) => {
            // +20 ms so the client's whole-second deadline has always passed when we return
            const timer = setTimeout(resolve, wait * 1000 + 20);
            const list = waiters.get(ask.id) ?? [];
            list.push(() => {
              clearTimeout(timer);
              resolve();
            });
            waiters.set(ask.id, list);
          });
        }
        return send(200, askResult(ask));
      }
      case 'POST /asks/:id/answer': {
        const result = answer(id ?? '', body.answer, body.via);
        return result ? send(200, result) : send(404, { error: 'no such ask' });
      }
      default:
        return send(404, { error: `no route ${route}` });
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  if (appDataDir) {
    await mkdir(appDataDir, { recursive: true });
    await writeFile(join(appDataDir, 'port'), String(port));
    await writeFile(join(appDataDir, 'token'), TOKEN);
  }

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    messages,
    reminders,
    answer,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export type FakeApi = Awaited<ReturnType<typeof startFakeApi>>;
