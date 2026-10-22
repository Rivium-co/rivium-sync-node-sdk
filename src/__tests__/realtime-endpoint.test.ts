import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { connect } = vi.hoisted(() => ({ connect: vi.fn((..._args: unknown[]) => ({ on: () => {}, connected: false })) }));
vi.mock('mqtt', () => ({ default: { connect }, connect }));

import { RiviumSyncAdmin } from '../index';

/**
 * Realtime connects where POST /connections/token says, including whether the
 * connection is encrypted: { useTls: true } must give mqtts://, never mqtt://.
 */
describe('realtime endpoint from POST /connections/token', () => {
  const originalFetch = globalThis.fetch;

  function answer(mqttAnswer: { host: string; port: number; useTls: boolean }) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ token: 'jwt-token', projectId: 'p1', mqtt: mqttAnswer })),
    }) as any;
  }

  async function connectWith(mqttAnswer: { host: string; port: number; useTls: boolean }) {
    answer(mqttAnswer);
    const admin = new RiviumSyncAdmin({ apiKey: 'rv_live_test', serverSecret: 'rv_srv_test', enableRealtime: true });
    await (admin as any).initRealtime();
    return connect.mock.calls.at(-1) as unknown as [string, Record<string, unknown>];
  }

  beforeEach(() => connect.mockClear());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('uses mqtts:// when the answer says useTls', async () => {
    const [url] = await connectWith({ host: 'mqtt-sync.rivium.co', port: 8885, useTls: true });
    expect(url).toBe('mqtts://mqtt-sync.rivium.co:8885');
  });

  it('uses mqtt:// when the answer says no TLS', async () => {
    const [url] = await connectWith({ host: 'mqtt-sync.rivium.co', port: 1884, useTls: false });
    expect(url).toBe('mqtt://mqtt-sync.rivium.co:1884');
  });
});
