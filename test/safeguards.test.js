/**
 * YouTube Custom Workflow Automation - Safeguards & Invariants Test Suite
 * 
 * Verifies critical publishing safeguards, cancellation invariants, state transitions,
 * and error boundaries using isolated mocks, stubs, and deterministic fixtures.
 * ZERO live network calls, ZERO live YouTube publishing, ZERO production DB modification.
 */

const assert = require('assert');
const { ProductionOrchestrator } = require('../agents/production-orchestrator');

class MockDatabase {
  constructor(initialJobs = {}, initialBundles = {}) {
    this.jobs = { ...initialJobs };
    this.bundles = { ...initialBundles };
    this.updatedJobs = [];
    this.executedQueries = [];
  }

  async getGenerationJob(id) {
    return this.jobs[id] ? JSON.parse(JSON.stringify(this.jobs[id])) : null;
  }

  async updateGenerationJob(id, updates) {
    if (!this.jobs[id]) throw new Error(`Job ${id} not found`);
    Object.assign(this.jobs[id], updates);
    this.updatedJobs.push({ id, updates });
    return this.jobs[id];
  }

  async getProductionBundle(id) {
    return this.bundles[id] ? JSON.parse(JSON.stringify(this.bundles[id])) : null;
  }

  async executeQuery(query, params) {
    this.executedQueries.push({ query, params });
    return { changes: 1 };
  }
}

class MockPublishingAgent {
  constructor(options = {}) {
    this.publishCalled = 0;
    this.callArgs = [];
    this.shouldThrow = options.shouldThrow || false;
    this.throwMessage = options.throwMessage || 'Simulated network upload failure';
    this.mockResult = options.mockResult || {
      youtubeId: 'test-stub-video-123',
      youtubeUrl: 'https://www.youtube.com/watch?v=test-stub-video-123',
      publishedAt: new Date().toISOString()
    };
  }

  async publishContent(jobId, options) {
    this.publishCalled++;
    this.callArgs.push({ jobId, options });
    if (this.shouldThrow) {
      throw new Error(this.throwMessage);
    }
    return this.mockResult;
  }
}

async function run() {
  console.log('════════════════════════════════════════════════════════════');
  console.log('🧪 TEST: WORKFLOW SAFEGUARDS & ISOLATED INVARIANTS');
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

  // 1. Rights Confirmation Invariant
  await check('Missing confirmRights (false) blocks approval with HTTP 409', async () => {
    const db = new MockDatabase({
      'job-1': {
        id: 'job-1',
        status: 'awaiting_approval',
        details: { qualityEval: { passed: true, score: 95, blockingFailures: [] } }
      }
    });
    const publisher = new MockPublishingAgent();
    const orchestrator = new ProductionOrchestrator({ db });

    await assert.rejects(
      async () => {
        await orchestrator.approveAndPublish('job-1', publisher, { confirmRights: false });
      },
      (err) => {
        assert.strictEqual(err.status, 409);
        assert.ok(err.message.includes('Confirm the factual review and media rights'));
        return true;
      }
    );
    assert.strictEqual(publisher.publishCalled, 0, 'Publishing agent must never be invoked');
  });

  // 2. Blocking Quality Failure
  await check('Blocking quality failure in details.qualityEval blocks approval (409)', async () => {
    const db = new MockDatabase({
      'job-2': {
        id: 'job-2',
        status: 'awaiting_approval',
        details: { qualityEval: { passed: false, score: 65, blockingFailures: ['duration_shortfall'] } }
      }
    });
    const publisher = new MockPublishingAgent();
    const orchestrator = new ProductionOrchestrator({ db });

    await assert.rejects(
      async () => {
        await orchestrator.approveAndPublish('job-2', publisher, { confirmRights: true });
      },
      (err) => {
        assert.strictEqual(err.status, 409);
        assert.ok(err.message.includes('duration_shortfall'));
        return true;
      }
    );
    assert.strictEqual(publisher.publishCalled, 0);
  });

  await check('Blocking quality failure in db bundle fallback blocks approval (409)', async () => {
    const db = new MockDatabase(
      {
        'job-bundle-fail': {
          id: 'job-bundle-fail',
          status: 'awaiting_approval',
          details: {}
        }
      },
      {
        'job-bundle-fail': {
          qualityChecks: [
            { id: 'narration', passed: false, blocking: true, name: 'Narration Track Present' },
            { id: 'video_sync', passed: true, blocking: true, name: 'Video Sync' }
          ]
        }
      }
    );
    const publisher = new MockPublishingAgent();
    const orchestrator = new ProductionOrchestrator({ db });

    await assert.rejects(
      async () => {
        await orchestrator.approveAndPublish('job-bundle-fail', publisher, { confirmRights: true });
      },
      (err) => {
        assert.strictEqual(err.status, 409);
        assert.ok(err.message.includes('narration'));
        return true;
      }
    );
    assert.strictEqual(publisher.publishCalled, 0);
  });

  // 3. Safe Failure on Missing Quality Data
  await check('Completely missing qualityEval and bundle throws 409', async () => {
    const db = new MockDatabase({
      'job-no-quality': {
        id: 'job-no-quality',
        status: 'awaiting_approval',
        details: {}
      }
    });
    const publisher = new MockPublishingAgent();
    const orchestrator = new ProductionOrchestrator({ db });

    await assert.rejects(
      async () => {
        await orchestrator.approveAndPublish('job-no-quality', publisher, { confirmRights: true });
      },
      (err) => {
        assert.strictEqual(err.status, 409);
        assert.ok(err.message.includes('Quality gate evaluation missing'));
        return true;
      }
    );
    assert.strictEqual(publisher.publishCalled, 0);
  });

  await check('Legacy qualityChecks in job.details correctly enforces score and blocking', async () => {
    const db = new MockDatabase({
      'job-legacy': {
        id: 'job-legacy',
        status: 'awaiting_approval',
        details: {
          qualityScore: 85,
          qualityChecks: [
            { id: 'resolution', passed: true, blocking: true },
            { id: 'audio_level', passed: true, blocking: false }
          ]
        }
      }
    });
    const publisher = new MockPublishingAgent();
    const orchestrator = new ProductionOrchestrator({ db });

    const res = await orchestrator.approveAndPublish('job-legacy', publisher, { confirmRights: true });
    assert.strictEqual(res.success, true);
    assert.strictEqual(publisher.publishCalled, 1);
  });

  // 4. Cancellation Invariants & State Protection
  await check('Completed job cannot be cancelled (HTTP 409)', async () => {
    const db = new MockDatabase({
      'job-completed': { id: 'job-completed', status: 'completed' }
    });
    const orchestrator = new ProductionOrchestrator({ db });

    await assert.rejects(
      async () => {
        await orchestrator.cancelJob('job-completed');
      },
      (err) => {
        assert.strictEqual(err.status, 409);
        assert.ok(err.message.includes("Cannot cancel job in 'completed' status"));
        return true;
      }
    );
  });

  await check('Uploaded job cannot be cancelled (HTTP 409)', async () => {
    const db = new MockDatabase({
      'job-uploaded': { id: 'job-uploaded', status: 'uploaded' }
    });
    const orchestrator = new ProductionOrchestrator({ db });

    await assert.rejects(
      async () => {
        await orchestrator.cancelJob('job-uploaded');
      },
      (err) => {
        assert.strictEqual(err.status, 409);
        assert.ok(err.message.includes("Cannot cancel job in 'uploaded' status"));
        return true;
      }
    );
  });

  await check('Nonexistent job returns HTTP 404 for cancellation', async () => {
    const db = new MockDatabase({});
    const orchestrator = new ProductionOrchestrator({ db });

    await assert.rejects(
      async () => {
        await orchestrator.cancelJob('nonexistent-uuid-xyz');
      },
      (err) => {
        assert.strictEqual(err.status, 404);
        assert.ok(err.message.includes('not found'));
        return true;
      }
    );
  });

  await check('Nonexistent job returns HTTP 404 for approveAndPublish', async () => {
    const db = new MockDatabase({});
    const publisher = new MockPublishingAgent();
    const orchestrator = new ProductionOrchestrator({ db });

    await assert.rejects(
      async () => {
        await orchestrator.approveAndPublish('nonexistent-uuid-xyz', publisher, { confirmRights: true });
      },
      (err) => {
        assert.strictEqual(err.status, 404);
        return true;
      }
    );
  });

  // 5. Idempotency & Repeated Requests
  await check('Repeated approveAndPublish on uploaded job returns early without re-publishing', async () => {
    const db = new MockDatabase({
      'job-already-uploaded': {
        id: 'job-already-uploaded',
        status: 'uploaded',
        details: {
          youtubeUrl: 'https://www.youtube.com/watch?v=prior-upload-abc'
        }
      }
    });
    const publisher = new MockPublishingAgent();
    const orchestrator = new ProductionOrchestrator({ db });

    const result = await orchestrator.approveAndPublish('job-already-uploaded', publisher, { confirmRights: true });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.alreadyPublished, true);
    assert.strictEqual(result.youtubeUrl, 'https://www.youtube.com/watch?v=prior-upload-abc');
    assert.strictEqual(publisher.publishCalled, 0);
  });

  await check('Repeated cancelJob on already cancelled job is idempotent (returns status cancelled)', async () => {
    const db = new MockDatabase({
      'job-cancelled': { id: 'job-cancelled', status: 'cancelled' }
    });
    const orchestrator = new ProductionOrchestrator({ db });

    const result = await orchestrator.cancelJob('job-cancelled');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.alreadyCancelled, true);
    assert.strictEqual(result.status, 'cancelled');
  });

  // 6. Network Upload Failure Cleanliness
  await check('Upload network failure transitions job to status: failed, stage: upload_failed', async () => {
    const db = new MockDatabase({
      'job-network-fail': {
        id: 'job-network-fail',
        status: 'awaiting_approval',
        details: { qualityEval: { passed: true, score: 90, blockingFailures: [] } }
      }
    });
    const failingPublisher = new MockPublishingAgent({
      shouldThrow: true,
      throwMessage: 'Simulated YouTube API connection timeout (504)'
    });
    const orchestrator = new ProductionOrchestrator({ db });

    await assert.rejects(
      async () => {
        await orchestrator.approveAndPublish('job-network-fail', failingPublisher, { confirmRights: true });
      },
      (err) => {
        assert.ok(err.message.includes('Simulated YouTube API connection timeout'));
        return true;
      }
    );

    const updated = await db.getGenerationJob('job-network-fail');
    assert.strictEqual(updated.status, 'failed');
    assert.strictEqual(updated.stage, 'upload_failed');
    assert.ok(updated.error.includes('Simulated YouTube API connection timeout'));
  });

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`📊 Safeguards Test Results: ${passed} passed, ${failed} failed`);
  console.log('════════════════════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
