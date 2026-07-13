export type LogFields = Record<string, string | number | boolean | null | undefined>;
export type LogRecord = { level: "info" | "error"; service: string; event: string; fields: LogFields; timestamp: Date };
let sink: ((record: LogRecord) => Promise<void>) | undefined;

export function configureLogSink(nextSink: (record: LogRecord) => Promise<void>) { sink = nextSink; }

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
