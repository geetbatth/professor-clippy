import { describe, expect, expectTypeOf, it } from 'vitest';
import { IpcEvents, IpcInvoke, type ClippyBackend, type ClippyEvent, type ClippyWindowApi } from '../src/ipc';

describe('IPC channels', () => {
  it('has one distinct invoke channel per backend method', () => {
    expect(Object.keys(IpcInvoke).sort()).toEqual([
      'addOrder',
      'addWatch',
      'answerAsk',
      'cancelOrder',
      'cancelWatch',
      'connectClaude',
      'getSettings',
      'hotkeyStatus',
      'listMessages',
      'listOrders',
      'listWatches',
      'markDone',
      'newChat',
      'searchHistory',
      'sendChat',
      'setSettings',
      'setTelegramToken',
      'snooze',
      'systemDark',
      'telegramSendTest',
      'telegramStatus',
      'telegramUnpair',
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
      'theme:system',
    ]);
    expectTypeOf<(typeof IpcEvents)[keyof typeof IpcEvents]>().toEqualTypeOf<ClippyEvent>();
  });

  it('types window.clippy.on with an unsubscribe return', () => {
    expectTypeOf<ReturnType<ClippyWindowApi['on']>>().toEqualTypeOf<() => void>();
  });
});
