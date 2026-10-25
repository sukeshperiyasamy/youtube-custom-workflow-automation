const { AITextService } = require('./ai-text-service');
const { Logger } = require('./logger');

class AIPlannerKeyMissingError extends Error {
  constructor(message = 'Gemini API key is not configured. Set GEMINI_API_KEY in .env or enable template fallback.') {
    super(message);
    this.name = 'AIPlannerKeyMissingError';
    this.code = 'GEMINI_API_KEY_REQUIRED';
    this.state = 'awaiting_provider';
  }
}

class AIPlanner {
  constructor(credentials = {}) {
    this.logger = new Logger('AIPlanner');
    this.credentials = credentials;
  }

  hasApiKey() {
    return Boolean(
      this.credentials.gemini?.apiKey ||
      process.env.GEMINI_API_KEY ||
      this.credentials.openai?.apiKey ||
      process.env.OPENAI_API_KEY
    );
  }

  validatePlanSchema(plan) {
    const errors = [];
    if (!plan || typeof plan !== 'object') {
      return { valid: false, errors: ['Plan must be a valid JSON object.'] };
    }
    if (!plan.title || typeof plan.title !== 'string') errors.push('Plan must have a title string.');
    if (!Array.isArray(plan.scenes) || plan.scenes.length === 0) {
      errors.push('Plan must contain a non-empty scenes array.');
    } else {
      plan.scenes.forEach((scene, idx) => {
        if (!scene.scene_id) errors.push(`Scene #${idx + 1} is missing a scene_id.`);
        if (typeof scene.duration_seconds !== 'number' || scene.duration_seconds <= 0) {
          errors.push(`Scene #${idx + 1} must have a positive duration_seconds.`);
        }
        if (!scene.visual_prompt || typeof scene.visual_prompt !== 'string') {
          errors.push(`Scene #${idx + 1} must have a visual_prompt.`);
        }
      });
    }

    if (!plan.youtube_metadata || typeof plan.youtube_metadata !== 'object') {
      errors.push('Plan must have youtube_metadata object.');
    } else {
      const meta = plan.youtube_metadata;
      if (!meta.title || typeof meta.title !== 'string') errors.push('YouTube title is required.');
      if (!meta.description || typeof meta.description !== 'string') errors.push('YouTube description is required.');
      if (!Array.isArray(meta.tags) || meta.tags.length < 3) errors.push('At least 3 YouTube tags are required.');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  async createPlan(input = {}, options = {}) {
    const prompt = String(input.prompt || input.topic || '').trim();
    if (!prompt) {
      throw new Error('A user prompt or topic is required to create a production plan.');
    }

    const targetDuration = Number(input.duration || input.targetDuration || 30);
    const aspectRatio = String(input.aspectRatio || '16:9').trim();
    const format = String(input.format || 'cinematic').trim();
    const visualStyle = String(input.visualStyle || '35mm anamorphic film photography, natural lighting, rich textures').trim();
    const narrationVoice = String(input.narrationVoice || 'Solemn narrator').trim();
    const musicStyle = String(input.musicStyle || 'Cinematic orchestral atmosphere').trim();
    const allowTemplateFallback = options.allowTemplateFallback !== false;

    if (!this.hasApiKey()) {
      if (!allowTemplateFallback) {
        throw new AIPlannerKeyMissingError();
      }
      this.logger.info(`Gemini API key is not yet configured. Using deterministic high-fidelity production planner for prompt: "${prompt}"`);
      return this.generateTemplatePlan({
        prompt,
        targetDuration,
        aspectRatio,
        format,
        visualStyle,
        narrationVoice,
        musicStyle
      });
    }

    // Call live AI service
    this.logger.info(`Generating production plan via AI service for prompt: "${prompt}"`);
    const aiService = new AITextService(this.credentials);
    const systemInstruction = `
You are an expert Hollywood documentary director and YouTube producer.
Given the user's prompt, generate a structured multi-scene production plan strictly adhering to this JSON format:
{
  "title": "Compelling Title",
  "concept": "Synopsis of the production",
  "visual_style": "Detailed visual style guideline",
  "aspect_ratio": "${aspectRatio}",
  "target_duration_seconds": ${targetDuration},
  "scenes": [
    {
      "scene_id": "scene_01",
      "index": 1,
      "title": "Scene 1 Title",
      "duration_seconds": 5.0,
      "frames": 120,
      "visual_prompt": "integrated_multimodal_description: [Shot 1] photorealistic description with lighting and camera motion",
      "soundscape_prompt": "overall_soundscape: natural atmospheric sound design",
      "narration_text": "Narration text for this scene",
      "camera_movement": "Smooth dolly-in or tracking glide",
      "continuity_notes": "Maintains lighting and color palette",
      "use_prev_terminal_frame": false
    }
  ],
  "youtube_metadata": {
    "title": "Catchy YouTube Video Title (under 95 chars)",
    "description": "Engaging description with chapters, context, and hashtags",
    "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
    "category_id": "22",
    "thumbnail_concept": "Visual description of the hero frame for the thumbnail",
    "thumbnail_headline": "SHORT PUNCHY TEXT"
  }
}
Break down the video into ${Math.max(1, Math.round(targetDuration / 5))} scenes of 5.0 seconds each.
Output pure JSON only, without markdown fences or extraneous text.
`;

    try {
      const rawText = await aiService.generateText(`${systemInstruction}\nUser Prompt: ${prompt}`);
      let cleaned = String(rawText || '').trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '').trim();
      }
      const parsed = JSON.parse(cleaned);
      parsed.planning_mode = 'ai_generated';
      parsed.plan_source = 'ai_model';
      const validation = this.validatePlanSchema(parsed);
      if (!validation.valid) {
        this.logger.warn(`AI output failed schema validation: ${validation.errors.join(', ')}. Falling back to deterministic plan.`);
        return this.generateTemplatePlan({ prompt, targetDuration, aspectRatio, format, visualStyle, narrationVoice, musicStyle });
      }
      return parsed;
    } catch (e) {
      this.logger.warn(`AI plan generation error (${e.message}). Falling back to template plan.`);
      if (allowTemplateFallback) {
        return this.generateTemplatePlan({ prompt, targetDuration, aspectRatio, format, visualStyle, narrationVoice, musicStyle });
      }
      throw e;
    }
  }

  generateTemplatePlan(params) {
    const { prompt, targetDuration, aspectRatio, format, visualStyle, musicStyle } = params;
    const clipDuration = 5.0;
    const totalScenes = Math.max(1, Math.round(targetDuration / clipDuration));

    const titleWords = prompt.split(/\s+/).slice(0, 7).join(' ');
    const title = titleWords.charAt(0).toUpperCase() + titleWords.slice(1);

    const scenes = [];
    for (let i = 1; i <= totalScenes; i++) {
      const isFirst = i === 1;
      const isFinal = i === totalScenes;
      let phaseName = `Act ${i}: Development`;
      let camera = 'Smooth steady forward tracking glide';
      if (isFirst) {
        phaseName = 'Act 1: Establishing Vista';
        camera = 'Majestic slow forward tracking approach';
      } else if (isFinal) {
        phaseName = `Act ${i}: Climactic Resolution`;
        camera = 'Slow cinematic deceleration into tranquil hero composition';
      }

      const visualPrompt = `integrated_multimodal_description: [Shot ${i}] Photorealistic cinematic ${format} scene depicting ${prompt}. ${phaseName}. The camera executes a ${camera.toLowerCase()}, highlighting rich textures, authentic architecture, and dynamic natural atmosphere under golden light. ${visualStyle}. Flawless camera stability and realistic spatial depth.\n\noverall_soundscape: Open-air ambient atmosphere, gentle natural breeze, and subtle environmental reverberations.\n\nnon_diegetic_music: ${musicStyle}.`;

      scenes.push({
        scene_id: `scene_${String(i).padStart(2, '0')}`,
        index: i,
        title: `${phaseName}`,
        duration_seconds: clipDuration,
        frames: 120, // 5s at 24 fps
        visual_prompt: visualPrompt,
        soundscape_prompt: `Ambient environment with natural acoustic reverberations.`,
        narration_text: `Scene ${i} exploring ${prompt}.`,
        camera_movement: camera,
        continuity_notes: isFirst ? 'Initial anchor establishing atmosphere' : `Chained seamlessly to terminal frame of Scene ${i - 1}`,
        use_prev_terminal_frame: !isFirst
      });
    }

    const cleanKeywords = prompt.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(w => w.length > 3);
    const tags = Array.from(new Set([
      ...cleanKeywords.slice(0, 6),
      'cinematic',
      '4k',
      'documentary',
      'history',
      'ethereal dreamscript'
    ])).slice(0, 8);

    const plan = {
      title: `${title} | Cinematic 4K Experience`,
      planning_mode: 'deterministic_template_fallback',
      plan_source: 'deterministic_template_fallback',
      concept: `A cinematic ${format} journey exploring ${prompt}, produced with authentic visual continuity and immersive sound design.`,
      visual_style: visualStyle,
      aspect_ratio: aspectRatio,
      target_duration_seconds: totalScenes * clipDuration,
      scenes,
      youtube_metadata: {
        title: `${title} | Cinematic 4K Experience`,
        description: `Experience the breathtaking cinematic exploration of ${prompt}.\n\n🎬 Production Details:\nFormat: ${format.toUpperCase()}\nResolution: 1080p Full HD\nAudio: Immersive Stereo Soundscape\nChannel: Ethereal Dreamscript\n\nChapters:\n` +
          scenes.map((s, idx) => `0:${String(idx * 5).padStart(2, '0')} - ${s.title}`).join('\n') +
          `\n\n#${tags[0] || 'cinematic'} #${tags[1] || 'documentary'} #EtherealDreamscript`,
        tags,
        category_id: '22',
        thumbnail_concept: `A striking, high-contrast wide establishing composition of ${prompt} bathed in dramatic golden light.`,
        thumbnail_headline: title.toUpperCase()
      }
    };

    return plan;
  }
}

module.exports = { AIPlanner, AIPlannerKeyMissingError };