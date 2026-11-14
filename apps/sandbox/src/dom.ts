import type { DomForm, DomScript, DomSnapshot } from "@ladybug/shared";

/** Page-side half of GET /browser/dom. Everything but `html` and `truncated`. */
export type DomExtract = Omit<DomSnapshot, "html" | "truncated">;

export function extractDom(textMax: number): DomExtract {
  const isVisible = (el: Element) => {
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    } catch {
      return false;
    }
  };

  const resolve = (value: string | null) => {
    try {
      return new URL(value || location.href, location.href).href;
    } catch {
      return null;
    }
  };

  const forms: DomForm[] = Array.from(document.forms).map((form) => {
    const actionAttr = form.getAttribute("action");
    const inputs = Array.from(form.querySelectorAll("input, select, textarea")).map((el) => ({
      name: el.getAttribute("name"),
      type:
        el.tagName === "INPUT"
          ? (el.getAttribute("type") || "text").toLowerCase()
          : el.tagName.toLowerCase(),
      placeholder: el.getAttribute("placeholder"),
      autocomplete: el.getAttribute("autocomplete"),
    }));
    return {
      action: actionAttr,
      resolvedAction: resolve(actionAttr),
      method: (form.getAttribute("method") || "get").toLowerCase(),
      inputs,
      hasPasswordField: inputs.some((input) => input.type === "password"),
    };
  });

  // Password fields outside a <form> still matter for phishing kits.
  const looseInputs = Array.from(document.querySelectorAll("input")).filter((el) => !el.form);
  if (looseInputs.some((el) => (el.getAttribute("type") || "").toLowerCase() === "password")) {
    forms.push({
      action: null,
      resolvedAction: null,
      method: "none",
      inputs: looseInputs.map((el) => ({
        name: el.getAttribute("name"),
        type: (el.getAttribute("type") || "text").toLowerCase(),
        placeholder: el.getAttribute("placeholder"),
        autocomplete: el.getAttribute("autocomplete"),
      })),
      hasPasswordField: true,
    });
  }

  const scripts: DomScript[] = Array.from(document.scripts).map((script) => {
    const src = script.getAttribute("src");
    const inline = src ? "" : script.textContent ?? "";
    return {
      src: src ? resolve(src) : null,
      inlineLength: inline.length,
      inlineSnippet: inline ? inline.slice(0, 500) : null,
    };
  });

  const iframes = Array.from(document.querySelectorAll("iframe, frame")).map((frame) => {
    const src = frame.getAttribute("src");
    return { src: src ? resolve(src) : null, visible: isVisible(frame) };
  });

  const refresh = Array.from(document.querySelectorAll("meta[http-equiv]")).find(
    (meta) => (meta.getAttribute("http-equiv") || "").toLowerCase() === "refresh",
  );

  const text = document.body?.innerText ?? document.documentElement?.textContent ?? "";

  return {
    url: location.href,
    title: document.title,
    text: text.slice(0, textMax),
    forms,
    scripts,
    iframes,
    metaRefresh: refresh?.getAttribute("content") ?? null,
    linkCount: document.links.length,
  };
}
