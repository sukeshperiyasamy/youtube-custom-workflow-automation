# YouTube Custom Workflow Automation

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D18.17.0-brightgreen.svg)](https://nodejs.org/)
[![ComfyUI Integration](https://img.shields.io/badge/ComfyUI-Ready-orange.svg)](https://github.com/comfyanonymous/ComfyUI)
[![Hardware Target](https://img.shields.io/badge/GPU-RTX%204070%2012GB-76b900.svg)](https://www.nvidia.com/)
[![Tests Passing](https://img.shields.io/badge/Tests-38%2F38%20Passing-success.svg)](#quality-assurance)

An autonomous AI video production workflow orchestrator and quality-gated publishing pipeline. This project coordinates natural language instruction interpretation, multi-scene story planning, local ComfyUI video diffusion (specialized for MiniMax H3 W6A8), automated FFmpeg master assembly, rigorous technical quality checks, and YouTube publishing safeguards.

---

## 1. Project Overview

Generating coherent, multi-scene AI video productions on consumer hardware poses significant engineering hurdles:
- **VRAM Constraints:** Running cutting-edge video diffusion models on 12GB consumer GPUs requires exact quantization, resolution control, and memory cleanup.
- **Narrative Continuity:** Independent text-to-video scene prompts easily drift in visual identity, lighting, and composition across shots.
- **Production Assembly & Sync:** Stitched clips often suffer from missing audio tracks, frame rate mismatches, duration shortfalls, or audio sync drift.
- **Safety & Publishing Risks:** Automated YouTube publishing requires robust human-in-the-loop review, rights verification, and default private visibility to prevent unauthorized uploads.

**YouTube Custom Workflow Automation** was built to solve these challenges through an integrated orchestration layer connecting local AI diffusion tools with production quality gates and YouTube API safeguards.

---

## 2. Our Custom Design

This repository contains our original workflow architecture and orchestration logic:

1. **Instruction Interpreter & Sanitizer:** Parses natural language prompts, extracts visual styles, durations, and resolution targets, and sanitizes input to neutralize HTML and script vectors (XSS defense).
2. **Deterministic & LLM Scene Planner:** Translates user concepts into structured multi-scene production plans with explicit camera trajectories, soundscapes, and narration. Includes a high-fidelity offline fallback planner when external AI API keys are unconfigured.
3. **Sequential Scene Chaining:** Solves character and environment drift by automatically conditioning subsequent scenes on the preceding scene's terminal frame (`use_prev_terminal_frame: true`).
4. **MiniMax H3 W6A8 Optimization Profile:** Tailored for 12GB consumer GPUs (e.g. NVIDIA RTX 4070), using native 864×480 base generation with 8-step Turbo LoRA within an ~11.5 GB VRAM peak.
5. **Multi-Stage Technical Quality Gate:** Automatically evaluates assembled master media against duration tolerances, 1080p resolution scaling, audio presence, and container integrity before permitting review.
6. **Publishing Safeguards:** Strict server-side invariants enforcing human rights confirmation, rejection of blocking quality failures, idempotent duplicate upload protection, and private-by-default YouTube uploads.

---

## 3. Architecture

```mermaid
flowchart TD
    User([User Prompt / Instruction]) --> Interp[Instruction Interpreter & XSS Sanitizer]
    Interp --> Planner[AI Production Planner<br/>LLM or Offline Fallback]
    Planner --> Plan[Structured Production Plan<br/>Multi-Scene Scripts & Camera Cues]
    
    Plan --> Orchestrator[Production Orchestrator<br/>State Machine Engine]
    Orchestrator --> SQLite[(Local SQLite Database<br/>Jobs, Scenes & Reviews)]
    
    Orchestrator --> Registry[Workflow Registry]
    Registry --> ComfyClient[ComfyUI Client<br/>WebSocket / HTTP 8188]
    ComfyClient --> ComfyUI[Local ComfyUI Service<br/>MiniMax H3 W6A8 + 8-Step Turbo]
    
    ComfyUI --> Scenes[Generated MP4 Scene Clips]
    Scenes --> Assembler[Production Assembler<br/>FFmpeg Normalization & Audio Sync]
    Assembler --> MasterVideo[Master Final Video<br/>1080p 24fps H.264]
    
    MasterVideo --> QualityGate[Technical Quality Gate<br/>Duration, Resolution, Audio Integrity]
    
    QualityGate -->|Blocking Failure| Blocked[Publishing Disabled<br/>Action Required]
    QualityGate -->|Passed| Review[Human Review & Approval<br/>Rights Confirmation Required]
    
    Review --> Publisher[Publishing Agent<br/>YouTube Data API v3]
    Publisher --> YouTube[YouTube Channel<br/>Default: Private Upload]
```

---

## 4. Workflow Lifecycle

```
[Draft Created]
       │
       ▼
[Instruction Analyzed] ──► Extracted: duration, style, resolution
       │
       ▼
[Plan Generated]       ──► Multi-scene breakdown & camera motion
       │
       ▼
[Generating Scenes]    ──► ComfyUI queue prompt -> Terminal frame chaining
       │
       ▼
[Assembling Master]    ──► FFmpeg scene stitching, audio mixing, upscaling
       │
       ▼
[Quality Evaluation]   ──► Checks: container, 1080p, duration, audio streams
       │
       ├────────────────────────────────┐
       ▼                                ▼
[Quality Passed]                [Blocking Failures]
       │                                │
       ▼                                ▼
[Awaiting Approval]             [Approval Blocked]
       │
       ▼
[Human Rights Confirmed]
       │
       ▼
[YouTube Upload (Private)]
       │
       ▼
[Upload Verified / Completed]
```

---

## 5. Features

### ✅ Completed & Verified Features
- **Natural Language Instruction Interpretation:** Sanitizes XSS/script tags, handles Unicode/accents, and parses batch list requests.
- **Deterministic Multi-Scene Planning:** Generates complete scene descriptions, camera trajectories, and soundscapes even without paid API keys.
- **ComfyUI Integration:** Automated prompt building, execution progress tracking, and asset discovery over WebSocket/HTTP.
- **Terminal Frame Chaining:** Passes the final frame of Scene $N$ as the initial condition for Scene $N+1$.
- **FFmpeg Media Normalization:** 16:9 1080p scaling, audio sync, and thumbnail extraction.
- **Automated Quality Gate:** Identifies duration shortfalls, missing audio tracks, and container corruption.
- **Publishing Safeguards:** Server-side enforcement of human review, rights verification, and private visibility.
- **REST API & CLI:** Full dual-interface operation for automated scripts or server backends.

### 🔮 Planned / Experimental Features
- Multi-voice conversational dialogue synthesis.
- Automatic multilingual caption track generation.
- Dynamic camera path control using Depth/Pose ControlNet nodes.

---

## 6. Repository Structure

```
youtube-custom-workflow-automation/
├── agents/
│   ├── production-orchestrator.js     # Master job lifecycle state machine
│   └── publishing-scheduling-agent.js # YouTube publishing with rights enforcement
├── utils/
│   ├── ai-planner.js                  # Multi-scene production plan generator
│   ├── ai-text-service.js             # LLM API abstraction (Gemini / OpenAI)
│   ├── comfyui-client.js              # ComfyUI WebSocket & REST API adapter
│   ├── ffmpeg.js                      # Media probe & FFmpeg execution wrapper
│   ├── instruction-interpreter.js     # Natural language parser & XSS sanitizer
│   ├── logger.js                      # Colorized Winston logger
│   ├── production-assembler.js        # Video & audio stitching coordinator
│   ├── quality-gate.js                # Technical verification rules engine
│   ├── quality-normalizer.js          # Normalizes legacy & modern check formats
│   ├── workflow-registry.js           # Workflow definitions & model checks
│   └── youtube-metadata-validator.js  # YouTube title/tag constraint checker
├── database/
│   └── db.js                          # SQLite schema and query methods
├── workflows/
│   ├── templates/                     # Production baselines (e.g. 30s architectural)
│   ├── minimaxH3_HQ_long_clip.json    # Default production diffusion workflow
│   ├── minimaxH3Background_v10.json   # Annotated workflow with GUI groups
│   ├── minimaxH3_HQ_motion_test.json  # Motion test profile
│   ├── minimaxH3_official_test.json   # Benchmark validation graph
│   └── README.md                      # Detailed model checkpoints & setup guide
├── test/
│   ├── safeguards.test.js             # 12 isolated safeguard & invariant tests
│   ├── studio.test.js                 # 6 studio integration & schema tests
│   ├── quality.test.js                # 6 quality gate normalization tests
│   └── interpreter.test.js            # 6 instruction parsing & safety tests
├── index.js                           # Module export & Express REST API server
├── cli.js                             # Command-line workflow runner
├── package.json                       # Dependencies & test scripts
├── .gitignore                         # Comprehensive repository exclusion rules
├── .env.example                       # Environment variable templates
├── EXTRACTION_MAP.md                  # Lineage and source extraction mapping
└── README.md                          # Project documentation
```

---

## 7. Requirements

- **Operating System:** Windows 10/11, macOS, or Linux.
- **Runtime:** Node.js **>= 18.17.0** (tested on Node v24.22.1).
- **FFmpeg:** System FFmpeg or `ffmpeg-static` for master assembly.
- **ComfyUI Service:** Local or network ComfyUI instance running on `http://127.0.0.1:8188`.
- **Target GPU:** NVIDIA RTX 3060/4060/4070 (12GB VRAM recommended for MiniMax H3 W6A8).
- **Optional API Keys:** Google Gemini or OpenAI API keys (not required; deterministic offline planner operates automatically).

---

## 8. Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/sukeshperiyasamy/youtube-custom-workflow-automation.git
   cd youtube-custom-workflow-automation
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment:**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` to configure your ComfyUI URL (default `http://127.0.0.1:8188`), ComfyUI installation directory (`COMFYUI_DIR`), and optional AI keys.

4. **Verify ComfyUI & Hardware Connectivity:**
   ```bash
   node cli.js --status
   ```

---

## 9. Running the Workflow

### Option A: Command-Line Interface (CLI)

- **Check connection and registered workflows:**
  ```bash
  node cli.js --status
  ```

- **Run a dry-run plan without rendering:**
  ```bash
  node cli.js --prompt "Ancient Dravidian temple at sunrise" --dry-run
  ```

- **Execute a full production job:**
  ```bash
  node cli.js --prompt "Aerial view of misty mountains" --workflow minimax_h3_turbo_local
  ```

### Option B: REST API Server

Start the standalone workflow server:
```bash
npm start
```
By default, the server listens on `http://127.0.0.1:3456`.

**Available API Endpoints:**
- `GET /health` — Service health & ComfyUI availability.
- `GET /api/workflow/status` — GPU VRAM metrics & registered workflows.
- `POST /api/workflow/interpret` — Sanitize and parse user instructions.
- `POST /api/workflow/plan` — Generate multi-scene production plan.
- `POST /api/workflow/jobs` — Create persistent generation job.
- `GET /api/workflow/jobs/:id` — Retrieve job status and scene manifest.
- `POST /api/workflow/jobs/:id/cancel` — Safe cancellation with state protection.
- `POST /api/workflow/jobs/:id/approve` — Enforce rights verification and quality gates before upload.

---

## 10. Quality Assurance & Test Evidence

The extracted custom workflow includes 38 independent automated tests covering safeguards, quality gates, workflow selection, instruction sanitization, and REST API routing.

Run all tests:
```bash
npm test
```

### Verified Test Results
```
════════════════════════════════════════════════════════════════════════════
                        TEST SUITE RESULTS
════════════════════════════════════════════════════════════════════════════
Suite File                   Coverage Scope                         Status
────────────────────────────────────────────────────────────────────────────
test/safeguards.test.js      Rights checks, 409 rejections,         ✅ 12/12 Passed
                             cancellation state immutability,
                             idempotency, network failure recovery
test/studio.test.js          MiniMax H3 selection, schema checks,   ✅ 6/6 Passed
                             fallback planning, ComfyUI health
test/quality.test.js         Quality checks normalization, duration ✅ 6/6 Passed
                             shortfall blocking, 1080p probe check
test/interpreter.test.js     XSS neutralization, script stripping,  ✅ 6/6 Passed
                             Unicode support, batch list parsing
test/api.test.js             All 8 REST API routes & orchestration  ✅ 8/8 Passed
                             server lifecycle (health, jobs, cancel)
────────────────────────────────────────────────────────────────────────────
TOTAL                        5 Standalone Test Suites               ✅ 38/38 (100%)
════════════════════════════════════════════════════════════════════════════
```

---

## 11. Security & Privacy Safeguards

- **Zero Cleartext Credentials:** Environment variables and OAuth tokens are strictly ignored via `.gitignore` and never committed or logged.
- **XSS Neutralization:** All user instructions pass through `sanitizeTopic()`, stripping `<script>`, `<style>`, inline event handlers (`onerror`), and `javascript:` URIs.
- **Default Private Publishing:** All YouTube uploads enforce `privacyStatus: 'private'` by default.
- **Dual Confirmation Gate:** Publishing is completely blocked unless:
  1. The user explicitly confirms the review and rights checkbox (`confirmRights: true`).
  2. The technical quality gate reports zero blocking failures (`blockingFailures: []`).

---

## 12. Attribution & External Tools

This custom workflow is built upon and orchestrates several outstanding open-source technologies:
- **[ComfyUI](https://github.com/comfyanonymous/ComfyUI):** Powerful, modular node-based diffusion execution engine.
- **MiniMax H3 Model:** Advanced video generation diffusion model, quantized for consumer GPUs.
- **[FFmpeg](https://ffmpeg.org/):** Master media normalization, audio sync, and thumbnail encoding.
- **[SQLite](https://www.sqlite.org/):** Lightweight, zero-config relational database for job and scene persistence.
- **[Node.js](https://nodejs.org/):** Asynchronous JavaScript runtime environment.
- **Community Workflow Credit (`minimaxH3Background_v10.json`):** Authored by community researcher **bruxosdovfx**, featuring SyncTile v5.5, 3D latent upscaler nodes (by LBH-123-AI), and background swap graphs.

*We do not claim authorship of ComfyUI, FFmpeg, MiniMax models, bruxosdovfx workflows, or external YouTube APIs.*

---

## 13. License

This project's custom orchestration engine, state machine, FFmpeg assembly logic, quality gates, API server, and CLI tools are licensed under the **MIT License**. See the [LICENSE](LICENSE) file for details.

Third-party models, node extensions, and workflow templates remain subject to the respective terms and licenses of their original authors.
