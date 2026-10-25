/**
 * Quality Gate & Media Validation Service
 * Enforces hard duration requirements, stream verification, truncation detection,
 * and publication blocking checks.
 */

const { Logger } = require('./logger');

const logger = new Logger('QualityGate');

class QualityGate {
  constructor(options = {}) {
    this.logger = logger;
    this.defaultDurationTolerance = options.defaultDurationTolerance || 0.10; // 10% tolerance unless specified
  }

  /**
   * Evaluates master video against production requirements
   * Returns normalized checks array and overall pass/fail status
   */
  evaluateMasterProduction(params = {}) {
    const {
      probe,
      targetDuration = 30,
      aspectRatio = '16:9',
      resolution = '1080p',
      fps = 24,
      totalScenes = 1,
      completedScenes = 1,
      hasAudioExpected = true,
      hasNarrationExpected = false,
      narrationPath = null,
      intentionalSilence = false,
      silenceReason = null,
      toleranceSeconds = null
    } = params;

    const checks = [];

    // 1. Container & Video Stream Integrity (BLOCKING)
    const hasValidContainer = Boolean(probe && probe.duration > 0 && probe.hasVideo && probe.sizeBytes > 0);
    checks.push({
      id: 'media_verification',
      category: 'technical',
      name: 'Media Container & Video Stream',
      passed: hasValidContainer,
      blocking: true,
      message: hasValidContainer
        ? `Master video container valid (${probe.videoCodec}, ${(probe.sizeBytes / 1024 / 1024).toFixed(2)} MB)`
        : 'Invalid or corrupted master video container (missing video stream or 0-byte file)'
    });

    // 2. Resolution & Aspect Ratio (BLOCKING)
    const expectedRes = this.getExpectedDimensions(aspectRatio, resolution);
    const resMatches = Boolean(
      probe &&
      Math.abs(probe.width - expectedRes.width) <= 2 &&
      Math.abs(probe.height - expectedRes.height) <= 2
    );
    checks.push({
      id: 'resolution',
      category: 'technical',
      name: 'Resolution & Aspect Ratio',
      passed: resMatches,
      blocking: true,
      message: resMatches
        ? `Resolution matches plan: ${probe.width}x${probe.height} (${aspectRatio})`
        : `Resolution mismatch: got ${probe?.width || 0}x${probe?.height || 0}, expected ${expectedRes.width}x${expectedRes.height} (${aspectRatio})`
    });

    // 3. HARD DURATION GATE & TRUNCATION DETECTION (BLOCKING)
    // Nominal vs actual duration:
    // A nominal 5-second video that produced ~0.92s MUST fail this gate!
    const actualDuration = probe?.duration || 0;
    const allowedTolerance = toleranceSeconds !== null && toleranceSeconds !== undefined
      ? Number(toleranceSeconds)
      : Math.max(1.0, targetDuration * this.defaultDurationTolerance);

    const durationDiff = Math.abs(actualDuration - targetDuration);
    const durationPassed = actualDuration > 0 && durationDiff <= allowedTolerance;

    let durationMsg = `Duration: ${actualDuration.toFixed(2)}s (Target: ${targetDuration}s, allowed ±${allowedTolerance.toFixed(1)}s)`;
    if (!durationPassed) {
      if (actualDuration < targetDuration * 0.5) {
        durationMsg = `CRITICAL DURATION SHORTFALL: Video duration ${actualDuration.toFixed(2)}s is severely truncated (target ${targetDuration}s). Missing scenes or aborted inference!`;
      } else {
        durationMsg = `Duration shortfall: ${actualDuration.toFixed(2)}s does not meet target ${targetDuration}s (±${allowedTolerance.toFixed(1)}s allowed)`;
      }
    }

    checks.push({
      id: 'duration',
      category: 'technical',
      name: 'Target Duration Accuracy',
      passed: durationPassed,
      blocking: true, // HARD GATE
      actualDuration,
      targetDuration,
      message: durationMsg
    });

    // 4. Scene Completeness & Missing Scene Detection (BLOCKING)
    const scenesComplete = completedScenes >= totalScenes && totalScenes > 0;
    checks.push({
      id: 'scene_completeness',
      category: 'production',
      name: 'Scene Continuity & Completeness',
      passed: scenesComplete,
      blocking: true,
      message: scenesComplete
        ? `All ${totalScenes}/${totalScenes} scenes successfully rendered and assembled`
        : `Scene count mismatch: only ${completedScenes} of ${totalScenes} scenes rendered!`
    });

    // 5. Audio Track Verification (BLOCKING if audio expected without confirmed silence)
    let audioPassed = false;
    let audioMsg = '';
    if (intentionalSilence) {
      audioPassed = true;
      audioMsg = `Intentional silent audio confirmed: ${silenceReason || 'Silent video override'}`;
    } else if (hasAudioExpected) {
      audioPassed = Boolean(probe?.hasAudio);
      audioMsg = audioPassed
        ? `Audio track verified: ${probe.audioCodec || 'AAC'} stereo stream`
        : 'Missing required audio track (no audio stream found in master container)';
    } else {
      audioPassed = true;
      audioMsg = 'Audio stream not required for this production';
    }

    checks.push({
      id: 'audio_stream',
      category: 'technical',
      name: 'Audio Stream Integrity',
      passed: audioPassed,
      blocking: !intentionalSilence,
      message: audioMsg
    });

    // 6. Frame Rate Verification (ADVISORY)
    const fpsMatches = Boolean(probe && Math.abs(probe.fps - fps) <= 1.0);
    checks.push({
      id: 'frame_rate',
      category: 'technical',
      name: 'Frame Rate Consistency',
      passed: fpsMatches,
      blocking: false,
      message: fpsMatches
        ? `Frame rate verified at ${probe.fps.toFixed(1)} fps`
        : `Frame rate is ${probe?.fps ? probe.fps.toFixed(1) : 'unknown'} fps (target ${fps} fps)`
    });

    // Compute Overall Readiness & Quality Score
    const blockingFailures = checks.filter(c => c.blocking && !c.passed);
    const passedCount = checks.filter(c => c.passed).length;
    const score = Math.round((passedCount / checks.length) * 100);

    const isReadyForApproval = blockingFailures.length === 0;

    return {
      passed: isReadyForApproval,
      score,
      blockingFailures: blockingFailures.map(c => c.id),
      checks
    };
  }

  getExpectedDimensions(aspectRatio, resolution) {
    if (aspectRatio === '9:16') {
      return resolution === '720p' ? { width: 720, height: 1280 } : { width: 1080, height: 1920 };
    }
    if (aspectRatio === '1:1') {
      return resolution === '720p' ? { width: 720, height: 720 } : { width: 1080, height: 1080 };
    }
    // Default 16:9
    return resolution === '720p' ? { width: 1280, height: 720 } : { width: 1920, height: 1080 };
  }
}

module.exports = {
  QualityGate
};
