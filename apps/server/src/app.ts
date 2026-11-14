import cors from "cors";
import express from "express";
import type { GreetingResponse, HealthResponse } from "@ladybug/shared";

const GREETINGS = [
  "Hi there!",
  "Hello from the server!",
  "Keep going, you're doing great.",
  "Time for a stretch?",
  "*happy wiggle*",
];

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => {
    const body: HealthResponse = {
      status: "ok",
      uptimeSeconds: Math.round(process.uptime()),
    };
    res.json(body);
  });

  app.get("/api/greeting", (_req, res) => {
    const message = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
    const body: GreetingResponse = { message };
    res.json(body);
  });

  return app;
}
