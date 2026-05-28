# AI Interview Assistant — Backend API

AI 面试助手 Chrome 扩展的后端服务，提供用户认证、面试会话管理、AI 实时建议（SSE 流式）、简历解析和 Deepgram 语音转写 Token 代理等功能。

## 技术栈

| 模块 | 技术 |
|------|------|
| 运行时 | Node.js ≥ 18 |
| 框架 | Express 5 |
| 语言 | TypeScript (tsx 直接运行) |
| 数据库 | SQLite (sql.js — 纯 WASM，无需原生编译) |
| AI | OpenAI SDK（兼容智谱 GLM 等 OpenAI 协议的服务） |
| 认证 | JWT (access + refresh token) |
| 文件上传 | multer + pdf-parse |

## 快速开始

### 1. 安装依赖

```bash
cd backend
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，按需修改以下配置：

```env
# 服务
PORT=3000
HOST=localhost

# JWT 签名密钥（生产环境务必更换）
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=7d

# AI 模型（支持 OpenAI 或兼容 API，如智谱 GLM）
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=                    # 留空使用 OpenAI 官方；智谱填 https://open.bigmodel.cn/api/paas/v4/
OPENAI_MODEL=gpt-4o                 # 智谱可填 glm-4-flash 等

# Deepgram 语音转写
DEEPGRAM_API_KEY=your-deepgram-key

# CORS
CORS_ORIGIN=chrome-extension://*
```

> 未配置 `OPENAI_API_KEY` 时，AI 建议接口会自动降级为内置的 mock 模式，方便开发调试。

### 3. 启动服务

```bash
# 开发模式（文件变更自动重启）
npm run dev

# 生产启动
npm start
```

服务启动后访问 `http://localhost:3000/health` 验证状态。

## 项目结构

```
backend/
├── src/
│   ├── config.ts              # 环境变量集中读取
│   ├── server.ts              # Express 应用入口，路由注册
│   ├── db/
│   │   └── database.ts        # sql.js 初始化、Schema 建表、兼容层
│   ├── middleware/
│   │   └── auth.ts            # JWT 鉴权中间件
│   ├── routes/
│   │   ├── auth.ts            # 注册 / OAuth / Token 刷新
│   │   ├── users.ts           # 用户信息查询与更新
│   │   ├── resumes.ts         # 简历 PDF 上传与管理
│   │   ├── sessions.ts        # 面试会话 + AI 建议 (SSE) + 分析
│   │   └── deepgram.ts        # Deepgram WebSocket Token 代理
│   └── services/
│       ├── ai-suggest.ts      # OpenAI 流式建议生成（含 mock 兜底）
│       └── resume-parser.ts   # PDF 文本提取 + 技能/经历启发式解析
├── data/                      # SQLite 数据库文件（自动创建）
├── uploads/                   # 上传的简历文件（自动创建）
├── .env.example
├── package.json
└── tsconfig.json
```

## API 文档

所有接口路径前缀为 `/api/v1`。除认证接口外，均需在请求头中携带 JWT：

```
Authorization: Bearer <access_token>
```

### 认证

#### `POST /auth/register`

开发环境简易注册，传入邮箱即可自动创建用户并返回 Token。

```json
// Request
{ "email": "user@example.com", "name": "张三" }

// Response
{
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "expires_in": 604800,
  "token_type": "Bearer"
}
```

#### `POST /auth/oauth`

Chrome 扩展 OAuth PKCE 回调。本地开发模式下 `code` 字段作为邮箱自动创建用户。

```json
{ "code": "user@example.com", "redirect_uri": "...", "code_verifier": "..." }
```

#### `POST /auth/refresh`

用 refresh_token 换取新的 Token 对。

```json
{ "refresh_token": "eyJ..." }
```

---

### 用户

#### `GET /users/me`

获取当前登录用户信息。

```json
{
  "id": "uuid",
  "email": "user@example.com",
  "name": "张三",
  "avatar": null,
  "plan": "free",
  "createdAt": "2026-01-01 00:00:00"
}
```

#### `PATCH /users/me`

更新用户信息（可选字段：`name`、`language`）。

```json
{ "name": "李四", "language": "zh_CN" }
```

---

### 简历

#### `POST /resumes`

上传 PDF 简历（`multipart/form-data`，字段名 `resume`，上限 5MB）。后台异步解析文本并提取技能/经历。

```json
{
  "id": "uuid",
  "filename": "resume.pdf",
  "parseStatus": "parsing",
  "uploadedAt": "..."
}
```

#### `GET /resumes`

列出当前用户的所有简历。

#### `GET /resumes/:id`

获取单份简历详情。

#### `DELETE /resumes/:id`

删除简历。

---

### 面试会话

#### `POST /sessions`

创建面试会话。

```json
// Request
{ "company": "字节跳动", "role": "高级前端工程师", "resumeId": "uuid" }

// Response
{
  "id": "uuid",
  "company": "字节跳动",
  "role": "高级前端工程师",
  "resumeId": "uuid",
  "status": "active",
  "createdAt": "...",
  "updatedAt": "..."
}
```

#### `GET /sessions`

列出当前用户的面试会话（最近 50 条）。

#### `GET /sessions/:id`

获取会话详情，包含完整的 transcript 和 suggestions。

#### `POST /sessions/:id/suggest` ⚡ SSE

实时流式获取 AI 面试建议。响应为 `text/event-stream` 格式。

```json
// Request
{
  "question": "请描述你的性能优化经验",
  "context": "面试官刚问了前端性能相关的问题",
  "resumeId": "uuid",
  "language": "zh_CN"
}

// SSE Stream
data: {"type":"suggestion_start","data":null}
data: {"type":"suggestion_chunk","data":"### 策略\n结合..."}
data: {"type":"suggestion_chunk","data":"大型Web应用场景..."}
...
data: {"type":"suggestion_end","data":null}
data: [DONE]
```

#### `POST /sessions/:id/analyze`

结束会话并生成面试分析报告。

```json
{
  "sessionId": "uuid",
  "overallScore": 75,
  "strengths": ["..."],
  "improvements": ["..."],
  "detailedFeedback": "..."
}
```

---

### Deepgram

#### `GET /deepgram/token`

获取临时 Token，供前端直连 Deepgram WebSocket 进行语音转写。API Key 始终保留在服务端。

```json
{
  "token": "dg_...",
  "expiresAt": 1700000000000,
  "url": "wss://api.deepgram.com/v1/listen"
}
```

## 健康检查

```bash
curl http://localhost:3000/health
# {"status":"ok","version":"0.1.0","timestamp":"..."}
```

## 开发说明

**数据库**：使用 sql.js（SQLite WASM 版本），数据存储在内存中，写入操作后 2 秒自动刷盘到 `data/interview.db`。进程退出时也会强制保存。无需安装任何 C++ 编译工具链。

**AI 建议**：通过 OpenAI SDK 调用，支持任何兼容 OpenAI Chat Completions API 的服务。配置 `OPENAI_BASE_URL` 即可切换到智谱 GLM、Moonshot 等国产大模型。未配置 Key 时自动使用内置 mock 模式。

**类型检查**：`npm run typecheck` 运行 TypeScript 类型检查（不生成产物）。
