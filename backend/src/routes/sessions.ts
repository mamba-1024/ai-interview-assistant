import { Router, Response } from "express";
import { v4 as uuid } from "uuid";
import { db } from "../db/database.js";
import { authMiddleware, AuthRequest } from "../middleware/auth.js";
import { streamSuggestion } from "../services/ai-suggest.js";

const router = Router();
router.use(authMiddleware);

// ─── POST /sessions (create) ─────────────────────────────────
router.post("/", (req: AuthRequest, res: Response) => {
  const { company, role, resumeId, language } = req.body;
  const id = uuid();

  db.prepare(`
    INSERT INTO sessions (id, user_id, company, role, resume_id, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run(id, req.userId, company || "", role || "", resumeId || null);

  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as any;
  res.json(formatSession(session));
});

// ─── GET /sessions (list) ────────────────────────────────────
router.get("/", (req: AuthRequest, res: Response) => {
  const sessions = db.prepare(
    "SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
  ).all(req.userId) as any[];
  res.json(sessions.map(formatSession));
});

// ─── GET /sessions/:id (detail with transcripts + suggestions) ─
router.get("/:id", (req: AuthRequest, res: Response) => {
  const session = db.prepare(
    "SELECT * FROM sessions WHERE id = ? AND user_id = ?"
  ).get(req.params.id, req.userId) as any;

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  res.json({
    ...formatSession(session),
    transcript: tryParseJson(session.transcript, []),
    suggestions: tryParseJson(session.suggestions, []),
    analysis: session.analysis ? tryParseJson(session.analysis, null) : undefined,
  });
});

// ─── POST /sessions/:id/suggest (streaming SSE) ──────────────
router.post("/:id/suggest", async (req: AuthRequest, res: Response) => {
  const { question, context, resumeId, language } = req.body;

  if (!question) {
    res.status(400).json({ error: "question is required" });
    return;
  }

  const session = db.prepare(
    "SELECT * FROM sessions WHERE id = ? AND user_id = ?"
  ).get(req.params.id, req.userId) as any;

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // Fetch resume context if available
  let resumeContext = "";
  const rid = resumeId || session.resume_id;
  if (rid) {
    const resume = db.prepare("SELECT parsed_content, skills, experience FROM resumes WHERE id = ?").get(rid) as any;
    if (resume?.parsed_content) {
      resumeContext = `Candidate resume highlights:\nSkills: ${resume.skills}\nExperience: ${resume.experience}\nSummary: ${resume.parsed_content.slice(0, 500)}`;
    }
  }

  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  try {
    let fullText = "";

    for await (const chunk of streamSuggestion({
      question,
      context,
      resumeContext,
      company: session.company,
      role: session.role,
      language: language || "zh_CN",
    })) {
      if (chunk.type === "suggestion_chunk") {
        fullText += typeof chunk.data === "string" ? chunk.data : "";
      }
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    // Save suggestion to session
    const suggestions = tryParseJson(session.suggestions, []);
    suggestions.push({
      id: uuid(),
      question,
      suggestion: fullText,
      timestamp: Date.now(),
    });
    db.prepare("UPDATE sessions SET suggestions = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(suggestions), req.params.id);

    res.write(`data: [DONE]\n\n`);
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ type: "error", data: err.message })}\n\n`);
  }

  res.end();
});

// ─── POST /sessions/:id/analyze ──────────────────────────────
router.post("/:id/analyze", async (req: AuthRequest, res: Response) => {
  const session = db.prepare(
    "SELECT * FROM sessions WHERE id = ? AND user_id = ?"
  ).get(req.params.id, req.userId) as any;

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // Mark session as completed
  db.prepare("UPDATE sessions SET status = 'completed', updated_at = datetime('now') WHERE id = ?")
    .run(req.params.id);

  const transcript = tryParseJson(session.transcript, []);
  const suggestions = tryParseJson(session.suggestions, []);

  // Basic analysis (in production, this would use AI)
  const analysis = {
    sessionId: req.params.id,
    overallScore: Math.min(100, 60 + suggestions.length * 5 + transcript.length * 2),
    strengths: [
      "Good communication flow",
      "Relevant experience highlighted",
    ],
    improvements: [
      "Consider using more STAR framework examples",
      "Add more quantifiable achievements",
    ],
    detailedFeedback: `Interview session for ${session.role} at ${session.company}. ${transcript.length} transcript entries, ${suggestions.length} AI suggestions generated.`,
  };

  db.prepare("UPDATE sessions SET analysis = ? WHERE id = ?")
    .run(JSON.stringify(analysis), req.params.id);

  res.json(analysis);
});

// ─── Helpers ──────────────────────────────────────────────────
function formatSession(s: any) {
  return {
    id: s.id,
    company: s.company,
    role: s.role,
    resumeId: s.resume_id,
    status: s.status,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

function tryParseJson(val: string | null, fallback: any): any {
  if (!val) return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

export default router;
