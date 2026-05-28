import { readFileSync } from "fs";
import { db } from "../db/database.js";

// Use dynamic import for pdf-parse since it's CJS
let pdfParse: any;
async function loadPdfParser() {
  if (!pdfParse) {
    pdfParse = (await import("pdf-parse")).default;
  }
  return pdfParse;
}

export async function parseResumePDF(filePath: string, resumeId: string): Promise<void> {
  try {
    const parser = await loadPdfParser();
    const buffer = readFileSync(filePath);
    const data = await parser(buffer);

    const text: string = data.text || "";

    // Simple heuristic extraction
    const skills = extractSkills(text);
    const experience = extractExperience(text);

    db.prepare(`
      UPDATE resumes
      SET parsed_content = ?, skills = ?, experience = ?, parse_status = 'completed'
      WHERE id = ?
    `).run(text, JSON.stringify(skills), JSON.stringify(experience), resumeId);
  } catch (err) {
    console.error(`[ResumeParser] Failed for ${resumeId}:`, err);
    db.prepare("UPDATE resumes SET parse_status = 'failed' WHERE id = ?").run(resumeId);
  }
}

function extractSkills(text: string): string[] {
  const skillKeywords = [
    "JavaScript", "TypeScript", "Python", "Java", "Go", "Rust", "C++", "C#",
    "React", "Vue", "Angular", "Node.js", "Express", "FastAPI", "Django",
    "AWS", "GCP", "Azure", "Docker", "Kubernetes", "Terraform",
    "PostgreSQL", "MongoDB", "Redis", "GraphQL", "REST",
    "Git", "CI/CD", "Linux", "Agile", "Scrum",
    "机器学习", "深度学习", "NLP", "PyTorch", "TensorFlow",
    "前端", "后端", "全栈", "微服务", "分布式",
  ];
  const found: string[] = [];
  const lower = text.toLowerCase();
  for (const skill of skillKeywords) {
    if (lower.includes(skill.toLowerCase())) {
      found.push(skill);
    }
  }
  return found;
}

function extractExperience(text: string): string[] {
  const lines = text.split("\n").filter(l => l.trim().length > 5);
  // Look for lines that might be job titles or companies
  const patterns = [
    /(?:engineer|developer|manager|analyst|consultant|lead|director|vp|intern|architect)/i,
    /(?:公司|科技|技术|集团|有限|inc|corp|ltd|llc)/i,
    /(?:20\d{2}\s*[-–—至到]\s*(?:20\d{2}|present|至今|现在))/i,
  ];
  return lines
    .filter(line => patterns.some(p => p.test(line)))
    .slice(0, 10)
    .map(line => line.trim());
}
