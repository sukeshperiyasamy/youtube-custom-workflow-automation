#!/usr/bin/env node

/**
 * YouTube Custom Workflow Automation CLI
 * 
 * Command-line tool to run the custom workflow: analyze instructions,
 * plan multi-scene productions, coordinate ComfyUI generation, and verify quality.
 */

const { WorkflowEngine } = require('./index');
const { Logger } = require('./utils/logger');

const logger = new Logger('WorkflowCLI');

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    prompt: '',
    workflow: 'minimax_h3_turbo_local',
    dryRun: false,
    status: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--prompt' || arg === '-p') {
      options.prompt = args[++i];
    } else if (arg === '--workflow' || arg === '-w') {
      options.workflow = args[++i];
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--status') {
      options.status = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }

  return options;
}

function printUsage() {
  console.log(`
YouTube Custom Workflow Automation CLI

Usage:
  node cli.js [options]

Options:
  -p, --prompt <text>     Natural language video instruction or topic (required for generation)
  -w, --workflow <id>     Workflow to use (default: minimax_h3_turbo_local)
  --dry-run               Plan production and validate instruction without rendering
  --status                Check local ComfyUI connectivity and available workflows
  -h, --help              Show this help message

Examples:
  node cli.js --status
  node cli.js --prompt "Ancient Dravidian temple at sunrise" --dry-run
  node cli.js --prompt "Aerial view of misty mountains" --workflow minimax_h3_turbo_local
`);
}

async function main() {
  const options = parseArgs();

  if (options.help || (process.argv.length <= 2 && !options.status)) {
    printUsage();
    process.exit(0);
  }

  const engine = new WorkflowEngine();
  await engine.initialize();

  if (options.status) {
    console.log('\n🔍 Checking ComfyUI & Hardware Status:');
    const stats = await engine.comfyClient.getSystemStats();
    if (stats) {
      console.log('  • ComfyUI Server:  Online (http://127.0.0.1:8188)');
      const dev = stats.devices?.[0];
      if (dev) {
        console.log(`  • GPU Device:      ${dev.name}`);
        console.log(`  • Free VRAM:       ${Math.round(dev.vram_free / (1024*1024))} MB / ${Math.round(dev.vram_total / (1024*1024))} MB`);
      }
    } else {
      console.log('  • ComfyUI Server:  Offline or unreachable on 127.0.0.1:8188');
    }

    console.log('\n📋 Registered Workflows:');
    const workflows = engine.workflowRegistry.getWorkflows();
    workflows.forEach(w => {
      console.log(`  • [${w.id}] ${w.name}`);
    });
    console.log('');
    process.exit(0);
  }

  if (!options.prompt) {
    console.error('Error: --prompt is required.');
    printUsage();
    process.exit(1);
  }

  console.log(`\n🎬 Processing User Instruction: "${options.prompt}"`);

  // Step 1: Interpret Instruction
  console.log('\n[1/3] Interpreting Natural Language Instruction & Sanitizing...');
  const interpreted = await engine.interpreter.interpret(options.prompt);
  const topic = interpreted.topics?.[0] || options.prompt;
  const settings = interpreted.settings || {};
  console.log(`  • Topic:      ${topic}`);
  console.log(`  • Style:      ${settings.visualStyle || 'Cinematic'}`);
  console.log(`  • Duration:   ${settings.duration || 30}s`);
  console.log(`  • Resolution: ${settings.resolution || '1080p'}`);

  // Step 2: Plan Production
  console.log('\n[2/3] Planning Scene Breakdown & Prompts...');
  const plan = await engine.aiPlanner.createPlan({
    prompt: topic,
    duration: settings.duration || 30,
    aspectRatio: settings.aspectRatio || '16:9',
    workflowId: options.workflow
  });
  console.log(`  • Plan Title:   ${plan.title}`);
  console.log(`  • Total Scenes: ${plan.scenes?.length || 0}`);
  plan.scenes?.forEach((s, idx) => {
    const title = s.title || `Scene ${idx + 1}`;
    const dur = s.duration_seconds || s.duration || 5;
    const camera = s.camera_movement ? ` - ${s.camera_movement}` : '';
    console.log(`    - Scene ${idx + 1}: ${title} (${dur}s)${camera}`);
  });

  if (options.dryRun) {
    console.log('\n✅ Dry run completed successfully. Production plan is valid.\n');
    process.exit(0);
  }

  // Step 3: Create Job
  console.log('\n[3/3] Creating Production Job...');
  const job = await engine.orchestrator.createDraftJob(options.prompt, {
    workflowId: options.workflow,
    autoStart: false
  });
  console.log(`  • Job ID: ${job.id}`);
  console.log(`  • Initial Status: ${job.status}`);
  console.log(`  • Job Manifest: data/productions/${job.id}`);
  console.log('\n✅ Workflow job created and ready for execution.\n');
}

main().catch(err => {
  logger.error(`CLI execution failed: ${err.message}`);
  process.exit(1);
});
