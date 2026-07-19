import { AsyncLocalStorage } from "node:async_hooks";

export type LogFields = Record<string, string | number | boolean | null | undefined>;
export type LogLevel = "info" | "warn" | "error";
export type LogRecord = { level: LogLevel; service: string; event: string; fields: LogFields; timestamp: Date };
export type LogSink = (record: LogRecord) => Promise<void>;
let sink: LogSink | undefined;
const context = new AsyncLocalStorage<LogFields>();

export function configureLogSink(nextSink?: LogSink) { sink = nextSink; }

export function withLogContext<T>(fields: LogFields, operation: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, operation);
}

export function combineLogSinks(...sinks: Array<LogSink | undefined>): LogSink {
  const configured = sinks.filter((item): item is LogSink => Boolean(item));
  return async (record) => {
    const results = await Promise.allSettled(configured.map((item) => item(record)));
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) throw rejected.reason;
  };
}

export function lokiLogSink(options: {
  url?: string;
  tenantId?: string;
  component?: string;
  environment?: string;
  fetch?: typeof globalThis.fetch;
}): LogSink | undefined {
  const url = options.url;
  if (!url) return undefined;
  const send = options.fetch ?? globalThis.fetch;
  return async (record) => {
    const line = JSON.stringify({
      timestamp: record.timestamp.toISOString(),
      level: record.level,
      service: record.service,
      event: record.event,
      ...record.fields,
    });
    const response = await send(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.tenantId ? { "x-scope-orgid": options.tenantId } : {}),
      },
      body: JSON.stringify({
        streams: [{
          stream: {
            service: record.service,
            component: options.component ?? "backend",
            environment: options.environment ?? "development",
            level: record.level,
          },
          values: [[String(record.timestamp.getTime() * 1_000_000), line]],
        }],
      }),
    });
    if (!response.ok) throw new Error(`loki_push_failed:${response.status}`);
  };
}

function persist(record: LogRecord) {
  void sink?.(record).catch((error) => console.error(JSON.stringify({
    timestamp: new Date().toISOString(), level: "error", service: "watch-later-backend",
    event: "log.persistence_failed", errorType: error instanceof Error ? error.name : "unknown",
  })));
}

function write(level: LogLevel, event: string, fields: LogFields) {
  const timestamp = new Date();
  const mergedFields = { ...context.getStore(), ...fields };
  const output = JSON.stringify({ timestamp: timestamp.toISOString(), level, service: "watch-later-backend", event, ...mergedFields });
  if (level === "error") console.error(output);
  else if (level === "warn") console.warn(output);
  else console.info(output);
  persist({ level, service: "watch-later-backend", event, fields: mergedFields, timestamp });
}

export function logEvent(event: string, fields: LogFields = {}) { write("info", event, fields); }

export function logWarn(event: string, fields: LogFields = {}) { write("warn", event, fields); }

export function logError(event: string, error: unknown, fields: LogFields = {}) {
  write("error", event, {
    ...fields,
    errorType: error instanceof Error ? error.name : "unknown",
    errorCode: error instanceof Error ? error.message.slice(0, 200) : "unknown_error",
  });
}
