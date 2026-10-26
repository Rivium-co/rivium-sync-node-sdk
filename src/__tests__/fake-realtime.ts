/**
 * Test helpers for realtime: a fetch that routes by method + path, and an admin connected to the fake MQTT client
 * of ./fake-mqtt (mock 'mqtt' with it in the test file).
 */
import { vi } from 'vitest';
import { RiviumSyncAdmin } from '../index';

export const PROJECT = 'a947d9ec-d829-4bf4-b609-25fe9bdf855d';
export const BASE = 'https://sync.rivium.co';

import { clients } from './fake-mqtt';

export { clients };

export interface Call {
  method: string;
  path: string;
  body: any;
  headers: Record<string, string>;
}

export type Route = (method: string, path: string, body: any) => { status: number; body?: unknown } | undefined;

/** A fetch that answers by route; POST /connections/token is answered unless the route answers it. */
export function routeFetch(route: Route): { calls: Call[] } {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (url: string, init: any) => {
    const path = String(url).replace(BASE, '');
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init?.method, path, body, headers: init?.headers ?? {} });
    let answer = route(init?.method, path, body);
    if (!answer && path === '/connections/token') {
      answer = { status: 200, body: { token: 'jwt', projectId: PROJECT, mqtt: { host: 'mqtt-sync.rivium.co', port: 8885, useTls: true } } };
    }
    answer ??= { status: 200, body: {} };
    const text = answer.body === undefined ? '' : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, text: async () => text };
  }) as any;
  return { calls };
}

/** Lets pending promises (fetch answers) settle. */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** An admin with realtime on, its MQTT client connected (unless `connected: false`). */
export async function realtimeAdmin(route: Route, { connected = true, userId }: { connected?: boolean; userId?: string } = {}) {
  const { calls } = routeFetch(route);
  const admin = new RiviumSyncAdmin({
    apiKey: 'rv_live_test1234567890',
    serverSecret: 'rv_srv_secret1234567890',
    enableRealtime: true,
    ...(userId ? { userId } : {}),
  });
  await flush();
  const client = clients[clients.length - 1];
  if (connected) client.connectNow();
  await flush();
  return { admin, client, calls };
}

export const listenCalls = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/listen'));
