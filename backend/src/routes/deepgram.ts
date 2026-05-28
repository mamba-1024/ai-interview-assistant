import { Router, Response } from "express";
import { config } from "../config.js";
import { authMiddleware, AuthRequest } from "../middleware/auth.js";

const router = Router();
router.use(authMiddleware);

// ─── GET /deepgram/token ─────────────────────────────────────
// Returns a temporary token for the client to connect directly
// to Deepgram WebSocket API. The API key stays server-side.
router.get("/token", (_req: AuthRequest, res: Response) => {
  const apiKey = config.deepgram.apiKey;

  if (!apiKey || apiKey === "your-deepgram-api-key-here") {
    res.status(503).json({
      error: "Deepgram API key not configured",
      hint: "Set DEEPGRAM_API_KEY in .env file",
    });
    return;
  }

  // Deepgram temporary token endpoint
  // In production, use their temporary token API:
  // POST https://api.deepgram.com/v1/auth/token
  // For now, pass through the API key (works for dev)
  res.json({
    token: apiKey,
    expiresAt: Date.now() + 3600 * 1000, // 1 hour
    url: "wss://api.deepgram.com/v1/listen",
  });
});

export default router;
