# AI Interview Assistant

AI 驱动的实时面试辅导工具，由 Chrome 扩展和后端 API 两部分组成。在视频会议中自动捕获面试对话，实时生成 AI 回答建议。

## 项目结构

```
ai-interview-assistant/
├── project/          # Chrome 扩展前端（WXT + React + TypeScript）
├── backend/          # API 后端（Express + SQLite + AI）
└── docs/             # 设计文档
```

## 快速开始

### 1. 启动后端

```bash
cd backend
cp .env.example .env       # 按需编辑配置
npm install
npm run dev                # http://localhost:3000
```

详见 [backend/README.md](backend/README.md)

### 2. 加载前端扩展

```bash
cd project
npm install
npm run build              # 构建产物 → .output/chrome-mv3/
```

然后在 Chrome `chrome://extensions/` 中开启开发者模式，加载 `.output/chrome-mv3` 目录。

详见 [project/README.md](project/README.md)

## 技术概览

**前端**：WXT 0.20 + React 19 + Tailwind CSS + Zustand + Chrome MV3（Service Worker / Side Panel / Offscreen Document）

**后端**：Express 5 + TypeScript + sql.js (SQLite WASM) + OpenAI SDK（兼容智谱 GLM 等）

**语音**：Deepgram WebSocket API（前端 Offscreen Document 直连，后端代理 Token）

**AI**：通过 SSE 流式传输实时生成面试建议，未配置 API Key 时自动降级为内置 mock 模式

## 许可证

Private — 仅供个人开发使用。
