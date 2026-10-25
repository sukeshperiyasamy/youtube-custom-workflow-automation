/**
 * YouTube Custom Workflow Automation - REST API Integration Test Suite
 */

const assert = require('assert');
const http = require('http');
const { WorkflowEngine } = require('../index');

function makeRequest(port, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      port,
      method,
      path,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch (_) {
          resolve({ status: res.statusCode, data: raw });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  console.log('════════════════════════════════════════════════════════════');
  console.log('🧪 TEST: REST API ROUTES & ORCHESTRATION SERVER');
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

  const engine = new WorkflowEngine();
  await engine.initialize();
  const testPort = 3995;
  const app = engine.createApiServer(testPort);

  const server = await new Promise(resolve => {
    const s = app.listen(testPort, () => resolve(s));
  });

  try {
    let testJobId = null;

    // 1. GET /health
    await check('GET /health returns healthy status and ComfyUI connectivity', async () => {
      const res = await makeRequest(testPort, 'GET', '/health');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.status, 'healthy');
      assert.strictEqual(typeof res.data.comfyConnected, 'boolean');
    });

    // 2. GET /api/workflow/status
    await check('GET /api/workflow/status returns workflow list & hardware metrics', async () => {
      const res = await makeRequest(testPort, 'GET', '/api/workflow/status');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.success, true);
      assert.ok(Array.isArray(res.data.workflows));
      assert.ok(res.data.workflows.length >= 2);
    });

    // 3. POST /api/workflow/interpret
    await check('POST /api/workflow/interpret parses instructions & settings', async () => {
      const res = await makeRequest(testPort, 'POST', '/api/workflow/interpret', {
        text: 'Create a 15-second cinematic video of an ancient Dravidian temple in 1080p'
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.success, true);
      assert.ok(res.data.result.topics.length >= 1);
      assert.strictEqual(res.data.result.settings.duration, 15);
      assert.strictEqual(res.data.result.settings.resolution, '1080p');
    });

    // 4. POST /api/workflow/plan
    await check('POST /api/workflow/plan produces structured multi-scene breakdown', async () => {
      const res = await makeRequest(testPort, 'POST', '/api/workflow/plan', {
        topic: 'Ancient Dravidian temple at sunrise',
        duration: 10
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.success, true);
      assert.ok(res.data.plan.title);
      assert.strictEqual(res.data.plan.scenes.length, 2);
    });

    // 5. POST /api/workflow/jobs
    await check('POST /api/workflow/jobs creates persistent draft production job', async () => {
      const res = await makeRequest(testPort, 'POST', '/api/workflow/jobs', {
        prompt: 'API Integration Test Video',
        workflowId: 'mock_test_workflow'
      });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.data.success, true);
      assert.ok(res.data.job.id);
      assert.strictEqual(res.data.job.status, 'draft');
      testJobId = res.data.job.id;
    });

    // 6. GET /api/workflow/jobs/:id
    await check('GET /api/workflow/jobs/:id retrieves the created job details', async () => {
      assert.ok(testJobId, 'Job ID must be set');
      const res = await makeRequest(testPort, 'GET', `/api/workflow/jobs/${testJobId}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.success, true);
      assert.strictEqual(res.data.job.id, testJobId);
    });

    // 7. POST /api/workflow/jobs/:id/cancel
    await check('POST /api/workflow/jobs/:id/cancel transitions job to cancelled', async () => {
      assert.ok(testJobId, 'Job ID must be set');
      const res = await makeRequest(testPort, 'POST', `/api/workflow/jobs/${testJobId}/cancel`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.success, true);
      assert.strictEqual(res.data.status, 'cancelled');
    });

    // 8. POST /api/workflow/jobs/:id/approve
    await check('POST /api/workflow/jobs/:id/approve rejects cancelled job with 409', async () => {
      assert.ok(testJobId, 'Job ID must be set');
      const res = await makeRequest(testPort, 'POST', `/api/workflow/jobs/${testJobId}/approve`, {
        confirmRights: false
      });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.data.success, false);
      assert.ok(res.data.error.includes('Cannot approve job in status'));
    });

  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  console.log(`\n════════════════════════════════════════════════════════════`);
  console.log(`📊 API Test Results: ${passed} passed, ${failed} failed`);
  console.log(`════════════════════════════════════════════════════════════\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  run().catch(err => {
    console.error('Fatal test runner error:', err);
    process.exit(1);
  });
}

module.exports = { run };
