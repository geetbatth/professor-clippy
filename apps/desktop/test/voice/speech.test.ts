import { describe, expect, it } from 'vitest';
import { cleanTranscript, speakableText, splitForWhisper } from '../../src/main/voice/speech';

describe('speakableText', () => {
  it('drops markdown, links, code fences and emoji, keeping the words', () => {
    expect(speakableText('**Done!** 🎉 See [the PR](https://github.com/x/y/pull/1) or https://example.com.')).toBe('Done! See the PR or a link');
    expect(speakableText('# Heading\n- one\n- two\n\n`npm test` passed ✅')).toBe('Heading one two. npm test passed');
    expect(speakableText('```ts\nconst x = 1;\n```')).toBe('const x = 1;');
  });

  it('is empty when nothing speakable is left', () => {
    expect(speakableText('👍 ✅')).toBe('');
  });
});

describe('splitForWhisper', () => {
  it('leaves a short recording whole', () => {
    const s = new Float32Array(16000 * 10);
    expect(splitForWhisper(s, 16000)).toHaveLength(1);
  });

  it('cuts a long recording into pieces under 28 s, in the quietest moment', () => {
    const rate = 1000;
    const s = new Float32Array(rate * 70).fill(0.5);
    s.fill(0, 24 * rate, 24 * rate + 100); // a pause at 24 s
    const parts = splitForWhisper(s, rate);
    expect(parts.every((p) => p.length <= 28 * rate)).toBe(true);
    expect(parts.reduce((a, p) => a + p.length, 0)).toBe(s.length);
    expect(parts[0]!.length).toBe(24 * rate + 50);
  });
});

describe('cleanTranscript', () => {
  it('removes Whisper tags and tidies spaces', () => {
    expect(cleanTranscript(' [BLANK_AUDIO]  hello   there (music) ')).toBe('hello there');
  });
});
