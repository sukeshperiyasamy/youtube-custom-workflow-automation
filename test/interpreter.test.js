/**
 * YouTube Custom Workflow Automation - Instruction Interpreter & Sanitization Test Suite
 */

const assert = require('assert');
const { InstructionInterpreter } = require('../utils/instruction-interpreter');

async function run() {
  console.log('════════════════════════════════════════════════════════════');
  console.log('🧪 TEST: INSTRUCTION PARSER & INPUT SAFETY SANITIZATION');
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

  const interpreter = new InstructionInterpreter();

  // 1. Empty & Whitespace Validation
  await check('Rejects empty input and whitespace-only text', async () => {
    const r1 = await interpreter.interpret('');
    assert.strictEqual(r1.valid, false);
    const r2 = await interpreter.interpret('   \n\t  ');
    assert.strictEqual(r2.valid, false);
  });

  // 2. XSS & HTML Vector Neutralization
  await check('Sanitizes HTML tags from single-topic instructions', async () => {
    const res = await interpreter.interpret('<b>Dravidian Architecture</b> in <i>Madurai</i>');
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.topics[0], 'Dravidian Architecture in Madurai');
  });

  await check('Neutralizes script tags and inline event handlers', async () => {
    const res = await interpreter.interpret('<script>alert("XSS")</script><img src="x" onerror="alert(1)">Thanjavur Temple');
    assert.strictEqual(res.valid, true);
    assert.ok(!res.topics[0].includes('<script>'));
    assert.ok(!res.topics[0].includes('onerror'));
    assert.ok(res.topics[0].includes('Thanjavur Temple'));
  });

  await check('Neutralizes javascript: pseudo-protocol vectors', async () => {
    const res = await interpreter.interpret('Check this link: javascript:void(0); Meenakshi Amman Temple');
    assert.strictEqual(res.valid, true);
    assert.ok(!res.topics[0].includes('javascript:'));
    assert.ok(res.topics[0].includes('Meenakshi Amman Temple'));
  });

  // 3. Punctuation & Unicode Preservation
  await check('Preserves legitimate punctuation, Unicode, and accented characters', async () => {
    const text = 'Cité de Carcassonne: Château comtal, remparts & trésors d’Occitanie — 4K';
    const res = await interpreter.interpret(text);
    assert.strictEqual(res.valid, true);
    assert.ok(res.topics[0].includes('Cité de Carcassonne'));
    assert.ok(res.topics[0].includes('Occitanie'));
  });

  // 4. Batch Numbered Topics
  await check('Parses inline numbered batch list and sanitizes each item', async () => {
    const batchInput = 'Produce 3 separate videos: 1. <script>alert(1)</script>Taj Mahal, 2. <img onerror=foo>Colosseum in Rome, 3. Great Pyramids of Giza';
    const res = await interpreter.interpret(batchInput);
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.isBatch, true);
    assert.strictEqual(res.topicCount, 3);
    assert.strictEqual(res.topics[0], 'Taj Mahal');
    assert.strictEqual(res.topics[1], 'Colosseum in Rome');
    assert.strictEqual(res.topics[2], 'Great Pyramids of Giza');
  });

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`📊 Interpreter Test Results: ${passed} passed, ${failed} failed`);
  console.log('════════════════════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
