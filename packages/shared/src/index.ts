// Types and constants shared between the server, worker, sandbox, web report
// page and the desktop app. Browser-safe: no Node imports.

export * from "./scan.ts";
export * from "./sandbox.ts";

export const DEFAULT_SERVER_PORT = 3001;
export const DEFAULT_WEB_PORT = 5174;

export type HealthResponse = {
  status: "ok";
  uptimeSeconds: number;
};

export type GreetingResponse = {
  message: string;
};
