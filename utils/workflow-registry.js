const fs = require('fs');
const path = require('path');
const { Logger } = require('./logger');

const ASPECT_RATIO_MAP = {
  '16:9': '16:9 (Widescreen)',
  '9:16': '9:16 (Vertical)',
  '1:1': '1:1 (Square)',
  'widescreen': '16:9 (Widescreen)',
  'vertical': '9:16 (Vertical)',
  'square': '1:1 (Square)'
};

class WorkflowRegistry {
  constructor(comfyDir = 'D:\\comfyui') {
    this.comfyDir = path.resolve(comfyDir);
    this.logger = new Logger('WorkflowRegistry');
    this.modelsDir = path.join(this.comfyDir, 'ComfyUI', 'models');
  }

  getWorkflows() {
    return [
      {
        id: 'minimax_h3_turbo_local',
        name: 'MiniMax H3 8-Step Turbo (Local RTX 4070)',
        description: 'Verified high-speed photorealistic video diffusion using MiniMax H3 W6A8, 8-step LoRA, and NVFP4 text encoder.',
        category: 'cinematic',
        supportedAspectRatios: ['16:9', '9:16', '1:1'],
        defaultFps: 24,
        clipFrames: 124, // ~5.16s raw, trimmed to 120 frames / 5.0s
        vramRequiredGb: 11.5,
        requiredModels: [
          { type: 'diffusion_models', file: 'minimax_h3_fl2va_pruned_w6a8.safetensors' },
          { type: 'loras', file: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors' },
          { type: 'text_encoders', file: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors' },
          { type: 'vae', file: 'minimax_h3_video_vae_int8_convrot.safetensors' },
          { type: 'vae', file: 'minimax_h3_audio_vae_fp32.safetensors' }
        ],
        requiredNodes: [
          'MiniMaxH3ImageToVideo',
          'ResolutionSelector',
          'SaveVideo',
          'CreateVideo',
          'SamplerCustomAdvanced'
        ],
        buildPrompt: this.buildMiniMaxH3Prompt.bind(this)
      },
      {
        id: 'mock_test_workflow',
        name: 'Simulation / Mock Workflow (Test Mode)',
        description: 'Safe lightweight workflow for integration tests and dry runs.',
        category: 'test',
        supportedAspectRatios: ['16:9', '9:16', '1:1'],
        defaultFps: 24,
        clipFrames: 24,
        vramRequiredGb: 0,
        requiredModels: [],
        requiredNodes: [],
        buildPrompt: (opts) => ({
          '1': { class_type: 'MockGenerator', inputs: { prompt: opts.prompt, seed: opts.seed || 100 } }
        })
      }
    ];
  }

  get(workflowId) {
    const wf = this.getWorkflows().find(w => w.id === workflowId);
    if (!wf) throw new Error(`Workflow '${workflowId}' not found in registry.`);
    return wf;
  }

  buildMiniMaxH3Prompt(options = {}) {
    const promptText = options.prompt || 'Cinematic scenery in soft lighting';
    const prefix = options.prefix || 'video/MiniMax_H3';
    const length = options.length || 124;
    const seed = options.seed || Math.floor(Math.random() * 1000000);
    const firstFrameName = options.firstFrameName || null;
    const aspectRatioKey = String(options.aspectRatio || '16:9').trim();
    const aspectRatio = ASPECT_RATIO_MAP[aspectRatioKey] || '16:9 (Widescreen)';
    const megapixels = options.megapixels || 0.4; // 864x480 native base, perfect for RTX 4070 VRAM

    const graph = {
      '115': {
        class_type: 'ResolutionSelector',
        inputs: {
          aspect_ratio: aspectRatio,
          megapixels: megapixels,
          multiple: 32
        }
      },
      '127': {
        class_type: 'UNETLoader',
        inputs: {
          unet_name: 'minimax_h3_fl2va_pruned_w6a8.safetensors',
          weight_dtype: 'default'
        }
      },
      '134': {
        class_type: 'LoraLoaderModelOnly',
        inputs: {
          model: ['127', 0],
          lora_name: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
          strength_model: 1.0
        }
      },
      '128': {
        class_type: 'CLIPLoader',
        inputs: {
          clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
          type: 'minimax',
          device: 'default'
        }
      },
      '119': {
        class_type: 'VAELoader',
        inputs: {
          vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors'
        }
      },
      '120': {
        class_type: 'VAELoader',
        inputs: {
          vae_name: 'minimax_h3_audio_vae_fp32.safetensors'
        }
      },
      '129': {
        class_type: 'RandomNoise',
        inputs: {
          noise_seed: seed
        }
      },
      '123': {
        class_type: 'KSamplerSelect',
        inputs: {
          sampler_name: 'res_multistep'
        }
      },
      '124': {
        class_type: 'BasicScheduler',
        inputs: {
          model: ['134', 0],
          scheduler: 'simple',
          steps: 8,
          denoise: 1.0
        }
      },
      '126': {
        class_type: 'BasicGuider',
        inputs: {
          model: ['134', 0],
          conditioning: ['131', 0]
        }
      },
      '125': {
        class_type: 'SamplerCustomAdvanced',
        inputs: {
          noise: ['129', 0],
          guider: ['126', 0],
          sampler: ['123', 0],
          sigmas: ['124', 0],
          latent_image: ['131', 1]
        }
      },
      '122': {
        class_type: 'VAEDecode',
        inputs: {
          samples: ['125', 0],
          vae: ['119', 0]
        }
      },
      '121': {
        class_type: 'VAEDecodeAudio',
        inputs: {
          samples: ['125', 0],
          vae: ['120', 0]
        }
      },
      '130': {
        class_type: 'CreateVideo',
        inputs: {
          images: ['122', 0],
          audio: ['121', 0],
          fps: 24.0
        }
      },
      '92': {
        class_type: 'SaveVideo',
        inputs: {
          video: ['130', 0],
          filename_prefix: prefix,
          format: 'auto'
        }
      }
    };

    if (firstFrameName) {
      graph['100'] = {
        class_type: 'LoadImage',
        inputs: { image: firstFrameName }
      };
      graph['131'] = {
        class_type: 'MiniMaxH3ImageToVideo',
        inputs: {
          clip: ['128', 0],
          vae: ['119', 0],
          prompt: promptText,
          first_frame: ['100', 0],
          width: ['115', 0],
          height: ['115', 1],
          length: length
        }
      };
    } else {
      graph['131'] = {
        class_type: 'MiniMaxH3ImageToVideo',
        inputs: {
          clip: ['128', 0],
          vae: ['119', 0],
          prompt: promptText,
          width: ['115', 0],
          height: ['115', 1],
          length: length
        }
      };
    }

    return graph;
  }

  async verifyWorkflow(workflowId, comfyClient = null) {
    const wf = this.get(workflowId);
    const results = {
      workflowId,
      name: wf.name,
      available: true,
      missingModels: [],
      missingNodes: [],
      comfyConnected: false
    };

    // 1. Verify model files exist in ComfyUI models directory
    for (const req of wf.requiredModels) {
      const fullPath = path.join(this.modelsDir, req.type, req.file);
      if (!fs.existsSync(fullPath)) {
        results.missingModels.push({ type: req.type, file: req.file, expectedPath: fullPath });
        results.available = false;
      }
    }

    // 2. Verify ComfyUI node types if client provided
    if (comfyClient) {
      try {
        const isUp = await comfyClient.isAvailable();
        results.comfyConnected = isUp;
        if (isUp && wf.requiredNodes.length > 0) {
          const info = await comfyClient.getObjectInfo();
          for (const nodeName of wf.requiredNodes) {
            if (!info || !info[nodeName]) {
              results.missingNodes.push(nodeName);
              results.available = false;
            }
          }
        } else if (!isUp && wf.requiredNodes.length > 0) {
          results.available = false;
        }
      } catch (e) {
        results.comfyConnected = false;
        results.available = false;
      }
    }

    return results;
  }
}

module.exports = { WorkflowRegistry, ASPECT_RATIO_MAP };