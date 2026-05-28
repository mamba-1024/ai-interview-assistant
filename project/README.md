# AI Interview Assistant — Chrome Extension

AI 驱动的实时面试辅导 Chrome 扩展。在 Google Meet、Zoom、Microsoft Teams 等视频会议中，通过语音转写自动捕捉面试问题，并实时生成 AI 回答建议。

## 功能特性

- **实时语音转写** — 基于 Deepgram WebSocket API，将面试对话实时转为文字，支持中英文双语
- **智能问题检测** — 结合静音计时、UtteranceEnd 事件和正则模式匹配（中英文双语），自动识别面试官提问
- **AI 回答建议** — 检测到问题后通过 SSE 流式获取 AI 建议，包含回答策略、关键要点和参考开头
- **简历管理** — 上传 PDF 简历，自动提取技能和经历，作为 AI 建议的上下文参考
- **面试准备** — 基于简历和职位描述生成预测面试题及 STAR 格式答案框架
- **面试复盘** — 面试结束后生成分析报告，包含评分、亮点和改进建议
- **多平台支持** — 自动注入 Google Meet、Zoom、Microsoft Teams 页面
- **中英双语** — 完整的中英文国际化，自动匹配浏览器语言

## 技术栈

| 模块 | 技术 |
|------|------|
| 构建框架 | [WXT](https://wxt.dev) 0.20 + Vite |
| UI | React 19 + Tailwind CSS 3 |
| 状态管理 | Zustand 5 (vanilla + react) + chrome.storage 持久化 |
| 扩展标准 | Chrome Manifest V3 |
| 语音转写 | Deepgram WebSocket API (Offscreen Document) |
| 国际化 | chrome.i18n (中/英) |
| 类型 | TypeScript 5 |

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                    Chrome Extension (MV3)                │
│                                                         │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Popup   │  │  Side Panel  │  │  Content Script  │  │
│  │  快捷状态 │  │  主面板 UI   │  │  会议页面指示器  │  │
│  └─────┬────┘  └──────┬───────┘  └────────┬─────────┘  │
│        │              │                    │            │
│        └──────────────┼────────────────────┘            │
│                       │ chrome.runtime messages          │
│                 ┌─────┴──────┐                           │
│                 │  Background │  ← Service Worker        │
│                 │  消息路由    │  ← 会话状态机            │
│                 │  问题检测    │  ← AI 建议编排           │
│                 └─────┬──────┘                           │
│                       │                                  │
│                 ┌─────┴──────┐                           │
│                 │  Offscreen  │  ← Deepgram WebSocket    │
│                 │  音频捕获    │  ← tabCapture API       │
│                 └────────────┘                           │
└─────────────────────────────────────────────────────────┘
                       │
                       ▼
              Backend API (localhost:3000)
              Express + SQLite + AI Model
```

## 快速开始

### 前置条件

- Node.js ≥ 18
- Chrome / Edge 浏览器
- 后端服务运行中（参见 [backend/README.md](../backend/README.md)）

### 1. 安装依赖

```bash
cd project
npm install
```

### 2. 开发模式

```bash
npm run dev
```

WXT 会自动启动 Chrome 并加载扩展，文件变更时自动重新构建。

### 3. 生产构建

```bash
npm run build
```

产物输出到 `.output/chrome-mv3/`。

### 4. 手动加载

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `.output/chrome-mv3` 目录

## 项目结构

```
project/
├── entrypoints/
│   ├── background/
│   │   └── index.ts           # Service Worker — 消息路由、会话状态机、问题检测
│   ├── content/
│   │   └── index.ts           # Content Script — Shadow DOM 浮动指示器
│   ├── offscreen/
│   │   └── audio-capture.ts   # Offscreen Document — Deepgram 音频捕获
│   ├── popup/
│   │   ├── PopupApp.tsx       # Popup UI — 快捷状态和控制
│   │   └── main.tsx           # Popup 入口
│   └── sidepanel/
│       ├── App.tsx            # Side Panel UI — 主面板（面试/简历/设置）
│       └── main.tsx           # Side Panel 入口
├── components/
│   ├── InterviewChat.tsx      # 面试对话消息流
│   ├── RecordingControls.tsx  # 录制控制（开始/停止/计时）
│   ├── ResumePanel.tsx        # 简历上传 + 职位描述输入
│   ├── SettingsPanel.tsx      # 设置面板
│   └── SuggestionCard.tsx     # AI 建议卡片
├── hooks/
│   └── useServiceWorker.ts    # Service Worker 通信 Hook
├── lib/
│   ├── api.ts                 # 后端 API 客户端（fetch + SSE）
│   ├── auth.ts                # OAuth2 PKCE 认证流程
│   ├── i18n.ts                # 国际化工具
│   ├── interview-prep.ts      # 面试准备（预测题 + STAR 答案）
│   └── question-detector.ts   # 面试问题检测器（中英文）
├── store/
│   └── extensionStore.ts      # Zustand 全局状态（含 chrome.storage 持久化）
├── public/
│   └── _locales/              # i18n 翻译文件（en / zh_CN）
├── wxt.config.ts              # WXT + Manifest V3 配置
├── tailwind.config.js
└── tsconfig.json
```

## 使用方式

### 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Shift+Y` (Windows/Linux) | 切换 Side Panel 面板 |
| `Cmd+Shift+Y` (macOS) | 切换 Side Panel 面板 |

### 面试流程

1. **打开 Side Panel** — 点击扩展图标或使用快捷键
2. **填写面试信息** — 输入公司名称和应聘职位
3. **上传简历（可选）** — 在「简历」标签页上传 PDF，AI 会提取技能作为建议上下文
4. **填写职位描述（可选）** — 粘贴 JD 文本，用于生成预测面试题
5. **开始面试** — 点击「开始面试」按钮，扩展开始捕获音频
6. **实时建议** — 面试官提问后，侧边栏自动显示 AI 回答建议
7. **结束复盘** — 点击「结束面试」，查看面试分析报告

### 支持的会议平台

- Google Meet (`meet.google.com`)
- Zoom (`zoom.us`)
- Microsoft Teams (`teams.microsoft.com` / `teams.live.com`)

## 配置

扩展默认连接 `http://localhost:3000` 后端。如需修改，有两个途径：

**方式一**：修改源码中的 `DEFAULT_BASE_URL`（`lib/api.ts` 和 `lib/interview-prep.ts`）

**方式二**：通过 chrome.storage 运行时设置（Settings Panel 中配置）

## 权限说明

| 权限 | 用途 |
|------|------|
| `sidePanel` | 在浏览器侧边显示主面板 |
| `activeTab` | 获取当前标签页信息 |
| `storage` | 持久化用户设置和面试数据 |
| `tabs` | 管理标签页（Content Script 通信） |
| `alarms` | Service Worker Keep-alive |
| `offscreen` | 创建 Offscreen Document 进行音频捕获 |
| `tabCapture` | 捕获会议标签页的音频流 |

## 开发命令

```bash
# 开发模式（Chrome）
npm run dev

# 开发模式（Firefox）
npm run dev:firefox

# 生产构建
npm run build

# 打包为 .zip（可上传 Chrome Web Store）
npm run zip

# TypeScript 类型检查
npm run compile
```
