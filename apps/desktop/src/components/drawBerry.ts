import type { Food } from "../food";

// In the units of the berry's drawing (see Berry.tsx), which is 24 across.
/** How far the bitten edge travels across the berry, from untouched to gone. */
const BITE_FROM = -16.5;
const BITE_TO = 6.5;
/** The flesh shows this far past the skin's bitten edge. */
const FLESH_RIM = 1.6;

/** Puts the berry where it is and shows how much of it is left. */
export function drawBerry(el: HTMLElement, food: Food) {
  el.style.transform = `translate3d(${food.x}px, ${food.y}px, 0)`;
  if (el.dataset.mode !== food.mode) el.dataset.mode = food.mode;
  const eaten = Math.min(1, Math.max(0, 1 - food.left));
  const key = `${food.biteFrom}:${eaten.toFixed(3)}`;
  if (el.dataset.bite === key) return;
  el.dataset.bite = key;
  // The masks bite from the left; from the right, the whole berry is drawn mirrored.
  el.querySelector("[data-berry]")?.setAttribute("transform", food.biteFrom === 1 ? "scale(-1 1)" : "");
  const edge = BITE_FROM + (BITE_TO - BITE_FROM) * eaten;
  el.querySelector('[data-bite="skin"]')?.setAttribute("transform", `translate(${edge} 0)`);
  el.querySelector('[data-bite="flesh"]')?.setAttribute("transform", `translate(${edge - FLESH_RIM} 0)`);
}
