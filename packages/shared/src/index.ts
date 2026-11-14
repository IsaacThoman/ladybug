// Types and constants shared between the server and the desktop app.

export const DEFAULT_SERVER_PORT = 3001;

export type HealthResponse = {
  status: "ok";
  uptimeSeconds: number;
};

export type GreetingResponse = {
  message: string;
};
