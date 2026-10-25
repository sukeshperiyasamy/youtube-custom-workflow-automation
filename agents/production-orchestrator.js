const fs = require('fs');
const path = require('path');
const { Database } = require('../database/db');
const { Logger } = require('../utils/logger');
const { ComfyUIClient } = require('../utils/comfyui-client');
const { WorkflowRegistry } = require('../utils/workflow-registry');
const { AIPlanner, AIPlannerKeyMissingError } = require('../utils/ai-planner');
const { ProductionAssembler } = require('../utils/production-assembler');
const { InstructionInterpreter } = require('../utils/instruction-interpreter');
const { QualityGate } = require('../utils/quality-gate');

class ProductionOrchestrator {
  constructor(options = {}) {
    this.logger = new Logger('ProductionOrchestrator');
    this.db = options.db || new Database();
    this.comfyClient = options.comfyClient || new ComfyUIClient();
    this.workflowRegistry = options.workflowRegistry || new WorkflowRegistry();
    this.aiPlanner = options.aiPlanner || new AIPlanner();
    this.assembler = options.assembler || new ProductionAssembler();
    this.instructionInterpreter = options.instructionInterpreter || new InstructionInterpreter(options.credentials || {});
    this.qualityGate = options.qualityGate || new QualityGate();
    this.baseProductionsDir = path.resolve('data', 'productions');
    this.activeWorkers = new Set();
  }

  async initialize() {
    await this.db.initialize();
    fs.mkdirSync(this.baseProductionsDir, { recursive: true });
    // Audit for interrupted jobs from previous sessions
    await this.auditInterruptedJobs();
    return true;
  }

  async auditInterruptedJobs() {
    try {
      const rows = await this.db.getAllRows(
        "SELECT id, status, stage FROM generation_jobs WHERE status IN ('generating_scenes', 'assembling', 'running')"
      );
      if (rows && rows.length > 0) {
        this.logger.warn(`Found ${rows.length} interrupted job(s) from previous run. Marking as recoverable.`);
        for (const row of rows) {
          await this.db.updateGenerationJob(row.id, {
            status: 'interrupted',
            stage: 'interrupted_restart',
            error: 'Application restarted while job was in progress. Job can be resumed from last checkpoint.'
          });
        }
      }
    } catch (_err) {
      // Ignore during initial setup
    }
  }

  getJobDir(jobId) {
    return path.join(this.baseProductionsDir, jobId);
  }

  createJobDirectories(jobId) {
    const root = this.getJobDir(jobId);
    const subdirs = [
      'plan',
      'references',
      'scenes',
      'narration',
      'music',
      'subtitles',
      'thumbnails',
      'final',
      'reports'
    ];
    subdirs.forEach(sub => fs.mkdirSync(path.join(root, sub), { recursive: true }));
    return root;
  }

  /**
   * Primary Instruction Entrypoint:
   * Parses natural-language instructions, handles single & batch multi-topic submissions,
   * enforces instruction precedence and creates persistent production jobs.
   */
  async createJobFromInstruction(rawInstruction, options = {}) {
    const interpretation = await this.instructionInterpreter.interpret(rawInstruction, options);
    if (!interpretation.valid && interpretation.conflicts.some(c => c.blocking)) {
      throw new Error(`Instruction validation failed: ${interpretation.conflicts.map(c => c.description).join('; ')}`);
    }

    if (interpretation.isBatch && interpretation.batchMode === 'separate_videos') {
      // Create Batch Parent + Child Jobs
      const batchId = `batch-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const childJobs = [];

      for (let i = 0; i < interpretation.plans.length; i++) {
        const planItem = interpretation.plans[i];
        const childJob = await this.createJob({
          prompt: planItem.topic,
          duration: planItem.targetDuration,
          aspectRatio: planItem.aspectRatio,
          resolution: planItem.resolution,
          fps: planItem.fps,
          format: planItem.format,
          visualStyle: planItem.visualStyle,
          narrationVoice: planItem.narrationVoice,
          musicStyle: planItem.musicStyle,
          workflowId: planItem.workflowId,
          publishingPolicy: planItem.publishingPolicy,
          visibility: planItem.visibility,
          originalInstruction: rawInstruction,
          parentBatchId: batchId,
          batchIndex: i + 1,
          batchTotal: interpretation.plans.length
        });
        childJobs.push(childJob);
      }

      this.logger.success(`Created batch ${batchId} with ${childJobs.length} child production jobs.`);
      return {
        isBatch: true,
        batchId,
        childJobs,
        interpretation
      };
    }

    // Single Topic Submission
    const singlePlan = interpretation.plans[0];
    const job = await this.createJob({
      prompt: singlePlan.topic,
      duration: singlePlan.targetDuration,
      aspectRatio: singlePlan.aspectRatio,
      resolution: singlePlan.resolution,
      fps: singlePlan.fps,
      format: singlePlan.format,
      visualStyle: singlePlan.visualStyle,
      narrationVoice: singlePlan.narrationVoice,
      musicStyle: singlePlan.musicStyle,
      workflowId: singlePlan.workflowId,
      publishingPolicy: singlePlan.publishingPolicy,
      visibility: singlePlan.visibility,
      originalInstruction: rawInstruction
    });

    return {
      isBatch: false,
      job,
      interpretation
    };
  }

  async createDraftJob(promptOrParams, options = {}) {
    const params = typeof promptOrParams === 'string'
      ? { prompt: promptOrParams, ...options }
      : { ...promptOrParams, ...options };
    return this.createJob(params);
  }

  async createJob(params = {}) {
    const prompt = String(params.prompt || params.topic || '').trim();
    if (!prompt) {
      throw new Error('A prompt is required to create a production job.');
    }

    const jobId = `prod-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const jobDir = this.createJobDirectories(jobId);

    const targetDuration = Number(params.duration || params.targetDuration || 30);
    const aspectRatio = String(params.aspectRatio || '16:9').trim();
    const resolution = String(params.resolution || '1080p').trim();
    const format = String(params.format || 'cinematic').trim();
    const visualStyle = String(params.visualStyle || '35mm anamorphic film photography, natural lighting, rich textures').trim();
    const narrationVoice = String(params.narrationVoice || 'Solemn narrator').trim();
    const musicStyle = String(params.musicStyle || 'Cinematic orchestral atmosphere').trim();
    const audience = String(params.audience || 'General YouTube audience interested in high-quality visual experiences').trim();
    const workflowId = String(params.workflowId || 'minimax_h3_turbo_local').trim();
    const publishingPolicy = String(params.publishingPolicy || 'approval_required').trim();
    const visibility = String(params.visibility || 'private').trim();
    const originalInstruction = String(params.originalInstruction || prompt).trim();

    const details = {
      jobId,
      prompt,
      originalInstruction,
      targetDuration,
      aspectRatio,
      resolution,
      format,
      visualStyle,
      narrationVoice,
      musicStyle,
      audience,
      workflowId,
      publishingPolicy,
      visibility,
      parentBatchId: params.parentBatchId || null,
      batchIndex: params.batchIndex || null,
      batchTotal: params.batchTotal || null,
      outputDirectory: jobDir,
      plan: null,
      retries: 0,
      manifest: {
        jobId,
        createdAt: new Date().toISOString(),
        scenes: []
      }
    };

    // Save initial manifest
    fs.writeFileSync(
      path.join(jobDir, 'reports', 'generation_manifest.json'),
      JSON.stringify(details.manifest, null, 2),
      'utf8'
    );

    // Insert into database
    await this.db.executeQuery(
      `INSERT INTO generation_jobs (id, topic, style, length, source, status, stage, progress, details)
       VALUES (?, ?, ?, ?, ?, 'draft', 'submitted', 0, ?)`,
      [jobId, prompt, visualStyle, targetDuration > 45 ? 'long' : (targetDuration > 20 ? 'medium' : 'short'), 'prompt_studio', JSON.stringify(details)]
    );

    this.logger.info(`Created production job ${jobId} for prompt: "${prompt.substring(0, 50)}..."`);
    return this.db.getGenerationJob(jobId);
  }

  async planJob(jobId, options = {}) {
    const job = await this.db.getGenerationJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found.`);

    await this.db.updateGenerationJob(jobId, { status: 'planning', stage: 'script_and_storyboard', progress: 5 });
    const jobDir = this.getJobDir(jobId);

    try {
      const plan = await this.aiPlanner.createPlan(job.details, {
        allowTemplateFallback: options.allowTemplateFallback !== false
      });

      fs.writeFileSync(path.join(jobDir, 'plan', 'production_plan.json'), JSON.stringify(plan, null, 2), 'utf8');

      // Update scenes in SQLite
      await this.db.executeQuery('DELETE FROM production_scenes WHERE production_id = ?', [jobId]);
      for (const scene of plan.scenes) {
        await this.db.executeQuery(
          `INSERT INTO production_scenes (id, production_id, position, label, script_text, prompt, duration, asset_type, asset_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'video', '')`,
          [
            `${jobId}-${scene.scene_id}`,
            jobId,
            scene.index,
            scene.title,
            scene.narration_text || '',
            scene.visual_prompt,
            scene.duration_seconds
          ]
        );
      }

      await this.db.updateGenerationJob(jobId, {
        status: 'awaiting_generation',
        stage: 'plan_ready',
        progress: 10,
        title: plan.title,
        details: { plan }
      });

      this.logger.success(`Plan generated for job ${jobId} (${plan.scenes.length} scenes).`);
      return { success: true, plan };
    } catch (err) {
      if (err instanceof AIPlannerKeyMissingError) {
        await this.db.updateGenerationJob(jobId, {
          status: 'awaiting_provider',
          stage: 'provider_required',
          error: err.message
        });
        return { success: false, status: 'awaiting_provider', error: err.message };
      }
      await this.db.updateGenerationJob(jobId, {
        status: 'failed',
        stage: 'planning_failed',
        error: err.message
      });
      throw err;
    }
  }

  /**
   * Resumes an interrupted, paused, or failed job from its last safe checkpoint
   */
  async resumeJob(jobId, options = {}) {
    const job = await this.db.getGenerationJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found.`);

    this.logger.info(`Resuming job ${jobId} from last safe checkpoint...`);
    return this.startGeneration(jobId, { ...options, isResume: true });
  }

  async startGeneration(jobId, options = {}) {
    if (this.activeWorkers.has(jobId)) {
      throw new Error(`Job ${jobId} is already actively running.`);
    }

    const job = await this.db.getGenerationJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found.`);

    let plan = job.details?.plan;
    if (!plan) {
      const planRes = await this.planJob(jobId, { allowTemplateFallback: true });
      plan = planRes.plan;
    }

    this.activeWorkers.add(jobId);
    await this.db.updateGenerationJob(jobId, {
      status: 'generating_scenes',
      stage: 'scene_generation',
      progress: 10,
      cancelRequested: false
    });

    const jobDir = this.getJobDir(jobId);
    const scenesDir = path.join(jobDir, 'scenes');
    const manifestPath = path.join(jobDir, 'reports', 'generation_manifest.json');
    let manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { jobId, scenes: [] };

    try {
      const workflowId = job.details?.workflowId || 'minimax_h3_turbo_local';
      const workflow = this.workflowRegistry.get(workflowId);

      // Verify ComfyUI if local execution
      if (workflowId !== 'mock_test_workflow') {
        const check = await this.workflowRegistry.verifyWorkflow(workflowId, this.comfyClient);
        if (!check.comfyConnected) {
          throw new Error('ComfyUI server is not running on 127.0.0.1:8188. Start ComfyUI to proceed with generation.');
        }
        if (!check.available) {
          throw new Error(`Workflow verification failed: missing models (${check.missingModels.map(m=>m.file).join(', ')}) or nodes (${check.missingNodes.join(', ')})`);
        }
      }

      let prevTerminalComfyName = null;
      const totalScenes = plan.scenes.length;

      for (let i = 0; i < totalScenes; i++) {
        const scene = plan.scenes[i];
        const sceneIndex = i + 1;
        const sceneStr = String(sceneIndex).padStart(2, '0');

        // Check cancellation
        const currentJob = await this.db.getGenerationJob(jobId);
        if (currentJob?.cancelRequested) {
          this.logger.warn(`Job ${jobId} was cancelled by user.`);
          await this.db.updateGenerationJob(jobId, { status: 'cancelled', stage: 'cancelled', error: 'User cancelled job' });
          return { success: false, status: 'cancelled' };
        }

        const rawSegPath = path.join(scenesDir, `segment_${sceneStr}_raw.mp4`);
        const trimmedSegPath = path.join(scenesDir, `segment_${sceneStr}_trimmed.mp4`);
        const terminalFramePath = path.join(scenesDir, `segment_${sceneStr}_terminal.png`);

        // Checkpoint Check: if scene already exists, valid and not corrupted, reuse it!
        if (fs.existsSync(trimmedSegPath) && fs.statSync(trimmedSegPath).size > 50000) {
          this.logger.info(`Scene #${sceneIndex} already exists and verified (${fs.statSync(trimmedSegPath).size} bytes). Reusing.`);
          if (fs.existsSync(terminalFramePath)) {
            const comfyTermName = `${jobId}_term_${sceneStr}.png`;
            this.comfyClient.copyAssetToInput(terminalFramePath, comfyTermName);
            prevTerminalComfyName = comfyTermName;
          }
          continue;
        }

        this.logger.info(`--- Generating Scene ${sceneIndex}/${totalScenes}: "${scene.title}" ---`);
        await this.db.updateGenerationJob(jobId, {
          stage: `scene_generation_${sceneIndex}_of_${totalScenes}`,
          progress: Math.round(10 + (i / totalScenes) * 65)
        });

        // Determine conditioning frame
        let firstFrameName = null;
        if (scene.use_prev_terminal_frame && prevTerminalComfyName) {
          firstFrameName = prevTerminalComfyName;
          this.logger.info(`  Conditioning: Terminal frame of Scene ${sceneIndex - 1} (${firstFrameName})`);
        } else if (scene.reference_image && fs.existsSync(scene.reference_image)) {
          const anchorName = `${jobId}_anchor_${sceneStr}.png`;
          this.comfyClient.copyAssetToInput(scene.reference_image, anchorName);
          firstFrameName = anchorName;
          this.logger.info(`  Conditioning: Custom anchor image (${firstFrameName})`);
        }

        if (workflowId === 'mock_test_workflow') {
          // Synthetic test segment for regression testing
          this.logger.info(`  [Test Mode] Generating synthetic test segment for Scene ${sceneIndex}...`);
          const ffmpeg = require('../utils/ffmpeg').getFFmpegPath();
          const { execFile } = require('child_process');
          const { promisify } = require('util');
          await promisify(execFile)(ffmpeg, [
            '-y',
            '-f', 'lavfi', '-i', `color=c=navy:s=864x480:d=5.16:r=24`,
            '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo`,
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-shortest',
            rawSegPath
          ]);
        } else {
          // Live ComfyUI local inference with bounded retry
          let sceneAttempts = 0;
          const maxSceneAttempts = 2;
          let sceneGenerated = false;

          while (sceneAttempts < maxSceneAttempts && !sceneGenerated) {
            sceneAttempts++;
            try {
              await this.comfyClient.freeMemory();

              const prefix = `youtube_auto/${jobId}/segment_${sceneStr}`;
              const seed = Math.floor(Math.random() * 1000000000);
              const clipFrames = options.clipFrames || (scene.frames ? scene.frames + 4 : 124);

              const promptDict = workflow.buildPrompt({
                prompt: scene.visual_prompt,
                prefix,
                length: clipFrames,
                firstFrameName,
                seed,
                aspectRatio: plan.aspect_ratio || '16:9'
              });

              const queueRes = await this.comfyClient.queuePrompt(promptDict, `producer_${jobId}_scene_${sceneStr}`);
              const promptId = queueRes.prompt_id;
              this.logger.info(`  Submitted to ComfyUI (Prompt ID: ${promptId}, Attempt: ${sceneAttempts}). Waiting for inference...`);

              const waitRes = await this.comfyClient.waitForPrompt(promptId, {
                shouldCancel: () => {
                  const liveJob = this.db.getRowSync?.('SELECT cancel_requested FROM generation_jobs WHERE id = ?', [jobId]);
                  return Boolean(liveJob?.cancel_requested);
                },
                onProgress: (p) => {
                  this.logger.info(`  Scene ${sceneIndex} progress: ${p.elapsedSec}s elapsed (executing: ${p.isExecuting})`);
                }
              });

              let generatedFile = null;
              const outputInfo = waitRes.outputs?.['92']?.images?.[0];
              if (outputInfo && outputInfo.filename) {
                const exactPath = path.join(this.comfyClient.comfyOutputDir, outputInfo.subfolder || '', outputInfo.filename);
                if (fs.existsSync(exactPath)) {
                  generatedFile = exactPath;
                }
              }
              if (!generatedFile) {
                const candidates = this.comfyClient.findOutputFiles(`segment_${sceneStr}`);
                if (candidates && candidates.length > 0) {
                  generatedFile = candidates[0];
                }
              }
              if (!generatedFile || !fs.existsSync(generatedFile)) {
                throw new Error(`ComfyUI completed but output video for scene ${sceneIndex} was not found on disk.`);
              }
              this.logger.info(`  Located generated scene video: ${generatedFile} (${fs.statSync(generatedFile).size} bytes)`);
              fs.copyFileSync(generatedFile, rawSegPath);
              sceneGenerated = true;
            } catch (sceneErr) {
              this.logger.warn(`Scene ${sceneIndex} attempt ${sceneAttempts} failed: ${sceneErr.message}`);
              if (sceneAttempts >= maxSceneAttempts) throw sceneErr;
              await new Promise(r => setTimeout(r, 1500));
            }
          }
        }

        const finalTrimFrames = options.clipFrames ? options.clipFrames : (scene.frames || 120);
        await this.assembler.trimSceneToExactDuration(rawSegPath, trimmedSegPath, 24, finalTrimFrames);

        // Extract terminal frame for chaining next scene
        await this.assembler.extractTerminalFrame(trimmedSegPath, terminalFramePath, finalTrimFrames - 1);
        if (workflowId !== 'mock_test_workflow') {
          const comfyTermName = `${jobId}_term_${sceneStr}.png`;
          this.comfyClient.copyAssetToInput(terminalFramePath, comfyTermName);
          prevTerminalComfyName = comfyTermName;
        }

        manifest.scenes.push({
          sceneIndex,
          sceneId: scene.scene_id,
          title: scene.title,
          rawPath: rawSegPath,
          trimmedPath: trimmedSegPath,
          terminalFrame: terminalFramePath,
          duration: scene.duration_seconds
        });
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

        await this.db.executeQuery(
          'UPDATE production_scenes SET asset_path = ? WHERE id = ?',
          [trimmedSegPath, `${jobId}-${scene.scene_id}`]
        );
      }

      // Step 2: Assemble master video & enforce Quality Gate
      const assembleRes = await this.assembleJob(jobId, options);
      return { success: true, jobId, ...assembleRes };
    } catch (err) {
      this.logger.error(`Generation error for job ${jobId}: ${err.message}`);
      await this.db.updateGenerationJob(jobId, { status: 'failed', error: err.message });
      throw err;
    } finally {
      this.activeWorkers.delete(jobId);
    }
  }

  async assembleJob(jobId, options = {}) {
    this.logger.info(`Assembling final master video for job ${jobId}...`);
    await this.db.updateGenerationJob(jobId, { status: 'assembling', stage: 'video_assembly', progress: 80 });

    const jobDir = this.getJobDir(jobId);
    const scenesDir = path.join(jobDir, 'scenes');
    const finalDir = path.join(jobDir, 'final');
    const thumbnailsDir = path.join(jobDir, 'thumbnails');
    const masterFinalPath = path.join(finalDir, 'master_final.mp4');
    const thumbnailPath = path.join(thumbnailsDir, 'thumbnail_default.jpg');

    const job = await this.db.getGenerationJob(jobId);
    const plan = job.details?.plan;

    // Collect all trimmed scenes
    const sceneFiles = fs.readdirSync(scenesDir)
      .filter(f => f.endsWith('_trimmed.mp4'))
      .sort()
      .map(f => path.join(scenesDir, f));

    if (sceneFiles.length === 0) {
      throw new Error(`No trimmed scenes found in ${scenesDir} to assemble.`);
    }

    const resolution = plan?.aspect_ratio === '9:16'
      ? { width: 1080, height: 1920 }
      : (plan?.aspect_ratio === '1:1' ? { width: 1080, height: 1080 } : { width: 1920, height: 1080 });

    const narrationPath = job.details?.narrationAudioPath || path.join(jobDir, 'narration', 'narration.mp3');
    const musicPath = job.details?.backgroundMusicPath || path.join(jobDir, 'music', 'soundscape.mp3');

    const assembleRes = await this.assembler.assembleMasterVideo({
      sceneVideos: sceneFiles,
      outputFinalPath: masterFinalPath,
      narrationAudioPath: fs.existsSync(narrationPath) ? narrationPath : null,
      backgroundMusicPath: fs.existsSync(musicPath) ? musicPath : null,
      resolution,
      aspectRatio: plan?.aspect_ratio || '16:9'
    });

    // Extract default thumbnail from master video at 2 seconds
    await this.assembler.extractThumbnail(masterFinalPath, thumbnailPath, 2.0);

    // Step 3: Comprehensive Quality Gate Evaluation
    await this.db.updateGenerationJob(jobId, { status: 'validating', stage: 'quality_validation', progress: 95 });
    const probe = assembleRes.probe;

    const targetDuration = plan?.target_duration_seconds || job.details?.targetDuration || 30;
    const qualityEval = this.qualityGate.evaluateMasterProduction({
      probe,
      targetDuration,
      aspectRatio: plan?.aspect_ratio || job.details?.aspectRatio || '16:9',
      resolution: job.details?.resolution || '1080p',
      fps: job.details?.fps || 24,
      totalScenes: plan?.scenes?.length || 1,
      completedScenes: sceneFiles.length,
      hasAudioExpected: true,
      intentionalSilence: Boolean(job.details?.silentOverride),
      silenceReason: job.details?.silenceReason
    });

    const productionId = jobId;
    const defaultPrivacy = job.details?.visibility || process.env.DEFAULT_PRIVACY_STATUS || 'private';

    const assets = {
      video: { path: masterFinalPath, duration: probe.duration, width: probe.width, height: probe.height },
      thumbnail: { path: thumbnailPath },
      audio: {
        path: masterFinalPath,
        intentionalSilence: Boolean(job.details?.silentOverride),
        silenceReason: job.details?.silenceReason || 'Native cinematic sound design and mixed score embedded in master video',
        silenceConfirmedAt: new Date().toISOString()
      }
    };

    // 1. productions
    await this.db.executeQuery(
      `INSERT INTO productions (id, status, assets, scheduled_publish_time)
       VALUES (?, ?, ?, datetime('now', '+1 hour'))
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, assets = excluded.assets`,
      [productionId, qualityEval.passed ? 'completed' : 'failed', JSON.stringify(assets)]
    );

    // 2. production_snapshots
    await this.db.executeQuery(
      `INSERT INTO production_snapshots (production_id, strategy, script, thumbnail, seo)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(production_id) DO UPDATE SET strategy = excluded.strategy, script = excluded.script, thumbnail = excluded.thumbnail, seo = excluded.seo`,
      [
        productionId,
        JSON.stringify({ topic: job.topic, format: job.details?.format }),
        JSON.stringify({ title: plan?.title || job.title, scenes: plan?.scenes }),
        JSON.stringify({ path: thumbnailPath, concept: plan?.youtube_metadata?.thumbnail_concept }),
        JSON.stringify(plan?.youtube_metadata || {})
      ]
    );

    // 3. content_reviews
    await this.db.executeQuery(
      `INSERT INTO content_reviews (production_id, status, editor_data, quality_checks, reviewed_at)
       VALUES (?, 'needs_review', ?, ?, datetime('now'))
       ON CONFLICT(production_id) DO UPDATE SET status = 'needs_review', editor_data = excluded.editor_data, quality_checks = excluded.quality_checks`,
      [
        productionId,
        JSON.stringify(plan?.youtube_metadata || {}),
        JSON.stringify(qualityEval.checks)
      ]
    );

    // 4. publish_schedule
    await this.db.executeQuery(
      `INSERT INTO publish_schedule (id, production_id, title, publish_time, status, priority, metadata)
       VALUES (?, ?, ?, datetime('now', '+1 hour'), 'scheduled', 50, ?)
       ON CONFLICT(id) DO UPDATE SET status = 'scheduled', metadata = excluded.metadata`,
      [
        `sched-${jobId}`,
        productionId,
        plan?.youtube_metadata?.title || job.title,
        JSON.stringify({
          privacyStatus: defaultPrivacy,
          video: { path: masterFinalPath },
          thumbnail: { path: thumbnailPath },
          audio: assets.audio,
          seo: plan?.youtube_metadata
        })
      ]
    );

    // Check Quality Gate Result
    if (!qualityEval.passed) {
      const blockingMsg = `Quality Gate failed: ${qualityEval.blockingFailures.join(', ')}`;
      this.logger.error(`Job ${jobId} failed Quality Gate: ${blockingMsg}`);
      await this.db.updateGenerationJob(jobId, {
        status: 'failed',
        stage: 'quality_gate_failed',
        progress: 95,
        error: blockingMsg,
        details: {
          masterVideoPath: masterFinalPath,
          thumbnailPath,
          probe,
          qualityEval
        }
      });
      throw new Error(blockingMsg);
    }

    // Step 4: Publish Policy Enforcement
    const publishingPolicy = job.details?.publishingPolicy || this.publishingPolicy;

    if (publishingPolicy === 'pre_authorized' && options.publishingAgent) {
      this.logger.info(`Pre-authorized auto-publish enabled for job ${jobId}. Submitting to YouTube...`);
      return this.approveAndPublish(jobId, options.publishingAgent);
    }

    // Default safety: Awaiting Human Approval
    await this.db.updateGenerationJob(jobId, {
      status: 'awaiting_approval',
      stage: 'ready_for_review',
      progress: 100,
      productionId: jobId,
      title: plan?.youtube_metadata?.title || job.title,
      details: {
        masterVideoPath: masterFinalPath,
        thumbnailPath,
        probe,
        qualityEval
      }
    });

    this.logger.success(`Job ${jobId} successfully prepared for YouTube review! Master: ${masterFinalPath}`);
    return {
      success: true,
      jobId,
      status: 'awaiting_approval',
      masterFinalPath,
      thumbnailPath,
      probe,
      qualityScore: qualityEval.score
    };
  }

  async approveAndPublish(jobId, publishingAgent, confirmations = {}) {
    if (!publishingAgent) {
      throw new Error('PublishingAgent instance is required for YouTube upload.');
    }
    const job = await this.db.getGenerationJob(jobId);
    if (!job) {
      const err = new Error(`Job ${jobId} not found.`);
      err.status = 404;
      throw err;
    }

    // Duplicate upload protection
    if (job.status === 'uploaded' && job.details?.youtubeUrl) {
      this.logger.info(`Job ${jobId} has already been uploaded to YouTube: ${job.details.youtubeUrl}. Preventing duplicate upload.`);
      return { success: true, alreadyPublished: true, youtubeUrl: job.details.youtubeUrl };
    }

    if (job.status !== 'awaiting_approval' && job.status !== 'validating') {
      const err = new Error(`Cannot approve job in status '${job.status}'. Expected 'awaiting_approval'.`);
      err.status = 409;
      throw err;
    }

    // Rights confirmation safeguard
    if (confirmations.confirmRights === false) {
      const err = new Error('Confirm the factual review and media rights checks before approval.');
      err.status = 409;
      throw err;
    }

    // Quality gate validation safeguard
    let quality = job.details?.qualityEval;
    if (!quality && this.db.getProductionBundle) {
      try {
        const bundle = await this.db.getProductionBundle(jobId);
        if (bundle && (bundle.qualityChecks || bundle.quality_checks)) {
          const checks = Array.isArray(bundle.qualityChecks) ? bundle.qualityChecks : (Array.isArray(bundle.quality_checks) ? bundle.quality_checks : []);
          const blockingFailures = checks.filter(c => !c.passed && c.blocking).map(c => c.id || c.name);
          const score = checks.length > 0 ? Math.round((checks.filter(c => c.passed).length / checks.length) * 100) : 0;
          quality = {
            passed: blockingFailures.length === 0 && score >= 80,
            score,
            blockingFailures,
            checks
          };
        }
      } catch (e) {
        // Fallback silently to checking job.details
      }
    }
    if (!quality && job.details?.qualityChecks) {
      const checks = Array.isArray(job.details.qualityChecks) ? job.details.qualityChecks : [];
      const blockingFailures = checks.filter(c => !c.passed && c.blocking).map(c => c.id || c.name);
      const score = checks.length > 0 ? Math.round((checks.filter(c => c.passed).length / checks.length) * 100) : (job.details.qualityScore || 0);
      quality = {
        passed: blockingFailures.length === 0 && score >= 80,
        score,
        blockingFailures,
        checks
      };
    }

    if (!quality) {
      const err = new Error('Quality gate evaluation missing. Verification required before publication.');
      err.status = 409;
      throw err;
    }
    if (!quality.passed || quality.blockingFailures?.length > 0) {
      const failures = quality.blockingFailures?.join(', ') || 'quality checks failed';
      const err = new Error(`Cannot publish job with blocking quality failures: ${failures}`);
      err.status = 409;
      throw err;
    }

    this.logger.info(`User approved publication for job ${jobId}. Submitting to YouTube publishing pipeline...`);
    await this.db.updateGenerationJob(jobId, { status: 'uploading', stage: 'uploading_to_youtube' });

    // Mark review approved
    await this.db.executeQuery(
      `UPDATE content_reviews SET status = 'approved', reviewed_at = datetime('now') WHERE production_id = ?`,
      [jobId]
    );

    try {
      const publishResult = await publishingAgent.publishContent(jobId, { publishNow: true });
      await this.db.updateGenerationJob(jobId, {
        status: 'uploaded',
        stage: 'upload_verified',
        details: {
          youtubeId: publishResult.youtubeId,
          youtubeUrl: publishResult.youtubeUrl,
          publishedAt: publishResult.publishedAt
        }
      });
      this.logger.success(`Job ${jobId} successfully published to YouTube! URL: ${publishResult.youtubeUrl}`);
      return { success: true, publishResult };
    } catch (err) {
      this.logger.error(`YouTube upload failed for job ${jobId}: ${err.message}`);
      await this.db.updateGenerationJob(jobId, {
        status: 'failed',
        stage: 'upload_failed',
        error: err.message
      });
      throw err;
    }
  }

  async cancelJob(jobId) {
    const job = await this.db.getGenerationJob(jobId);
    if (!job) {
      const err = new Error(`Job ${jobId} not found.`);
      err.status = 404;
      throw err;
    }

    if (['completed', 'uploaded'].includes(job.status)) {
      const err = new Error(`Cannot cancel job in '${job.status}' status.`);
      err.status = 409;
      throw err;
    }

    if (job.status === 'cancelled') {
      return { success: true, jobId, status: 'cancelled', alreadyCancelled: true };
    }

    await this.db.updateGenerationJob(jobId, {
      cancelRequested: true,
      status: 'cancelled',
      stage: 'cancelled',
      error: 'Cancelled by user'
    });
    this.activeWorkers.delete(jobId);
    await this.comfyClient.cancelPrompt();
    return { success: true, jobId, status: 'cancelled' };
  }
}

module.exports = { ProductionOrchestrator };
