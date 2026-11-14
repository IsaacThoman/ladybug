import type { RequestRecord } from "@ladybug/shared";

export type Header = { name: string; value: string };

/** A RequestRecord plus the bits only the HAR needs. */
export type TrackedRequest = RequestRecord & {
  requestHeaders: Header[];
  responseHeaders: Header[];
  statusText: string;
  httpVersion: string;
  redirectUrl: string;
};

export function toRecord(tracked: TrackedRequest): RequestRecord {
  return {
    url: tracked.url,
    method: tracked.method,
    resourceType: tracked.resourceType,
    status: tracked.status,
    mimeType: tracked.mimeType,
    postData: tracked.postData,
    failure: tracked.failure,
    isNavigation: tracked.isNavigation,
    frameUrl: tracked.frameUrl,
    startedAt: tracked.startedAt,
    durationMs: tracked.durationMs,
    responseSize: tracked.responseSize,
    remoteAddress: tracked.remoteAddress,
  };
}

function queryString(url: string) {
  try {
    return Array.from(new URL(url).searchParams, ([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function headerValue(headers: Header[], name: string) {
  return headers.find((h) => h.name.toLowerCase() === name)?.value;
}

export function buildHar(requests: TrackedRequest[], version: string) {
  return {
    log: {
      version: "1.2",
      creator: { name: "ladybug-sandbox", version },
      pages: [],
      entries: requests.map((r) => {
        const time = r.durationMs ?? 0;
        const contentType = headerValue(r.requestHeaders, "content-type") ?? "application/octet-stream";
        return {
          startedDateTime: r.startedAt,
          time,
          request: {
            method: r.method,
            url: r.url,
            httpVersion: r.httpVersion,
            cookies: [],
            headers: r.requestHeaders,
            queryString: queryString(r.url),
            ...(r.postData !== null ? { postData: { mimeType: contentType, text: r.postData } } : {}),
            headersSize: -1,
            bodySize: r.postData?.length ?? 0,
          },
          response: {
            status: r.status ?? 0,
            statusText: r.statusText,
            httpVersion: r.httpVersion,
            cookies: [],
            headers: r.responseHeaders,
            content: { size: r.responseSize ?? -1, mimeType: r.mimeType ?? "" },
            redirectURL: r.redirectUrl,
            headersSize: -1,
            bodySize: r.responseSize ?? -1,
            ...(r.failure ? { _failureText: r.failure } : {}),
          },
          cache: {},
          timings: { send: 0, wait: time, receive: 0 },
          ...(r.remoteAddress ? { serverIPAddress: r.remoteAddress.replace(/:\d+$/, "") } : {}),
          _resourceType: r.resourceType,
        };
      }),
    },
  };
}
