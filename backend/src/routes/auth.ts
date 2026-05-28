import { Router, Response } from "express";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import { db } from "../db/database.js";
import { authMiddleware, AuthRequest } from "../middleware/auth.js";

const router = Router();

// ─── POST /auth/register (dev-only: simple email/password) ────
router.post("/register", (req: AuthRequest, res: Response) => {
  const { email, name } = req.body;
  if (!email) {
    res.status(400).json({ error: "email is required" });
    return;
  }

  // Check if user exists
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as any;
  let userId: string;

  if (existing) {
    userId = existing.id;
  } else {
    userId = uuid();
    db.prepare("INSERT INTO users (id, email, name) VALUES (?, ?, ?)").run(userId, email, name || email.split("@")[0]);
  }

  const accessToken = jwt.sign({ sub: userId }, config.jwt.secret, { expiresIn: config.jwt.expiresIn } as jwt.SignOptions);
  const refreshToken = jwt.sign({ sub: userId, type: "refresh" }, config.jwt.secret, { expiresIn: "30d" } as jwt.SignOptions);

  res.json({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 7 * 24 * 3600,
    token_type: "Bearer",
  });
});

// ─── POST /auth/oauth (Chrome extension OAuth PKCE callback) ─
router.post("/oauth", (req: AuthRequest, res: Response) => {
  const { code, redirect_uri, code_verifier } = req.body;

  // In production: exchange code with OAuth provider, verify PKCE
  // For local dev: auto-create user from code as email
  const email = code?.includes("@") ? code : "dev@example.com";
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as any;
  let userId: string;

  if (existing) {
    userId = existing.id;
  } else {
    userId = uuid();
    db.prepare("INSERT INTO users (id, email, name) VALUES (?, ?, ?)").run(userId, email, email.split("@")[0]);
  }

  const accessToken = jwt.sign({ sub: userId }, config.jwt.secret, { expiresIn: config.jwt.expiresIn } as jwt.SignOptions);
  const refreshToken = jwt.sign({ sub: userId, type: "refresh" }, config.jwt.secret, { expiresIn: "30d" } as jwt.SignOptions);

  res.json({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 7 * 24 * 3600,
    token_type: "Bearer",
  });
});

// ─── POST /auth/refresh ──────────────────────────────────────
router.post("/refresh", (req: AuthRequest, res: Response) => {
  const { refresh_token } = req.body;
  if (!refresh_token) {
    res.status(400).json({ error: "refresh_token is required" });
    return;
  }

  try {
    const payload = jwt.verify(refresh_token, config.jwt.secret) as { sub: string; type: string };
    if (payload.type !== "refresh") {
      res.status(401).json({ error: "Invalid refresh token" });
      return;
    }

    const accessToken = jwt.sign({ sub: payload.sub }, config.jwt.secret, { expiresIn: config.jwt.expiresIn } as jwt.SignOptions);
    const newRefreshToken = jwt.sign({ sub: payload.sub, type: "refresh" }, config.jwt.secret, { expiresIn: "30d" } as jwt.SignOptions);

    res.json({
      access_token: accessToken,
      refresh_token: newRefreshToken,
      expires_in: 7 * 24 * 3600,
      token_type: "Bearer",
    });
  } catch {
    res.status(401).json({ error: "Invalid or expired refresh token" });
  }
});

export default router;
