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
    this.publishingAgent = options.publishingAgent || new PublishingSchedulingAgent(this.db, options.credentials || {});

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
        const stats = await this.comfyClient.getSystemStats();
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
  Database
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
