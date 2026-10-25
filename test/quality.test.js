/**
 * YouTube Custom Workflow Automation - Quality Normalization Test Suite
 */

const assert = require('assert');
const { normalizeQualityChecks, QualityNormalizer } = require('../utils/quality-normalizer');
const { QualityGate } = require('../utils/quality-gate');

async function run() {
  console.log('════════════════════════════════════════════════════════════');
  console.log('🧪 TEST: QUALITY GATE & CHECKS NORMALIZATION');
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

  // 1. Array Handling
  await check('Normalizes standard array of check objects and preserves fields', () => {
    const checks = [
      { id: 'video_streams', name: 'Valid Video Streams', passed: true, blocking: true },
      { id: 'duration', name: 'Duration Match', passed: true, blocking: true }
    ];
    const normalized = normalizeQualityChecks(checks);
    assert.strictEqual(normalized.length, 2);
    assert.strictEqual(normalized[0].id, 'video_streams');
    assert.strictEqual(normalized[1].passed, true);
  });

  // 2. Failing Checks & Blocking Logic
  await check('Preserves failing checks in an array without masking errors', () => {
    const checks = [
      { id: 'duration', name: 'Duration Match', passed: false, blocking: true, message: 'Expected 5s, got 0.92s' }
    ];
    const normalized = normalizeQualityChecks(checks);
    assert.strictEqual(normalized.length, 1);
    assert.strictEqual(normalized[0].passed, false);
    assert.strictEqual(normalized[0].blocking, true);
  });

  // 3. JSON String Handling
  await check('Parses and normalizes JSON string representing an array of checks', () => {
    const jsonStr = JSON.stringify([
      { id: 'aspect_ratio', passed: true, blocking: true, name: '16:9 Aspect Ratio' }
    ]);
    const normalized = normalizeQualityChecks(jsonStr);
    assert.strictEqual(normalized.length, 1);
    assert.strictEqual(normalized[0].id, 'aspect_ratio');
  });

  // 4. Null & Missing Handling
  await check('Returns empty array for null, undefined, and empty string', () => {
    assert.deepStrictEqual(normalizeQualityChecks(null), []);
    assert.deepStrictEqual(normalizeQualityChecks(undefined), []);
    assert.deepStrictEqual(normalizeQualityChecks(''), []);
  });

  // 5. QualityGate Master Production Verification
  await check('QualityGate blocks truncated video under minimum threshold', () => {
    const gate = new QualityGate();
    const probe = {
      hasVideo: true,
      hasAudio: false,
      videoCodec: 'h264',
      width: 1920,
      height: 1080,
      duration: 0.92,
      sizeBytes: 50000,
      fps: 24
    };
    const evalResult = gate.evaluateMasterProduction({ probe, targetDuration: 5 });
    assert.strictEqual(evalResult.passed, false);
    assert.ok(evalResult.blockingFailures.includes('duration'));
  });

  await check('QualityGate passes valid 1080p master video meeting duration', () => {
    const gate = new QualityGate();
    const probe = {
      hasVideo: true,
      hasAudio: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1920,
      height: 1080,
      duration: 5.0,
      sizeBytes: 2500000,
      fps: 24
    };
    const evalResult = gate.evaluateMasterProduction({ probe, targetDuration: 5 });
    assert.strictEqual(evalResult.passed, true);
    assert.strictEqual(evalResult.blockingFailures.length, 0);
    assert.strictEqual(evalResult.score, 100);
  });

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`📊 Quality Test Results: ${passed} passed, ${failed} failed`);
  console.log('════════════════════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
