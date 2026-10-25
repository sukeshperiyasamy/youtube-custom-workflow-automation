# YouTube Custom Workflow Automation — Extraction Map

This document tracks the extraction of our custom video production workflow design from the original monolithic repository into this independent, modular project.

## Extraction Summary Table

| Original Source Location (`youtube-automation-agent`) | Destination in This Project (`youtube-custom-workflow-automation`) | Component Description & Role |
| :--- | :--- | :--- |
| **`agents/production-orchestrator.js`** | `agents/production-orchestrator.js` | Core job lifecycle state machine: draft creation, planning, scene generation coordination, assembly, quality verification, cancellation, and human approval. |
| **`agents/publishing-scheduling-agent.js`**| `agents/publishing-scheduling-agent.js` | YouTube publishing coordinator with private-by-default enforcement, rights verification, and metadata checks. |
| **`utils/workflow-registry.js`** | `utils/workflow-registry.js` | Model and custom node capability registry; resolves MiniMax H3 W6A8 workflows and maps parameters. |
| **`utils/comfyui-client.js`** | `utils/comfyui-client.js` | WebSocket and HTTP client communicating with local ComfyUI instance (`127.0.0.1:8188`). |
| **`utils/instruction-interpreter.js`** | `utils/instruction-interpreter.js` | Natural language instruction parser, XSS sanitizer, parameter extractor, and batch detector. |
| **`utils/ai-planner.js`** | `utils/ai-planner.js` | Multi-scene script and prompt generator with deterministic offline fallback planner. |
| **`utils/ai-text-service.js`** | `utils/ai-text-service.js` | LLM abstraction supporting Gemini, OpenAI, and local heuristics. |
| **`utils/production-assembler.js`** | `utils/production-assembler.js` | FFmpeg-based scene stitching, audio normalization, and master video compilation. |
| **`utils/ffmpeg.js`** | `utils/ffmpeg.js` | FFmpeg / FFprobe wrapper for media validation, duration checks, and thumbnail extraction. |
| **`utils/quality-gate.js`** | `utils/quality-gate.js` | Multi-check technical verification gate evaluating master video integrity and blocking errors. |
| **`utils/quality-normalizer.js`** | `utils/quality-normalizer.js` | Normalizes legacy vs modern quality check schemas across database records. |
| **`utils/youtube-metadata-validator.js`** | `utils/youtube-metadata-validator.js` | Validates YouTube titles, tags, and description lengths against API limits. |
| **`utils/logger.js`** | `utils/logger.js` | Structured Winston/chalk logging utility. |
| **`database/db.js`** | `database/db.js` | SQLite persistence layer for jobs, scenes, reviews, and publishing schedules. |
| **`workflows/`** | `workflows/` | Custom ComfyUI workflow JSON definitions (MiniMax H3 8-step Turbo, long clip chaining, templates). |
| **`D:\sukesh\test_phase3_safeguards.js`** | `test/safeguards.test.js` | Unit test suite verifying isolated publishing safeguards and cancellation invariants. |
| **`test-studio.js`** | `test/studio.test.js` | Integration test suite verifying workflow selection, ComfyUI link, and plan schemas. |
| **`test-quality-normalization.js`** | `test/quality.test.js` | Test suite verifying quality check normalization and blocking gate rules. |
| *New Independent Component* | `test/interpreter.test.js` | Focused unit tests verifying instruction sanitization, script tag stripping, and batch parsing. |
| *New Independent Component* | `index.js` | Standalone module export and Express REST API server for workflow automation. |
| *New Independent Component* | `cli.js` | Command-line runner for prompt interpretation, plan generation, and dry-run execution. |

---

## Dependency & Import Resolution

1. **Relative Paths Preserved:** All utility and agent imports use relative standard paths (`../utils/`, `./utils/`, `../database/`), ensuring zero external path hardcoding.
2. **Database Isolation:** Database path defaults to local project directory (`data/youtube_automation.db`), created automatically upon initialization.
3. **Hardware Independence:** When local ComfyUI or NVIDIA GPU is offline, the workflow seamlessly falls back to simulation mode (`mock_test_workflow`), allowing full test execution on any machine.
4. **AI Key Fallback:** When Gemini/OpenAI API keys are omitted, `AIPlanner` automatically switches to deterministic multi-scene generation without crashing.
