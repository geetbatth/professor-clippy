import type { VoiceStatus } from '@clippy/shared/ipc';

/** What to say about voice not being usable yet, or undefined when it is. */
export function voiceUnavailable(status: VoiceStatus | undefined): string | undefined {
  if (!status) return 'Voice is still starting.';
  if (!status.enabled) return 'Voice is turned off (Settings → Voice).';
  switch (status.state) {
    case 'ready':
      return undefined;
    case 'downloading':
      return `Getting Clippy's ears and voice ready… ${Math.round((status.progress ?? 0) * 100)}%`;
    case 'error':
      return `Clippy's voice models didn't download: ${status.error ?? 'unknown error'}. Try again in Settings → Voice.`;
    default:
      return `Voice needs a one-time download (about ${status.downloadMb} MB).`;
  }
}
