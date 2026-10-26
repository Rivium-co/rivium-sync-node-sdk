/**
 * A fake MQTT client (no network). Use with:
 *   vi.mock('mqtt', async () => { const f = await import('./fake-mqtt'); return { default: { connect: f.connect }, connect: f.connect }; });
 * (This module must not import the SDK: the mock factory would wait on itself.)
 */
import { vi } from 'vitest';

type Handler = (...args: any[]) => void;

export class FakeMqttClient {
  connected = false;
  options: Record<string, unknown> = {};
  subscribed: string[] = [];
  unsubscribed: string[] = [];
  private handlers: Record<string, Handler[]> = {};

  on(event: string, fn: Handler): this {
    (this.handlers[event] ??= []).push(fn);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.handlers[event] ?? []) fn(...args);
  }

  subscribe(topic: string): void {
    this.subscribed.push(topic);
  }

  unsubscribe(topic: string): void {
    this.unsubscribed.push(topic);
  }

  end(): void {
    this.connected = false;
  }

  /** The broker accepted the connection. */
  connectNow(): void {
    this.connected = true;
    this.emit('connect');
  }

  /** The connection dropped. */
  drop(): void {
    this.connected = false;
    this.emit('close');
  }

  /** A message on a topic, as JSON. */
  publish(topic: string, payload: unknown): void {
    this.emit('message', topic, Buffer.from(JSON.stringify(payload)));
  }
}

export const clients: FakeMqttClient[] = [];

export const connect = vi.fn((_url: string, options: Record<string, unknown>) => {
  const client = new FakeMqttClient();
  client.options = options;
  clients.push(client);
  return client;
});

