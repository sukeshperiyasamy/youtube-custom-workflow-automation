/**
 * YouTube Custom Workflow Automation - Studio & Workflow Engine Test Suite
 */

const assert = require('assert');
const { WorkflowRegistry } = require('../utils/workflow-registry');
const { AIPlanner } = require('../utils/ai-planner');
const { ComfyUIClient } = require('../utils/comfyui-client');

async function run() {
  console.log('════════════════════════════════════════════════════════════');
  console.log('🧪 TEST: WORKFLOW REGISTRY & STUDIO INTEGRATION');
  console.log('════════════════════════════════════════════════════════════\n');

  let passed = 0;
  let failed = 0;

  async function check(name, fn) {
    try {
      await fn();
      console.log(`  • ${name.padEnd(65)} ... ✅ PASSED`);
      passed++;
    } catch (err) {
      console.error(`  • ${name.padEnd(65)} ... ❌ FAILED`);
      console.error(`    ${err.message}`);
      failed++;
    }
  }

  // 1. Workflow Selection & Verification
  await check('Registry retrieves verified MiniMax H3 workflow', () => {
    const reg = new WorkflowRegistry();
    const wf = reg.get('minimax_h3_turbo_local');
    assert.ok(wf, 'MiniMax H3 workflow should be present');
    assert.strictEqual(wf.id, 'minimax_h3_turbo_local');
    assert.strictEqual(wf.defaultFps, 24);
    assert.ok(wf.requiredNodes.includes('MiniMaxH3ImageToVideo'));
    assert.ok(wf.requiredNodes.includes('ResolutionSelector'));
  });

  await check('Registry retrieves mock test workflow for isolated testing', () => {
    const reg = new WorkflowRegistry();
    const wf = reg.get('mock_test_workflow');
    assert.ok(wf);
    assert.strictEqual(wf.id, 'mock_test_workflow');
    assert.strictEqual(wf.vramRequiredGb, 0);
  });

  await check('Registry throws descriptive error for unknown workflow ID', () => {
    const reg = new WorkflowRegistry();
    assert.throws(() => {
      reg.get('nonexistent_workflow_id');
    }, /not found in registry/);
  });

  // 2. Production Plan Generation
  await check('AIPlanner validates generated production plan schema', async () => {
    const planner = new AIPlanner();
    const plan = await planner.createPlan({ prompt: 'Documentary on ancient monuments', duration: 10 });
    const validation = planner.validatePlanSchema(plan);
    assert.strictEqual(validation.valid, true);
    assert.strictEqual(validation.errors.length, 0);
  });

  await check('AIPlanner generates deterministic multi-scene plan when API key missing', async () => {
    const planner = new AIPlanner();
    const plan = await planner.createPlan({ prompt: 'Ancient temple at sunrise', duration: 15 });
    assert.ok(plan.title.includes('Ancient temple'));
    assert.ok(Array.isArray(plan.scenes));
    assert.strictEqual(plan.scenes.length, 3);
    assert.strictEqual(plan.scenes[0].use_prev_terminal_frame, false);
    assert.strictEqual(plan.scenes[1].use_prev_terminal_frame, true);
  });

  // 3. ComfyUI Client
  await check('ComfyUIClient correctly checks availability via isAvailable()', async () => {
    const client = new ComfyUIClient('http://127.0.0.1:8188');
    const available = await client.isAvailable();
    assert.strictEqual(typeof available, 'boolean');
  });

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`📊 Studio Test Results: ${passed} passed, ${failed} failed`);
  console.log('════════════════════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
