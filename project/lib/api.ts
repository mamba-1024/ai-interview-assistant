/**
 * 后端 API 客户端
 */

const API_BASE = "https://api.yourapp.com/v1";

async function getAuthHeaders(): Promise<Record<string, string>> {
  const session = await chrome.storage?.session?.get(["accessToken"]);
  return {
    Authorization: `Bearer ${session?.accessToken ?? ""}`,
    "Content-Type": "application/json",
  };
}

export async function uploadResume(file: File): Promise<any> {
  const headers = await getAuthHeaders();
  const formData = new FormData();
  formData.append("resume", file);
  delete headers["Content-Type"]; // FormData 会自动设置 boundary

  const res = await fetch(`${API_BASE}/resumes`, {
    method: "POST",
    headers,
    body: formData,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json();
}

export async function getResumes(): Promise<any[]> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${API_BASE}/resumes`, { headers });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.json();
}

export async function createSession(data: {
  company: string;
  role: string;
  resumeId?: string;
}): Promise<any> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${API_BASE}/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Create session failed: ${res.status}`);
  return res.json();
}

export async function getAISuggestion(
  sessionId: string,
  question: string,
  context: string,
): Promise<ReadableStream | null> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/suggest`, {
    method: "POST",
    headers,
    body: JSON.stringify({ question, context }),
  });
  if (!res.ok) throw new Error(`Suggestion failed: ${res.status}`);
  return res.body;
}

export async function analyzeSession(sessionId: string): Promise<any> {
  const headers = await getAuthHeaders();
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/analyze`, {
    method: "POST",
    headers,
  });
  if (!res.ok) throw new Error(`Analysis failed: ${res.status}`);
  return res.json();
}
