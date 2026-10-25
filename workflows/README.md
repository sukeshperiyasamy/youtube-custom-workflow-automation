# ComfyUI Production Workflows

This directory contains the verified ComfyUI workflow definitions for high-speed, photorealistic video diffusion using the MiniMax H3 W6A8 model and 8-step Turbo LoRA on consumer NVIDIA GPUs (e.g. RTX 4070 12GB).

## Included Workflows

1. **`minimaxH3_HQ_long_clip.json`** (Default Production Workflow)
   - Verified end-to-end with `utils/workflow-registry.js` and `agents/production-orchestrator.js`.
   - Native base generation: 864x480 (0.4 MP, multiple of 32) at 24 fps.
   - VRAM envelope: ~11.5 GB VRAM peak.
   - Chaining: Scene 1 executes text-to-video without reference image. Subsequent scenes automatically condition on the preceding scene's terminal frame via `LoadImage` (Node 100) linked into `first_frame` of `MiniMaxH3ImageToVideo` (Node 131).

2. **`minimaxH3Background_v10.json`**
   - Full graphical GUI workflow with groups, visual layout nodes, and detailed annotation notes.

3. **`minimaxH3_HQ_motion_test.json`**
   - Tuned motion parameter profile for dynamic camera movement tracking tests.

4. **`minimaxH3_official_test.json` & `minimaxH3_W6A8_test.json`**
   - Model benchmark and official validation test graphs for quantized W6A8 weights.

5. **`templates/`**
   - Baseline long-clip production templates tested with Indian architectural documentary sequences (*Meenakshi Amman Temple*, *Thanjavur Brihadisvara Temple*).

## Required Checkpoints & Locations

Place the following files in your ComfyUI models directory (`D:\comfyui\ComfyUI\models`):

- **Diffusion UNET** (`models/diffusion_models/`):
  `minimax_h3_fl2va_pruned_w6a8.safetensors`
- **Turbo LoRA** (`models/loras/`):
  `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors`
- **Text Encoder** (`models/text_encoders/`):
  `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`
- **Video VAE** (`models/vae/`):
  `minimax_h3_video_vae_int8_convrot.safetensors`
- **Audio VAE** (`models/vae/`):
  `minimax_h3_audio_vae_fp32.safetensors`

## Custom Node Requirements

Ensure the ComfyUI MiniMax H3 node pack is installed, providing:
- `MiniMaxH3ImageToVideo`
- `ResolutionSelector`
- `CreateVideo`
- `SaveVideo`
- `SamplerCustomAdvanced`
