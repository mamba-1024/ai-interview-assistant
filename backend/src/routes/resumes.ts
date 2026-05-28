import { Router, Response } from "express";
import { v4 as uuid } from "uuid";
import multer from "multer";
import { join, dirname } from "path";
import { mkdirSync, existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { db } from "../db/database.js";
import { authMiddleware, AuthRequest } from "../middleware/auth.js";
import { parseResumePDF } from "../services/resume-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = join(__dirname, "..", "..", "uploads");
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${uuid()}-${file.originalname}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf" || file.originalname.endsWith(".pdf")) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are accepted"));
    }
  },
});

const router = Router();
router.use(authMiddleware);

// ─── POST /resumes (upload) ──────────────────────────────────
router.post("/", upload.single("resume"), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const id = uuid();
    const filename = req.file.originalname;
    const filePath = req.file.path;

    db.prepare(
      "INSERT INTO resumes (id, user_id, filename, file_path, parse_status) VALUES (?, ?, ?, ?, 'parsing')"
    ).run(id, req.userId, filename, filePath);

    // Parse PDF in background
    parseResumePDF(filePath, id).catch(console.error);

    const resume = db.prepare("SELECT * FROM resumes WHERE id = ?").get(id) as any;
    res.json(formatResume(resume));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /resumes ─────────────────────────────────────────────
router.get("/", (req: AuthRequest, res: Response) => {
  const resumes = db.prepare("SELECT * FROM resumes WHERE user_id = ? ORDER BY uploaded_at DESC").all(req.userId) as any[];
  res.json(resumes.map(formatResume));
});

// ─── GET /resumes/:id ─────────────────────────────────────────
router.get("/:id", (req: AuthRequest, res: Response) => {
  const resume = db.prepare("SELECT * FROM resumes WHERE id = ? AND user_id = ?").get(req.params.id, req.userId) as any;
  if (!resume) {
    res.status(404).json({ error: "Resume not found" });
    return;
  }
  res.json(formatResume(resume));
});

// ─── DELETE /resumes/:id ──────────────────────────────────────
router.delete("/:id", (req: AuthRequest, res: Response) => {
  const result = db.prepare("DELETE FROM resumes WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  if (result.changes === 0) {
    res.status(404).json({ error: "Resume not found" });
    return;
  }
  res.json({ success: true });
});

function formatResume(r: any) {
  return {
    id: r.id,
    filename: r.filename,
    parsedContent: r.parsed_content || undefined,
    skills: tryParseJson(r.skills, []),
    experience: tryParseJson(r.experience, []),
    parseStatus: r.parse_status,
    uploadedAt: r.uploaded_at,
  };
}

function tryParseJson(val: string | null, fallback: any[]): any[] {
  if (!val) return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

export default router;
