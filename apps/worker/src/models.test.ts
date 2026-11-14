import assert from "node:assert/strict";
import { test } from "node:test";
import { chatModels } from "./models.ts";

test("offers chat models only, in version order", () => {
  assert.deepEqual(
    chatModels([
      "gpt-4.10",
      "text-embedding-3-small",
      "gpt-4.1",
      "whisper-1",
      "tts-1",
      "dall-e-3",
      "gpt-image-1",
      "omni-moderation-latest",
      "gpt-4o-realtime-preview",
      "gpt-4o-search-preview",
      "o3",
      "gpt-4.1",
    ]),
    ["gpt-4.1", "gpt-4.10", "o3"],
  );
});
