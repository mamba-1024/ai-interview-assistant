import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { dbReady } from "./db/database.js";

// Import routes
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import resumeRoutes from "./routes/resumes.js";
import sessionRoutes from "./routes/sessions.js";
import deepgramRoutes from "./routes/deepgram.js";

const app = express();

// ─── Middleware ────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like Chrome extensions, Postman)
    if (!origin || config.cors.origin === "*") {
      callback(null, true);
      return;
    }
    // Allow chrome-extension:// origins
    if (origin.startsWith("chrome-extension://")) {
      callback(null, true);
      return;
    }
    callback(null, config.cors.origin === "*" || origin === config.cors.origin);
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
}));

app.use(express.json({ limit: "10mb" }));

// ─── Health check ─────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "0.1.0", timestamp: new Date().toISOString() });
});

// ─── API routes ───────────────────────────────────────────────
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/resumes", resumeRoutes);
app.use("/api/v1/sessions", sessionRoutes);
app.use("/api/v1/deepgram", deepgramRoutes);

// ─── 404 handler ──────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ─── Error handler ────────────────────────────────────────────
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[Server Error]", err.message);
  res.status(500).json({ error: err.message || "Internal server error" });
});

// ─── Start (wait for DB to initialize) ────────────────────────
async function start() {
  await dbReady;
  console.log("[DB] Database ready");

  app.listen(config.port, () => {
    console.log(`\n🚀 AI Interview Assistant API`);
    console.log(`   http://${config.host}:${config.port}`);
    console.log(`   Health: http://${config.host}:${config.port}/health`);
    console.log(`   OpenAI: ${config.openai.apiKey ? "✅ configured" : "⚠️  not configured (mock mode)"}${config.openai.baseURL ? ` (${config.openai.baseURL})` : ""}`);
    console.log(`   Deepgram: ${config.deepgram.apiKey ? "✅ configured" : "⚠️  not configured"}`);
    console.log();
  });
}

start().catch((err) => {
  console.error("[Server] Failed to start:", err);
  process.exit(1);
});
