import { DEFAULT_SERVER_PORT } from "@ladybug/shared";
import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? DEFAULT_SERVER_PORT);

createApp().listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
});
