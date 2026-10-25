/**
 * Robust qualityChecks normalization utility.
 * Guarantees that qualityChecks is always an Array of check objects:
 *   { id: string, passed: boolean, message: string, blocking: boolean, ... }
 * 
 * Safely handles:
 * - Existing arrays of check objects
 * - JSON strings (serialized arrays, serialized objects, or double-serialized strings)
 * - Objects with a `checks` array property (e.g. OperatorService results)
 * - Verification / probe summary objects (e.g. { duration, resolution, verified, hasAudio, codec })
 * - Key-value check maps (e.g. { checkName: boolean | { passed, message } })
 * - Null, undefined, empty strings (returns [])
 * - Malformed JSON strings or unexpected primitives (logs diagnostic warning, returns [])
 */

const { Logger } = require('./logger');
const logger = new Logger('QualityNormalizer');

function normalizeCheckItem(item, defaultId = 'check') {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const id = String(item.id || item.name || item.key || defaultId).trim() || defaultId;
  const passed = Boolean(item.passed ?? item.status === 'passed' ?? item.success ?? false);
  const blocking = Boolean(item.blocking ?? true);
  const message = String(item.message || item.description || item.reason || (passed ? `${id} passed` : `${id} failed`)).trim();

  return {
    ...item,
    id,
    passed,
    message,
    blocking
  };
}

function normalizeQualityChecks(raw, contextId = null, options = {}) {
  if (raw === null || raw === undefined || raw === '') {
    return [];
  }

  // Handle JSON string representation
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        return normalizeQualityChecks(parsed, contextId, options);
      } catch (err) {
        logger.warn(`Malformed quality_checks JSON string for context [${contextId || 'unknown'}]: "${trimmed.slice(0, 100)}" - ${err.message}`);
        return [];
      }
    } else {
      logger.warn(`Unexpected non-JSON string for quality_checks [${contextId || 'unknown'}]: "${trimmed.slice(0, 100)}"`);
      return [];
    }
  }

  // Handle Array representation
  if (Array.isArray(raw)) {
    const result = [];
    raw.forEach((item, idx) => {
      const normalized = normalizeCheckItem(item, `check_${idx + 1}`);
      if (normalized) {
        result.push(normalized);
      } else {
        logger.warn(`Invalid item in quality_checks array at index ${idx} for [${contextId || 'unknown'}]:`, item);
      }
    });
    return result;
  }

  // Handle Object representation
  if (typeof raw === 'object') {
    // Sub-case 1: Object wrapping a `checks` array (e.g. { passed: true, score: 100, checks: [...] })
    if (Array.isArray(raw.checks)) {
      return normalizeQualityChecks(raw.checks, contextId, options);
    }

    const checks = [];

    // Sub-case 2: Media probe & verification summary object (e.g. from ProductionOrchestrator or FFprobe)
    // Structure: { verified, duration, resolution, hasAudio, codec }
    if ('verified' in raw || 'resolution' in raw || 'duration' in raw) {
      if ('verified' in raw) {
        const verifiedPassed = Boolean(raw.verified);
        checks.push({
          id: 'media_verification',
          passed: verifiedPassed,
          message: verifiedPassed ? 'Media stream and container verification passed' : 'Media verification failed',
          blocking: true
        });
      }

      if ('resolution' in raw && raw.resolution) {
        const resStr = String(raw.resolution);
        const isStandard = resStr === '1920x1080' || /^\d+x\d+$/.test(resStr);
        checks.push({
          id: 'resolution',
          passed: isStandard,
          message: `Video resolution: ${resStr}`,
          blocking: false
        });
      } else {
        checks.push({
          id: 'resolution',
          passed: false,
          message: 'Video resolution unknown or missing',
          blocking: true
        });
      }

      if ('duration' in raw && raw.duration !== null && raw.duration !== undefined) {
        const dur = Number(raw.duration);
        const target = Number(options.targetDuration || raw.targetDuration || raw.target_duration || 0);
        let durationPassed = Number.isFinite(dur) && dur > 0;
        let message = '';
        let blocking = false;

        if (target > 0) {
          const minAcceptable = Math.max(3.0, target * 0.8);
          durationPassed = Number.isFinite(dur) && dur >= minAcceptable;
          message = durationPassed
            ? `Video duration: ${dur.toFixed(2)}s (meets ${target.toFixed(1)}s target)`
            : `Duration shortfall: ${dur.toFixed(2)}s is below target ${target.toFixed(1)}s (min: ${minAcceptable.toFixed(1)}s)`;
          blocking = !durationPassed;
        } else if (dur < 3.0) {
          durationPassed = false;
          message = `Duration: ${dur.toFixed(2)}s (pilot/short clip; below 3.0s standard minimum)`;
          blocking = true;
        } else {
          message = `Video duration: ${dur.toFixed(2)}s`;
        }

        checks.push({
          id: 'duration',
          passed: durationPassed,
          message,
          blocking
        });
      } else {
        checks.push({
          id: 'duration',
          passed: false,
          message: 'Video duration cannot be established or is missing',
          blocking: true
        });
      }

      if ('hasAudio' in raw) {
        const hasAudio = Boolean(raw.hasAudio);
        checks.push({
          id: 'audio_stream',
          passed: hasAudio,
          message: hasAudio ? 'Audio stream present' : 'No audio stream detected',
          blocking: false
        });
      }

      if ('codec' in raw && raw.codec) {
        checks.push({
          id: 'video_codec',
          passed: true,
          message: `Video codec: ${raw.codec}`,
          blocking: false
        });
      }

      return checks;
    }

    // Sub-case 3: Key-value map of checks: { checkName: boolean | { passed, message } }
    const keys = Object.keys(raw);
    if (keys.length > 0) {
      keys.forEach(key => {
        const val = raw[key];
        if (typeof val === 'boolean') {
          checks.push({
            id: key,
            passed: val,
            message: `${key}: ${val ? 'passed' : 'failed'}`,
            blocking: false
          });
        } else if (val && typeof val === 'object') {
          const item = normalizeCheckItem({ id: key, ...val }, key);
          if (item) checks.push(item);
        }
      });
      if (checks.length > 0) {
        return checks;
      }
    }

    logger.warn(`Unrecognized quality_checks object shape for context [${contextId || 'unknown'}]:`, JSON.stringify(raw).slice(0, 150));
    return [];
  }

  // Handle unexpected primitives (number, boolean, symbol)
  logger.warn(`Unexpected primitive type [${typeof raw}] for quality_checks [${contextId || 'unknown'}]:`, raw);
  return [];
}

module.exports = { normalizeQualityChecks, normalizeCheckItem };
