import { Router, Response } from "express";
import { db } from "../db/database.js";
import { authMiddleware, AuthRequest } from "../middleware/auth.js";

const router = Router();
router.use(authMiddleware);

// ─── GET /users/me ────────────────────────────────────────────
router.get("/me", (req: AuthRequest, res: Response) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId) as any;
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    avatar: user.avatar,
    plan: user.plan,
    createdAt: user.created_at,
  });
});

// ─── PATCH /users/me ──────────────────────────────────────────
router.patch("/me", (req: AuthRequest, res: Response) => {
  const { name, language } = req.body;
  const updates: string[] = [];
  const params: any[] = [];

  if (name !== undefined) { updates.push("name = ?"); params.push(name); }
  if (language !== undefined) { updates.push("language = ?"); params.push(language); }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    params.push(req.userId);
    db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId) as any;
  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    avatar: user.avatar,
    plan: user.plan,
    createdAt: user.created_at,
  });
});

export default router;
