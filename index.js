/**
 * YouTube Custom Workflow Automation
 * 
 * Standalone orchestration layer for AI video production, ComfyUI generation coordination,
 * quality gate verification, and YouTube publishing safeguards.
 */

const express = require('express');
const path = require('path');
const { ProductionOrchestrator } = require('./agents/production-orchestrator');
const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
const { InstructionInterpreter } = require('./utils/instruction-interpreter');
const { WorkflowRegistry } = require('./utils/workflow-registry');
const { ComfyUIClient } = require('./utils/comfyui-client');
const { AIPlanner } = require('./utils/ai-planner');
const { ProductionAssembler } = require('./utils/production-assembler');
const { QualityGate } = require('./utils/quality-gate');
const { QualityNormalizer } = require('./utils/quality-normalizer');
const { Logger } = require('./utils/logger');
const { Database } = require('./database/db');
const { YouTubeAuthService } = require('./utils/youtube-auth-service');

const logger = new Logger('CustomWorkflowEngine');

class WorkflowEngine {
  constructor(options = {}) {
    this.db = options.db || new Database();
    this.comfyClient = options.comfyClient || new ComfyUIClient(options.comfyUrl || process.env.COMFYUI_URL || 'http://127.0.0.1:8188');
    this.workflowRegistry = options.workflowRegistry || new WorkflowRegistry();
    this.aiPlanner = options.aiPlanner || new AIPlanner();
    this.assembler = options.assembler || new ProductionAssembler();
    this.interpreter = options.interpreter || new InstructionInterpreter(options.credentials || {});
    this.qualityGate = options.qualityGate || new QualityGate();
    this.youtubeAuth = options.youtubeAuth || new YouTubeAuthService(options.youtubeConfig || {});
    this.publishingAgent = options.publishingAgent || new PublishingSchedulingAgent(this.db, this.youtubeAuth);

    this.orchestrator = new ProductionOrchestrator({
      db: this.db,
      comfyClient: this.comfyClient,
      workflowRegistry: this.workflowRegistry,
      aiPlanner: this.aiPlanner,
      assembler: this.assembler,
      instructionInterpreter: this.interpreter,
      qualityGate: this.qualityGate
    });
  }

  async initialize() {
    await this.db.initialize();
    await this.youtubeAuth.initialize();
    await this.orchestrator.initialize();
    logger.info('YouTube Custom Workflow Automation Engine initialized successfully.');
    return true;
  }

  createApiServer(port = process.env.PORT || 3456) {
    const app = express();
    app.use(express.json());

    // Health
    app.get('/health', async (req, res) => {
      const comfyHealthy = await this.comfyClient.checkHealth();
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        comfyConnected: comfyHealthy
      });
    });

    // Workflow Status
    app.get('/api/workflow/status', async (req, res) => {
      try {
        let stats = null;
        try {
          stats = await this.comfyClient.getSystemStats();
        } catch (_comfyErr) {
          stats = null;
        }
        res.json({
          success: true,
          comfyConnected: Boolean(stats),
          vram: stats?.devices?.[0] || null,
          workflows: this.workflowRegistry.listWorkflows()
        });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Instruction Interpretation
    app.post('/api/workflow/interpret', async (req, res) => {
      try {
        const { text } = req.body;
        const result = await this.interpreter.interpret(text);
        res.json({ success: true, result });
      } catch (err) {
        res.status(400).json({ success: false, error: err.message });
      }
    });

    // Plan Creation
    app.post('/api/workflow/plan', async (req, res) => {
      try {
        const { topic, duration, workflowId } = req.body;
        const plan = await this.aiPlanner.generateProductionPlan(topic, { duration, workflowId });
        res.json({ success: true, plan });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Job Creation
    app.post('/api/workflow/jobs', async (req, res) => {
      try {
        const { prompt, workflowId, autoStart } = req.body;
        const job = await this.orchestrator.createDraftJob(prompt, { workflowId, autoStart: Boolean(autoStart) });
        res.status(201).json({ success: true, job });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Job Retrieval
    app.get('/api/workflow/jobs/:id', async (req, res) => {
      try {
        const job = await this.db.getGenerationJob(req.params.id);
        if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
        res.json({ success: true, job });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Job Cancellation
    app.post('/api/workflow/jobs/:id/cancel', async (req, res) => {
      try {
        const result = await this.orchestrator.cancelJob(req.params.id);
        res.json(result);
      } catch (err) {
        res.status(err.status || 500).json({ success: false, error: err.message });
      }
    });

    // Job Approval & Publishing Safeguard Gate
    app.post('/api/workflow/jobs/:id/approve', async (req, res) => {
      try {
        const { confirmRights, publishingAgent } = req.body || {};
        const agent = publishingAgent || this.publishingAgent;
        const result = await this.orchestrator.approveAndPublish(req.params.id, agent, { confirmRights });
        res.json(result);
      } catch (err) {
        res.status(err.status || 500).json({ success: false, error: err.message });
      }
    });

    // YouTube Channel Connection & OAuth 2.0 Endpoints
    app.get('/api/youtube/auth-url', (req, res) => {
      try {
        const urlData = this.youtubeAuth.generateAuthUrl();
        res.json({ success: true, ...urlData });
      } catch (err) {
        res.status(err.status || 500).json({ success: false, error: err.message, code: err.code });
      }
    });

    app.get('/api/youtube/oauth2callback', async (req, res) => {
      const { code, state, error } = req.query;
      if (error) {
        return res.status(400).send(`
          <!DOCTYPE html>
          <html>
            <head><title>YouTube Authorization Failed</title></head>
            <body style="font-family:system-ui,sans-serif;padding:40px;background:#18181b;color:#f4f4f5;">
              <h2 style="color:#ef4444;">Authorization Rejected or Cancelled</h2>
              <p>Google reported: <code>${error}</code></p>
              <p>You can close this tab and return to the application.</p>
            </body>
          </html>
        `);
      }
      try {
        const result = await this.youtubeAuth.handleCallback(code, state);
        await this.publishingAgent.setupYouTubeAPI();
        res.send(`
          <!DOCTYPE html>
          <html>
            <head><title>YouTube Channel Connected</title></head>
            <body style="font-family:system-ui,sans-serif;padding:40px;background:#18181b;color:#f4f4f5;">
              <h2 style="color:#22c55e;">YouTube Channel Connected Successfully!</h2>
              <p>Your channel is now authorized for approved video uploads.</p>
              <p>You may now close this window and return to the application.</p>
            </body>
          </html>
        `);
      } catch (err) {
        res.status(err.status || 400).send(`
          <!DOCTYPE html>
          <html>
            <head><title>OAuth Callback Error</title></head>
            <body style="font-family:system-ui,sans-serif;padding:40px;background:#18181b;color:#f4f4f5;">
              <h2 style="color:#ef4444;">Authentication Error</h2>
              <p>${err.message}</p>
            </body>
          </html>
        `);
      }
    });

    app.get('/api/youtube/status', async (req, res) => {
      try {
        const status = await this.youtubeAuth.getChannelStatus();
        res.json({ success: true, ...status });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    app.post('/api/youtube/disconnect', async (req, res) => {
      try {
        const result = await this.youtubeAuth.disconnect();
        await this.publishingAgent.setupYouTubeAPI();
        res.json({ success: true, ...result });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    return app;
  }
}

// Module exports
module.exports = {
  WorkflowEngine,
  ProductionOrchestrator,
  PublishingSchedulingAgent,
  InstructionInterpreter,
  WorkflowRegistry,
  ComfyUIClient,
  AIPlanner,
  ProductionAssembler,
  QualityGate,
  QualityNormalizer,
  Logger,
  Database,
  YouTubeAuthService
};

// Start standalone server if run directly
if (require.main === module) {
  (async () => {
    const engine = new WorkflowEngine();
    await engine.initialize();
    const port = process.env.PORT || 3456;
    const app = engine.createApiServer(port);
    app.listen(port, () => {
      logger.info(`YouTube Custom Workflow Server running on port ${port}`);
    });
  })().catch(err => {
    logger.error(`Fatal startup error: ${err.message}`);
    process.exit(1);
  });
}
