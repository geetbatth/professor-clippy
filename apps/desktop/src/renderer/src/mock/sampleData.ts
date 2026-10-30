/** Sample messages for the mock backend (notes, a reminder, an ask with options, a chat, some history). */
import { ulid } from 'ulid';
import type { Message } from '@clippy/shared/schemas';

const MIN = 60_000;

export function sampleMessages(now: number): Message[] {
  const at = (minutesAgo: number) => Math.round(now - minutesAgo * MIN);
  const msg = (m: Omit<Message, 'id'>): Message => ({ id: ulid(m.createdAt), ...m });
  return [
    msg({
      kind: 'note',
      title: 'Build finished',
      body: 'payments-api: 214 tests passed, 0 failed. Deployed to staging in 3m 12s.',
      sender: 'claude-code',
      project: 'payments-api',
      urgent: false,
      state: 'unread',
      createdAt: at(4),
    }),
    msg({
      kind: 'reminder',
      body: "Stand-up in 10 minutes. You said you'd mention the flaky e2e tests.",
      sender: 'claude-code',
      project: 'home',
      urgent: false,
      state: 'unread',
      createdAt: at(12),
    }),
    msg({
      kind: 'note',
      title: 'Migration failed on prod replica',
      body: 'Migration 0042 failed: duplicate key value violates unique constraint "users_email_key".\nI paused the rollout. Please take a look before the 14:00 deploy.',
      sender: 'codex',
      project: 'infra',
      urgent: true,
      state: 'unread',
      createdAt: at(1),
    }),
    msg({
      kind: 'ask',
      body: 'Should I squash the 14 WIP commits before opening the PR?',
      sender: 'claude-code',
      project: 'professor-clippy',
      urgent: false,
      state: 'unread',
      createdAt: at(0.5),
      options: ['Squash them', 'Keep history', 'Let me look first'],
    }),
    msg({
      kind: 'chat',
      body: "Clippy, what's on my plate today?",
      sender: 'user',
      urgent: false,
      state: 'done',
      role: 'user',
      createdAt: at(30),
    }),
    msg({
      kind: 'chat',
      body: 'Three notes, a reminder and a question about squashing commits. Also, you have not had lunch. I can tell.',
      sender: 'clippy',
      urgent: false,
      state: 'done',
      role: 'clippy',
      createdAt: at(29.5),
    }),
    msg({
      kind: 'note',
      body: 'Lint and type checks pass on feature/search.',
      sender: 'claude-code',
      project: 'search',
      urgent: false,
      state: 'done',
      createdAt: at(180),
      doneAt: at(170),
    }),
    msg({
      kind: 'ask',
      body: 'Postgres 16 or 17 for the new cluster?',
      sender: 'codex',
      project: 'infra',
      urgent: false,
      state: 'done',
      createdAt: at(26 * 60),
      doneAt: at(25 * 60),
      options: ['16', '17'],
      answer: '17',
      answeredVia: 'whatsapp',
    }),
  ];
}

/** Clippy's canned chat replies in mock mode. */
export const MOCK_REPLIES: readonly string[] = [
  'Splendid question. After consulting my extensive library (one sticky note), I conclude: yes, but carefully.',
  'Hmm. Let me adjust my glasses... Right. I would start with the failing migration, then reward yourself with a biscuit.',
  "I'm only a mock professor right now, but my confidence is entirely real.",
];
