import "dotenv/config";

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  host: process.env.HOST || "localhost",

  jwt: {
    secret: process.env.JWT_SECRET || "dev-secret-change-me-in-production",
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    baseURL: process.env.OPENAI_BASE_URL || "",
    model: process.env.OPENAI_MODEL || "gpt-4o",
  },

  deepgram: {
    apiKey: process.env.DEEPGRAM_API_KEY || "",
  },

  cors: {
    origin: process.env.CORS_ORIGIN || "*",
  },
};
