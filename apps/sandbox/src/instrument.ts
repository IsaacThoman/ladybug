// Page-side instrumentation, installed with context.addInitScript. Playwright
// serializes the function source, so everything it needs lives inside it.
// Wrappers are Proxies (toString stays native-looking), report through the
// exposed binding and never throw into the page.

export const REPORT_BINDING = "__ladybugReport";

export type InstrumentReport =
  | { kind: "dynamicCode"; type: string; snippet: string; length: number }
  | { kind: "decode"; type: string; length: number }
  | { kind: "clipboard"; text: string }
  | { kind: "permission"; permission: string };

export function instrumentPage(bindingName: string) {
  const w = window as unknown as Record<string, unknown>;
  if (w.__ladybugInstrumented) return;
  try {
    Object.defineProperty(w, "__ladybugInstrumented", { value: true, enumerable: false });
  } catch {
    // ignore
  }

  const DECODE_MIN = 200;
  const MAX_REPORTS_PER_KIND = 200;
  const counts: Record<string, number> = {};
  const captured = w[bindingName];

  const report = (payload: Record<string, unknown>) => {
    try {
      const key = String(payload.kind) + ":" + String(payload.type ?? "");
      counts[key] = (counts[key] ?? 0) + 1;
      if (counts[key] > MAX_REPORTS_PER_KIND) return;
      const fn = (typeof captured === "function" ? captured : w[bindingName]) as
        | ((p: unknown) => Promise<unknown>)
        | undefined;
      if (typeof fn !== "function") return;
      const pending = fn(payload);
      if (pending && typeof pending.catch === "function") pending.catch(() => undefined);
    } catch {
      // never surface to the page
    }
  };

  const safe = (fn: () => void) => {
    try {
      fn();
    } catch {
      // ignore
    }
  };

  const wrap = <T extends object>(
    owner: object | undefined | null,
    prop: string,
    handler: ProxyHandler<T>,
  ) => {
    safe(() => {
      if (!owner) return;
      const original = (owner as Record<string, unknown>)[prop] as T | undefined;
      if (typeof original !== "function") return;
      const proxy = new Proxy(original, handler);
      const desc = Object.getOwnPropertyDescriptor(owner, prop);
      Object.defineProperty(owner, prop, {
        value: proxy,
        writable: desc ? desc.writable !== false : true,
        enumerable: desc ? desc.enumerable === true : false,
        configurable: true,
      });
    });
  };

  const snippetOf = (code: unknown) => {
    const s = String(code);
    return { snippet: s.slice(0, 500), length: s.length };
  };

  // Playwright's own evaluations (page.evaluate, binding results) go through
  // UtilityScript.evaluate -> global.eval in the main world. Skip those.
  const OriginalError = Error;
  const fromPlaywright = (code: string) => {
    if (code.includes("__playwright__binding__controller__")) return true;
    const limit = OriginalError.stackTraceLimit;
    try {
      OriginalError.stackTraceLimit = 30;
      return /\bUtilityScript\.evaluate\b/.test(String(new OriginalError().stack));
    } catch {
      return false;
    } finally {
      OriginalError.stackTraceLimit = limit;
    }
  };

  // eval (note: a wrapped eval behaves like indirect eval)
  wrap(window, "eval", {
    apply(target, thisArg, args) {
      if (typeof args[0] === "string" && !fromPlaywright(args[0])) {
        const code = args[0];
        safe(() => report({ kind: "dynamicCode", type: "eval", ...snippetOf(code) }));
      }
      return Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
    },
  });

  // Function constructor, both `Function(...)` and `(function(){}).constructor(...)`
  safe(() => {
    const OriginalFunction = Function;
    const handler: ProxyHandler<FunctionConstructor> = {
      apply(target, thisArg, args) {
        safe(() =>
          report({ kind: "dynamicCode", type: "Function", ...snippetOf(args[args.length - 1] ?? "") }),
        );
        return Reflect.apply(target, thisArg, args);
      },
      construct(target, args, newTarget) {
        safe(() =>
          report({ kind: "dynamicCode", type: "Function", ...snippetOf(args[args.length - 1] ?? "") }),
        );
        return Reflect.construct(target, args, newTarget === proxy ? target : newTarget);
      },
    };
    const proxy = new Proxy(OriginalFunction, handler);
    Object.defineProperty(window, "Function", {
      value: proxy,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(OriginalFunction.prototype, "constructor", {
      value: proxy,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  });

  for (const name of ["setTimeout", "setInterval"]) {
    wrap(window, name, {
      apply(target, thisArg, args) {
        if (typeof args[0] === "string") {
          const code = args[0];
          safe(() => report({ kind: "dynamicCode", type: name, ...snippetOf(code) }));
        }
        return Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
      },
    });
  }

  for (const name of ["atob", "unescape"]) {
    wrap(window, name, {
      apply(target, thisArg, args) {
        const result = Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
        safe(() => {
          if (typeof result === "string" && result.length >= DECODE_MIN) {
            report({ kind: "decode", type: name, length: result.length });
          }
        });
        return result;
      },
    });
  }

  wrap(String, "fromCharCode", {
    apply(target, thisArg, args) {
      const result = Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
      safe(() => {
        if (typeof result === "string" && result.length >= DECODE_MIN) {
          report({ kind: "decode", type: "String.fromCharCode", length: result.length });
        }
      });
      return result;
    },
  });

  // Clipboard writes: the fake-CAPTCHA "paste this into Run" tell.
  const reportClipboard = (text: unknown) => {
    if (typeof text === "string" && text.length > 0) {
      report({ kind: "clipboard", text: text.slice(0, 10000) });
    }
  };

  safe(() => {
    const proto = typeof Clipboard !== "undefined" ? Clipboard.prototype : null;
    wrap(proto, "writeText", {
      apply(target, thisArg, args) {
        safe(() => reportClipboard(String(args[0])));
        return Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
      },
    });
    wrap(proto, "write", {
      apply(target, thisArg, args) {
        safe(() => {
          const items = args[0] as ClipboardItem[] | undefined;
          for (const item of items ?? []) {
            for (const type of item.types) {
              if (type === "text/plain" || type === "text/html") {
                item
                  .getType(type)
                  .then((blob) => blob.text())
                  .then(reportClipboard)
                  .catch(() => undefined);
              }
            }
          }
        });
        return Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
      },
    });
  });

  const selectedText = () => {
    try {
      const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
        const value = el.value ?? "";
        const start = el.selectionStart ?? 0;
        const end = el.selectionEnd ?? 0;
        return end > start ? value.slice(start, end) : value;
      }
      return document.getSelection()?.toString() ?? "";
    } catch {
      return "";
    }
  };

  wrap(Document.prototype, "execCommand", {
    apply(target, thisArg, args) {
      let text = "";
      const isCopy = typeof args[0] === "string" && ["copy", "cut"].includes(args[0].toLowerCase());
      if (isCopy) text = selectedText();
      const result = Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
      if (isCopy) safe(() => reportClipboard(text));
      return result;
    },
  });

  // `copy` handlers that call event.clipboardData.setData(...)
  wrap(DataTransfer.prototype, "setData", {
    apply(target, thisArg, args) {
      safe(() => {
        const format = String(args[0]).toLowerCase();
        if (format === "text" || format === "text/plain") reportClipboard(String(args[1]));
      });
      return Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
    },
  });

  // Permission prompts
  const reportPermission = (permission: string) => report({ kind: "permission", permission });

  safe(() => {
    if (typeof Notification === "undefined") return;
    wrap(Notification, "requestPermission", {
      apply(target, thisArg, args) {
        safe(() => reportPermission("notifications"));
        return Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
      },
    });
  });

  safe(() => {
    if (typeof Permissions === "undefined") return;
    wrap(Permissions.prototype, "query", {
      apply(target, thisArg, args) {
        safe(() => {
          const desc = args[0] as { name?: unknown } | undefined;
          reportPermission("query:" + String(desc?.name ?? "unknown"));
        });
        return Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
      },
    });
  });

  safe(() => {
    if (typeof Geolocation === "undefined") return;
    for (const name of ["getCurrentPosition", "watchPosition"]) {
      wrap(Geolocation.prototype, name, {
        apply(target, thisArg, args) {
          safe(() => reportPermission("geolocation"));
          return Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
        },
      });
    }
  });

  safe(() => {
    if (typeof MediaDevices === "undefined") return;
    wrap(MediaDevices.prototype, "getUserMedia", {
      apply(target, thisArg, args) {
        safe(() => {
          const c = (args[0] ?? {}) as { audio?: unknown; video?: unknown };
          const kinds = [c.video ? "camera" : null, c.audio ? "microphone" : null].filter(Boolean);
          reportPermission(kinds.join("+") || "media");
        });
        return Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
      },
    });
  });

  safe(() => {
    if (typeof PushManager === "undefined") return;
    wrap(PushManager.prototype, "subscribe", {
      apply(target, thisArg, args) {
        safe(() => reportPermission("push"));
        return Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
      },
    });
  });
}
