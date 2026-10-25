/**
 * Instruction Interpreter
 * Analyzes natural-language video production instructions, extracts topics & constraints,
 * enforces instruction precedence, validates schemas, detects conflicts, and supports multi-topic batching.
 */

const { Logger } = require('./logger');
const { AITextService } = require('./ai-text-service');

const logger = new Logger('InstructionInterpreter');

// Allowed technical constraints
const ALLOWED_ASPECT_RATIOS = ['16:9', '9:16', '1:1'];
const ALLOWED_RESOLUTIONS = ['1080p', '720p', '4k'];
const DEFAULT_FPS = 24;
const MIN_DURATION = 5;
const MAX_DURATION = 600;
const MAX_PROMPT_LENGTH = 10000;

class InstructionInterpreter {
  constructor(credentials = {}) {
    this.credentials = credentials;
    this.logger = logger;
  }

  /**
   * Optional LLM-assisted interpretation when an active AI provider key is present
   */
  async interpretWithAI(text) {
    try {
      const ai = new AITextService(this.credentials);
      if (!ai.isAvailable()) return null;

      const systemPrompt = `You are an expert AI video production coordinator.
Analyze the user's instructions and extract:
1. topics: array of video topics/subjects (if multiple topics, list each individually)
2. batchMode: "single", "separate_videos", or "combined_video"
3. duration: target duration in seconds (number)
4. aspectRatio: "16:9", "9:16", or "1:1"
5. resolution: "1080p", "720p", or "4k"
6. fps: number (e.g. 24)
7. visualStyle: visual aesthetic and lighting guidelines
8. narrationLanguage: language for voiceover (e.g. "Tamil", "English")
9. narrationVoice: voice characteristics
10. musicStyle: music/soundscape description
11. publishingPolicy: "approval_required", "pre_authorized", or "draft_only"
12. visibility: "private", "unlisted", or "public"

Output pure JSON only.`;

      const resp = await ai.generateText(`${systemPrompt}\n\nUser Instruction: "${text}"`);
      let cleaned = String(resp || '').trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '').trim();
      }
      const parsed = JSON.parse(cleaned);
      return parsed;
    } catch (e) {
      this.logger.warn(`AI instruction interpretation skipped: ${e.message}`);
      return null;
    }
  }

  /**
   * Main interpretation entrypoint
   * @param {string} rawInstruction - Natural language prompt from user
   * @param {Object} options - Application/account policy overrides & defaults
   */
  async interpret(rawInstruction, options = {}) {
    const text = String(rawInstruction || '').trim();
    if (!text) {
      return {
        valid: false,
        error: 'Instruction cannot be empty. Please provide one or more video topics and instructions.',
        originalInstruction: '',
        topics: [],
        batchMode: 'single',
        plan: null,
        conflicts: [{ field: 'instruction', description: 'Instruction cannot be empty', blocking: true }],
        clarificationNeeded: false
      };
    }

    if (text.length > MAX_PROMPT_LENGTH) {
      return {
        valid: false,
        error: `Instruction exceeds maximum allowed length (${text.length} chars > ${MAX_PROMPT_LENGTH} limit).`,
        originalInstruction: text.slice(0, 300) + '...',
        topics: [],
        batchMode: 'single',
        plan: null,
        conflicts: [{ field: 'length', description: 'Excessively long input', blocking: true }],
        clarificationNeeded: false
      };
    }

    // 1. Detect multi-topic vs single topic
    const topicAnalysis = this.detectTopics(text);

    // 2. Extract technical parameters from text
    const extracted = this.extractParameters(text);

    // 3. Instruction Precedence:
    //    1. Explicit user instructions > 2. Configured policies > 3. Validated technical constraints > 4. Defaults
    const mergedSettings = this.applyPrecedence(extracted, options);

    // 4. Detect conflicts
    const conflicts = this.detectConflicts(text, extracted, mergedSettings);

    const hasBlockingConflict = conflicts.some(c => c.blocking);
    const clarificationNeeded = topicAnalysis.clarificationNeeded || conflicts.some(c => c.requiresClarification);

    let clarificationPrompt = null;
    if (clarificationNeeded) {
      clarificationPrompt = 'Please clarify conflicting requirements: ' + conflicts.map(c => c.description).join(' ');
    }

    // 5. Build individual plans for each topic
    const plans = topicAnalysis.topics.map((t, idx) => ({
      index: idx + 1,
      topic: t,
      targetDuration: mergedSettings.duration,
      aspectRatio: mergedSettings.aspectRatio,
      resolution: mergedSettings.resolution,
      fps: mergedSettings.fps,
      format: mergedSettings.format,
      visualStyle: mergedSettings.visualStyle,
      narrationLanguage: mergedSettings.narrationLanguage,
      narrationVoice: mergedSettings.narrationVoice,
      musicStyle: mergedSettings.musicStyle,
      soundEffects: mergedSettings.soundEffects,
      publishingPolicy: mergedSettings.publishingPolicy,
      visibility: mergedSettings.visibility,
      workflowId: mergedSettings.workflowId || 'minimax_h3_turbo_local'
    }));

    const isBatch = topicAnalysis.topics.length > 1;
    const batchMode = topicAnalysis.batchMode;

    const summaryText = this.generateSummaryText({
      topics: topicAnalysis.topics,
      batchMode,
      settings: mergedSettings,
      conflicts
    });

    return {
      valid: !hasBlockingConflict,
      originalInstruction: text,
      topics: topicAnalysis.topics,
      topicCount: topicAnalysis.topics.length,
      isBatch,
      batchMode,
      clarificationNeeded,
      conflicts,
      clarificationPrompt,
      settings: mergedSettings,
      plans,
      summaryText
    };
  }

  /**
   * Detects whether user provided single or multiple topics
   */
  sanitizeTopic(topic) {
    if (!topic || typeof topic !== 'string') return '';
    return topic
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<[^>]*>?/gm, '')
      .replace(/javascript\s*:[^\s]+\s*/gi, '')
      .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
      .replace(/on\w+\s*=\s*[^\s>]+/gi, '')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .trim();
  }

  detectTopics(text) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const firstSentence = text.split(/(?:(?<=[a-z0-9])[.!?]\s+|\r?\n)/i)[0].trim();

    // Check for explicit multi-video phrasing
    const asksSeparate = /\b(separate videos|individual videos|one video each|separate video for each|multiple videos|separate \d+-(?:second|minute) videos)\b/i.test(text);
    const asksCombined = /\b(single video|one video|single combined video|one combined video|combined video)\b/i.test(text);

    // 1. Numbered lists: "1. Topic A\n2. Topic B"
    const numberedList = lines.filter(l => /^\d+[\.\)]\s+/.test(l)).map(l => l.replace(/^\d+[\.\)]\s+/, '').trim());

    // 2. Bulleted lists: "- Topic A\n- Topic B"
    const bulletList = lines.filter(l => /^[-*•]\s+/.test(l)).map(l => l.replace(/^[-*•]\s+/, '').trim());

    // 3. Explicit "Topics:" or "Videos:" header
    const topicsHeaderMatch = text.match(/\b(?:topics|videos|subjects|titles)\s*:\s*([^.\n]+(?:\n[^\n]+)*)/i);
    let headerTopics = [];
    if (topicsHeaderMatch) {
      headerTopics = topicsHeaderMatch[1]
        .split(/[;,\n]+/)
        .map(t => t.replace(/^[-*•\d\.\)]\s*/, '').trim())
        .filter(t => t.length > 3 && !/^(and|or)$/i.test(t));
    }

    // 4. Inline Oxford list constrained to the first sentence:
    // e.g. "videos about solar energy, ocean conservation, and space exploration"
    let inlineTopics = [];
    const aboutListMatch = firstSentence.match(/\b(?:about|on|covering|highlighting|exploring)\s+([^,]+(?:\s*,\s*[^,]+)*(?:,\s*and\s+|\s+and\s+)[^,]+)/i);
    if (aboutListMatch && aboutListMatch[1]) {
      const rawList = aboutListMatch[1];
      const items = rawList.split(/,\s*and\s+|\s+and\s+|,\s*/).map(s => s.trim()).filter(s => s.length > 2);
      if (items.length >= 2) {
        inlineTopics = items;
      }
    }

    // 5. Inline numbered list e.g. "1. Topic A, 2. Topic B, 3. Topic C"
    let inlineNumberedList = [];
    if (/\b(?:separate videos|multiple videos|videos|topics|produce \d+ separate videos)\b/i.test(text) && /\b1[\.\)]\s+/.test(text) && /\b2[\.\)]\s+/.test(text)) {
      const parts = text.split(/\s*(?:\d+[\.\)])\s+/).slice(1);
      inlineNumberedList = parts.map(p => p.split(/[,;\n]|\.\s+[A-Z0-9]/)[0].trim()).filter(Boolean);
    }

    let detected = [];
    if (numberedList.length >= 2) {
      detected = numberedList;
    } else if (inlineNumberedList.length >= 2) {
      detected = inlineNumberedList;
    } else if (bulletList.length >= 2) {
      detected = bulletList;
    } else if (headerTopics.length >= 2) {
      detected = headerTopics;
    } else if (inlineTopics.length >= 2) {
      detected = inlineTopics;
    }

    // Filter out lines that look like instructions rather than topics
    detected = detected.filter(item => {
      const isInstructionOnly = /^(use\s+|create\s+|make\s+|upload\s+|write\s+|synchronize\s+|validate\s+|repair\s+)/i.test(item) && item.split(/\s+/).length > 8;
      return !isInstructionOnly;
    });

    detected = detected.map(item => this.sanitizeTopic(item)).filter(t => t.length > 0);

    if (detected.length >= 2) {
      if (asksSeparate) {
        return {
          topics: detected,
          batchMode: 'separate_videos',
          clarificationNeeded: false
        };
      } else if (asksCombined) {
        return {
          topics: [detected.join(' & ')],
          batchMode: 'combined_video',
          clarificationNeeded: false
        };
      } else {
        return {
          topics: detected,
          batchMode: 'separate_videos', // default to separate videos as safest
          clarificationNeeded: false,
          suggestedBatchModeChoice: true
        };
      }
    }

    // Single topic extraction
    let cleanTopic = text;
    const aboutMatch = firstSentence.match(/\b(?:create|generate|make|produce)\s+(?:a|an)?\s*(?:[0-9a-z\s-]*\s+)?(?:video|clip|documentary)?\s+\b(?:about|on|covering|highlighting|exploring)\s+(.+)/i);
    if (aboutMatch && aboutMatch[1]) {
      cleanTopic = aboutMatch[1].trim();
    } else {
      cleanTopic = firstSentence.replace(/^(create|generate|make|produce)\s+(a|an)?\s*/i, '').trim();
    }
    cleanTopic = this.sanitizeTopic(cleanTopic);
    detected = detected.map(t => t.replace(/<[^>]*>?/gm, '').trim());

    return {
      topics: [cleanTopic],
      batchMode: 'single',
      clarificationNeeded: false
    };
  }

  /**
   * Extracts technical parameters from natural language text
   */
  extractParameters(text) {
    const extracted = {};

    // 1. Target Duration
    const secMatch = text.match(/\b(\d+)\s*(?:-|\s*)?(?:seconds?|secs?|s)\b/i);
    const minMatch = text.match(/\b(?:(\d+)|one|two|three|four|five)\s*(?:-|\s*)?(?:minutes?|mins?|m)\b/i);

    if (secMatch) {
      extracted.duration = parseInt(secMatch[1], 10);
    } else if (minMatch) {
      const wordMap = { one: 1, two: 2, three: 3, four: 4, five: 5 };
      const minutes = minMatch[1] ? parseInt(minMatch[1], 10) : (wordMap[minMatch[0].toLowerCase().split(/[-\s]/)[0]] || 1);
      extracted.duration = minutes * 60;
    }

    // 2. Aspect Ratio
    if (/\b(9:16|vertical|shorts?|reels?|tiktok)\b/i.test(text)) {
      extracted.aspectRatio = '9:16';
    } else if (/\b(1:1|square|instagram)\b/i.test(text)) {
      extracted.aspectRatio = '1:1';
    } else if (/\b(16:9|landscape|horizontal|standard|youtube)\b/i.test(text)) {
      extracted.aspectRatio = '16:9';
    }

    // 3. Resolution
    if (/\b(4k|2160p|3840x2160)\b/i.test(text)) {
      extracted.resolution = '4k';
    } else if (/\b(720p|1280x720|hd)\b/i.test(text) && !/\b(full\s*hd|1080p)\b/i.test(text)) {
      extracted.resolution = '720p';
    } else if (/\b(1080p|1920x1080|full\s*hd)\b/i.test(text)) {
      extracted.resolution = '1080p';
    }

    // 4. Frame Rate (fps)
    const fpsMatch = text.match(/\b(\d+)\s*fps\b/i);
    if (fpsMatch) {
      extracted.fps = parseInt(fpsMatch[1], 10);
    }

    // 5. Output Format
    if (/\b(h\.?264|mp4)\b/i.test(text)) {
      extracted.format = 'H.264 MP4';
    }

    // 6. Visual Style & Lighting
    const styleMatches = [];
    if (/\b(warm morning lighting|golden hour|cinematic lighting|volumetric lighting|natural lighting|dramatic lighting|soft lighting)\b/i.test(text)) {
      const match = text.match(/\b(warm morning lighting|golden hour|cinematic lighting|volumetric lighting|natural lighting|dramatic lighting|soft lighting)\b/i);
      styleMatches.push(match[1]);
    }
    if (/\b(cinematic visuals|photorealistic|documentary|35mm|film grain|anamorphic|hyper-detailed|8k|aerial view|drone shot)\b/i.test(text)) {
      const match = text.match(/\b(cinematic visuals|photorealistic|documentary|35mm|film grain|anamorphic|hyper-detailed|8k|aerial view|drone shot)\b/i);
      styleMatches.push(match[1]);
    }
    if (styleMatches.length > 0) {
      extracted.visualStyle = styleMatches.join(', ');
    }

    // 7. Narration Language & Voice
    const langMatch = text.match(/\b(tamil|english|spanish|hindi|french|german|japanese|mandarin|telugu|kannada|malayalam)\s+(?:narration|voiceover|voice|speech|audio)\b/i);
    if (langMatch) {
      extracted.narrationLanguage = langMatch[1].charAt(0).toUpperCase() + langMatch[1].slice(1).toLowerCase();
      extracted.narrationVoice = `${extracted.narrationLanguage} documentary narrator`;
    } else if (/\b(solemn|authoritative|calm|energetic|conversational|deep)\s+(?:narrator|voice)\b/i.test(text)) {
      const toneMatch = text.match(/\b(solemn|authoritative|calm|energetic|conversational|deep)\s+(?:narrator|voice)\b/i);
      extracted.narrationVoice = `${toneMatch[1]} narrator`;
    }

    // 8. Background Music & Sound Design
    const musicMatch = text.match(/\b([a-z\s]+)\s+(?:background music|bgm|soundtrack|score|soundscape|music)\b/i);
    if (musicMatch && musicMatch[1] && musicMatch[1].length < 40) {
      const mStyle = musicMatch[1].trim();
      if (!/^(and|with|the|use|play)$/i.test(mStyle)) {
        extracted.musicStyle = `${mStyle} music`;
      }
    } else if (/\b(cinematic background music|orchestral score|temple bells|ambient wind|soundtrack)\b/i.test(text)) {
      extracted.musicStyle = 'Cinematic background music with atmospheric sound design';
    }

    // 9. YouTube Publishing & Approval Policy
    if (/\b(upload it to my youtube channel after the configured approval requirements are met|after approval|require approval|approval required|human approval)\b/i.test(text)) {
      extracted.publishingPolicy = 'approval_required';
    } else if (/\b(auto publish|publish automatically|automatic publishing|automatic upload|upload immediately|pre-authorized)\b/i.test(text)) {
      extracted.publishingPolicy = 'pre_authorized';
    } else if (/\b(do not upload|local only|don't publish|save locally|draft only)\b/i.test(text)) {
      extracted.publishingPolicy = 'draft_only';
    } else if (/\b(upload to (?:my )?youtube)\b/i.test(text)) {
      extracted.publishingPolicy = 'approval_required';
    }

    // 10. Privacy/Visibility
    if (/\b(public)\b/i.test(text) && !/\b(not public|private|unlisted)\b/i.test(text)) {
      extracted.visibility = 'public';
    } else if (/\b(unlisted)\b/i.test(text)) {
      extracted.visibility = 'unlisted';
    } else if (/\b(private)\b/i.test(text)) {
      extracted.visibility = 'private';
    }

    return extracted;
  }

  /**
   * Applies the strict instruction precedence:
   * 1. Explicit user instructions
   * 2. Configured account/application policies
   * 3. Validated technical constraints
   * 4. Safe AI defaults
   */
  applyPrecedence(userExtracted, options = {}) {
    const policies = options.policies || {};

    let duration = userExtracted.duration ?? policies.defaultDuration ?? 30;
    if (policies.maxDuration && duration > policies.maxDuration) {
      duration = policies.maxDuration;
    }
    duration = Math.max(MIN_DURATION, Math.min(MAX_DURATION, duration));

    let aspectRatio = userExtracted.aspectRatio ?? policies.defaultAspectRatio ?? '16:9';
    if (!ALLOWED_ASPECT_RATIOS.includes(aspectRatio)) {
      aspectRatio = '16:9';
    }

    let resolution = userExtracted.resolution ?? policies.defaultResolution ?? '1080p';
    if (!ALLOWED_RESOLUTIONS.includes(resolution)) {
      resolution = '1080p';
    }

    let fps = userExtracted.fps ?? DEFAULT_FPS;
    if (fps !== 24 && fps !== 30 && fps !== 60) {
      fps = DEFAULT_FPS;
    }

    const format = 'H.264 MP4';

    let publishingPolicy = userExtracted.publishingPolicy ?? policies.defaultPublishingPolicy ?? 'approval_required';
    if (policies.enforceHumanApproval && publishingPolicy === 'pre_authorized') {
      publishingPolicy = 'approval_required';
    }

    let visibility = userExtracted.visibility ?? policies.defaultVisibility ?? 'private';

    return {
      duration,
      aspectRatio,
      resolution,
      fps,
      format,
      visualStyle: userExtracted.visualStyle || 'Cinematic, rich textures, volumetric natural lighting, 35mm film aesthetic',
      narrationLanguage: userExtracted.narrationLanguage || 'English',
      narrationVoice: userExtracted.narrationVoice || 'Solemn documentary narrator',
      musicStyle: userExtracted.musicStyle || 'Cinematic orchestral atmosphere',
      soundEffects: userExtracted.soundEffects || 'Subtle atmospheric environmental sound design',
      publishingPolicy,
      visibility,
      workflowId: options.workflowId || 'minimax_h3_turbo_local'
    };
  }

  detectConflicts(text, extracted, merged) {
    const conflicts = [];

    // 1. Multiple contradictory durations in same instruction
    const allDurations = [];
    const durSecRegex = /\b(\d+)\s*(?:-|\s*)?(?:seconds?|secs?|s)\b/gi;
    let dm;
    while ((dm = durSecRegex.exec(text)) !== null) {
      const sec = parseInt(dm[1], 10);
      if (!allDurations.includes(sec)) allDurations.push(sec);
    }
    if (allDurations.length > 1) {
      conflicts.push({
        field: 'duration',
        description: `Instruction specifies conflicting durations: ${allDurations.map(d => d + 's').join(' vs ')}.`,
        resolvedTo: allDurations[0],
        requiresClarification: true,
        blocking: true
      });
    }

    // 2. Multiple contradictory frame rates in same instruction
    const allFps = [];
    const fpsRegex = /\b(\d+)\s*fps\b/gi;
    let fm;
    while ((fm = fpsRegex.exec(text)) !== null) {
      const fpsVal = parseInt(fm[1], 10);
      if (!allFps.includes(fpsVal)) allFps.push(fpsVal);
    }
    if (allFps.length > 1) {
      conflicts.push({
        field: 'fps',
        description: `Instruction specifies conflicting frame rates: ${allFps.map(f => f + ' fps').join(' vs ')}.`,
        resolvedTo: allFps[0],
        requiresClarification: true,
        blocking: true
      });
    }

    // 3. Aspect ratio vs orientation keywords
    const has16x9 = /\b16:9\b/i.test(text);
    const hasVertical = /\b(vertical|shorts?|portrait)\b/i.test(text);
    if (has16x9 && hasVertical) {
      conflicts.push({
        field: 'aspectRatio',
        description: 'Instruction specifies "16:9" (landscape) and "vertical" (portrait/9:16) simultaneously.',
        resolvedTo: merged.aspectRatio,
        requiresClarification: true,
        blocking: false
      });
    }

    // 4. Duration out of bounds
    if (extracted.duration && (extracted.duration < MIN_DURATION || extracted.duration > MAX_DURATION)) {
      conflicts.push({
        field: 'duration',
        description: `Requested duration ${extracted.duration}s is outside technical limits (${MIN_DURATION}s - ${MAX_DURATION}s). Clamped to ${merged.duration}s.`,
        resolvedTo: merged.duration,
        requiresClarification: false,
        blocking: false
      });
    }

    // 5. Conflicting publishing instructions
    const mentionsAuto = /\b(auto publish|publish automatically|automatic publishing|automatic upload)\b/i.test(text);
    const mentionsApproval = /\b(approval required|after approval|require approval|human approval)\b/i.test(text);
    if (mentionsAuto && mentionsApproval) {
      conflicts.push({
        field: 'publishingPolicy',
        description: 'Instruction contains both automatic publishing and human approval requirements.',
        resolvedTo: 'approval_required',
        requiresClarification: true,
        blocking: false
      });
    }

    return conflicts;
  }

  generateSummaryText({ topics, batchMode, settings, conflicts }) {
    const isMulti = topics.length > 1;
    let summary = '';
    if (isMulti) {
      summary += `Batch Production (${topics.length} videos - ${batchMode === 'separate_videos' ? 'Separate Videos' : 'Combined Video'}):\n`;
      topics.forEach((t, i) => { summary += `  ${i + 1}. ${t}\n`; });
    } else {
      summary += `Single Video Production: "${topics[0]}"\n`;
    }
    summary += `Target: ${settings.duration}s @ ${settings.resolution} (${settings.aspectRatio}, ${settings.fps}fps ${settings.format})\n`;
    summary += `Audio: ${settings.narrationLanguage} narration (${settings.narrationVoice}) + ${settings.musicStyle}\n`;
    summary += `Publishing: ${settings.publishingPolicy === 'approval_required' ? 'Awaiting Human Approval' : (settings.publishingPolicy === 'pre_authorized' ? 'Pre-authorized Auto-Publish' : 'Local Draft Only')} (Visibility: ${settings.visibility})`;

    if (conflicts.length > 0) {
      summary += `\n⚠️ Note: ${conflicts.map(c => c.description).join('; ')}`;
    }
    return summary;
  }
}

module.exports = {
  InstructionInterpreter,
  ALLOWED_ASPECT_RATIOS,
  ALLOWED_RESOLUTIONS,
  DEFAULT_FPS
};
