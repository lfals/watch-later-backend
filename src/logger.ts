export type LogFields = Record<string, string | number | boolean | null | undefined>;
export type LogRecord = { level: "info" | "error"; service: string; event: string; fields: LogFields; timestamp: Date };
export type LogSink = (record: LogRecord) => Promise<void>;
let sink: LogSink | undefined;

export function configureLogSink(nextSink: LogSink) { sink = nextSink; }

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

export function logEvent(event: string, fields: LogFields = {}) {
  console.info(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "info",
    service: "watch-later-backend",
    event,
    ...fields,
  }));
  persist({ level: "info", service: "watch-later-backend", event, fields, timestamp: new Date() });
}

export function logError(event: string, error: unknown, fields: LogFields = {}) {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    service: "watch-later-backend",
    event,
    ...fields,
    errorType: error instanceof Error ? error.name : "unknown",
    errorCode: error instanceof Error ? error.message : "unknown_error",
  }));
  persist({ level: "error", service: "watch-later-backend", event, fields: {
    ...fields, errorType: error instanceof Error ? error.name : "unknown",
    errorCode: error instanceof Error ? error.message : "unknown_error",
  }, timestamp: new Date() });
}
