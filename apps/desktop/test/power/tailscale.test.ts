import { describe, expect, it } from 'vitest';
import { describeTailscale, restartTailscale } from '../../src/main/power/tailscale';
import { actions, fakeExecutor } from './fakeExecutor';

describe('describeTailscale', () => {
  it('names what a confirm would do for each state', async () => {
    const fake = fakeExecutor();
    expect(await describeTailscale(fake)).toEqual({ verb: 'Restart', question: expect.stringContaining('Restart Tailscale?') });
    fake.tailscale = { installed: true, service: 'running', backend: 'Stopped' };
    expect(await describeTailscale(fake)).toEqual({ verb: 'Start', question: expect.stringContaining("Start Tailscale? It's not connected (Stopped).") });
    fake.tailscale = { installed: true, service: 'stopped' };
    expect(await describeTailscale(fake)).toEqual({ verb: 'Start', question: expect.stringContaining("Start Tailscale? Its Windows service isn't running") });
  });

  it('refuses when Tailscale is not installed', async () => {
    const fake = fakeExecutor();
    fake.tailscale = { installed: false, service: 'missing' };
    await expect(describeTailscale(fake)).rejects.toThrow("Tailscale isn't installed on this PC");
  });
});

describe('restartTailscale', () => {
  it('reconnects a connected Tailscale: down, a pause, up', async () => {
    const fake = fakeExecutor();
    expect(await restartTailscale(fake)).toBe("Restarted Tailscale. It's connected again.");
    expect(actions(fake)).toEqual(['tailscale down', 'tailscale up']);
  });

  it('brings up one that is installed but not connected', async () => {
    const fake = fakeExecutor();
    fake.tailscale = { installed: true, service: 'running', backend: 'Stopped' };
    expect(await restartTailscale(fake)).toBe("Started Tailscale. It's connected.");
    expect(actions(fake)).toEqual(['tailscale up']);
  });

  it('starts a stopped service, waits for it, then brings it up', async () => {
    const fake = fakeExecutor();
    fake.tailscale = { installed: true, service: 'stopped' };
    expect(await restartTailscale(fake)).toBe("Started Tailscale. It's connected.");
    expect(actions(fake)).toEqual(['sc start Tailscale', 'tailscale up']);
  });

  it('says so when starting the service needs the Windows admin prompt', async () => {
    const fake = fakeExecutor();
    fake.tailscale = { installed: true, service: 'stopped' };
    fake.serviceStart = 'needs-approval';
    expect(await restartTailscale(fake)).toMatch(/needs admin rights.*Windows is asking on your PC/);
    expect(actions(fake)).toEqual(['sc start Tailscale']);
  });

  it('reports a login that has expired instead of claiming success', async () => {
    const fake = fakeExecutor();
    fake.upTo = 'NeedsLogin';
    expect(await restartTailscale(fake)).toMatch(/needs you to sign in again/);
  });

  it('fails when the service never comes up', async () => {
    const fake = fakeExecutor();
    fake.tailscale = { installed: true, service: 'stopped' };
    fake.startTailscaleService = async () => 'started';
    await expect(restartTailscale(fake)).rejects.toThrow("Tailscale's service didn't start");
  });
});
