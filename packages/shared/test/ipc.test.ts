import { describe, expect, expectTypeOf, it } from 'vitest';
import { IpcEvents, IpcInvoke, type ClippyBackend, type ClippyEvent, type ClippyWindowApi } from '../src/ipc';

describe('IPC channels', () => {
  it('has one distinct invoke channel per backend method', () => {
    expect(Object.keys(IpcInvoke).sort()).toEqual([
      'addOrder',
      'addWatch',
      'answerAsk',
      'archivePage',
      'cancelOrder',
      'cancelWatch',
      'connectClaude',
      'createPage',
      'deletePage',
      'getPage',
      'getSettings',
      'hotkeyStatus',
      'listMessages',
      'listOrders',
      'listPages',
      'listWatches',
      'markDone',
      'markPageSeen',
      'newChat',
      'popPage',
      'restorePage',
      'searchHistory',
      'sendChat',
      'setSettings',
      'setTelegramToken',
      'snooze',
      'systemDark',
      'telegramSendTest',
      'telegramStatus',
      'telegramUnpair',
      'writePage',
    ]);
    expectTypeOf<keyof typeof IpcInvoke>().toEqualTypeOf<keyof ClippyBackend>();
    expect(new Set(Object.values(IpcInvoke)).size).toBe(Object.keys(IpcInvoke).length);
  });

  it('names the push events per the contract', () => {
    expect(Object.values(IpcEvents).sort()).toEqual([
      'brain:state',
      'chat:delta',
      'chat:done',
      'message:new',
      'message:updated',
      'page:changed',
      'page:deleted',
      'settings:changed',
      'theme:system',
    ]);
    expectTypeOf<(typeof IpcEvents)[keyof typeof IpcEvents]>().toEqualTypeOf<ClippyEvent>();
  });

  it('types window.clippy.on with an unsubscribe return', () => {
    expectTypeOf<ReturnType<ClippyWindowApi['on']>>().toEqualTypeOf<() => void>();
  });
});
