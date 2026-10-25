const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { getFFmpegPath, getFFprobePath } = require('./ffmpeg');
const { Logger } = require('./logger');

class ProductionAssembler {
  constructor() {
    this.logger = new Logger('ProductionAssembler');
  }

  async probeMedia(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Media file not found for probe: ${filePath}`);
    }
    const ffprobe = getFFprobePath();
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ];
    const { stdout } = await execFileAsync(ffprobe, args, { maxBuffer: 16 * 1024 * 1024 });
    const parsed = JSON.parse(stdout);
    const videoStream = parsed.streams?.find(s => s.codec_type === 'video') || null;
    const audioStream = parsed.streams?.find(s => s.codec_type === 'audio') || null;
    const duration = Number(parsed.format?.duration || videoStream?.duration || 0);

    return {
      duration,
      hasVideo: Boolean(videoStream),
      width: videoStream ? Number(videoStream.width) : 0,
      height: videoStream ? Number(videoStream.height) : 0,
      codec: videoStream?.codec_name || 'unknown',
      fps: videoStream?.r_frame_rate ? this._parseFps(videoStream.r_frame_rate) : 24,
      hasAudio: Boolean(audioStream),
      audioCodec: audioStream?.codec_name || null,
      audioSampleRate: audioStream?.sample_rate ? Number(audioStream.sample_rate) : null,
      format: parsed.format?.format_name || 'mp4',
      sizeBytes: Number(parsed.format?.size || fs.statSync(filePath).size)
    };
  }

  _parseFps(rateStr) {
    if (!rateStr) return 24;
    const parts = String(rateStr).split('/');
    if (parts.length === 2 && Number(parts[1]) > 0) {
      return Math.round((Number(parts[0]) / Number(parts[1])) * 100) / 100;
    }
    return Number(rateStr) || 24;
  }

  async trimSceneToExactDuration(rawVideoPath, trimmedVideoPath, fps = 24, targetFrames = 120) {
    fs.mkdirSync(path.dirname(trimmedVideoPath), { recursive: true });
    const ffmpeg = getFFmpegPath();
    const rawProbe = await this.probeMedia(rawVideoPath).catch(() => ({ hasAudio: false }));
    const targetDuration = targetFrames / fps;

    const args = [
      '-y',
      '-i', rawVideoPath,
      '-vf', `select='lt(n\\,${targetFrames})',setpts=PTS-STARTPTS`,
      '-r', String(fps),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', '16',
      '-preset', 'fast'
    ];

    if (rawProbe.hasAudio) {
      args.push(
        '-af', `atrim=0:${targetDuration},asetpts=PTS-STARTPTS`,
        '-c:a', 'aac',
        '-b:a', '192k'
      );
    } else {
      args.push('-an');
    }

    args.push(trimmedVideoPath);
    await execFileAsync(ffmpeg, args);
    return trimmedVideoPath;
  }

  async extractTerminalFrame(videoPath, frameOutputPath, frameNumber = 119) {
    fs.mkdirSync(path.dirname(frameOutputPath), { recursive: true });
    const ffmpeg = getFFmpegPath();
    const args = [
      '-y',
      '-i', videoPath,
      '-vf', `select='eq(n\\,${frameNumber})'`,
      '-vframes', '1',
      frameOutputPath
    ];
    try {
      await execFileAsync(ffmpeg, args);
    } catch (_e) {
      // Fallback: seek to near-end frame if exact frame selection fails
      const fallbackArgs = ['-y', '-sseof', '-0.1', '-i', videoPath, '-vframes', '1', frameOutputPath];
      await execFileAsync(ffmpeg, fallbackArgs);
    }
    return frameOutputPath;
  }

  async extractThumbnail(videoPath, thumbnailOutputPath, timestamp = 2.0) {
    fs.mkdirSync(path.dirname(thumbnailOutputPath), { recursive: true });
    const ffmpeg = getFFmpegPath();
    const probe = await this.probeMedia(videoPath).catch(() => ({ duration: 0 }));
    // If video duration is shorter than requested timestamp, pick midpoint or 0.1s
    const safeSeek = (probe.duration && probe.duration > 0)
      ? (probe.duration > timestamp ? timestamp : Math.max(0, probe.duration * 0.4))
      : 0;

    const args = [
      '-y',
      ...(safeSeek > 0 ? ['-ss', safeSeek.toFixed(2)] : []),
      '-i', videoPath,
      '-vframes', '1',
      '-q:v', '2',
      thumbnailOutputPath
    ];

    try {
      await execFileAsync(ffmpeg, args);
    } catch (_e) {
      // Fallback
    }

    // Verify thumbnail was created and has non-zero size, otherwise force frame 0 without seek
    if (!fs.existsSync(thumbnailOutputPath) || fs.statSync(thumbnailOutputPath).size === 0) {
      const fallbackArgs = ['-y', '-i', videoPath, '-vframes', '1', '-q:v', '2', thumbnailOutputPath];
      await execFileAsync(ffmpeg, fallbackArgs);
    }

    return thumbnailOutputPath;
  }

  async concatenateScenes(trimmedVideoPaths, outputConcatPath) {
    if (!trimmedVideoPaths || trimmedVideoPaths.length === 0) {
      throw new Error('No scenes provided for concatenation.');
    }
    fs.mkdirSync(path.dirname(outputConcatPath), { recursive: true });
    const ffmpeg = getFFmpegPath();

    if (trimmedVideoPaths.length === 1) {
      fs.copyFileSync(trimmedVideoPaths[0], outputConcatPath);
      return outputConcatPath;
    }

    const concatListFile = path.join(path.dirname(outputConcatPath), 'concat_list.txt');
    const fileEntries = trimmedVideoPaths.map(p => `file '${path.resolve(p).replace(/\\/g, '/')}'`).join('\n');
    fs.writeFileSync(concatListFile, fileEntries, 'utf8');

    try {
      const args = [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatListFile,
        '-c', 'copy',
        outputConcatPath
      ];
      await execFileAsync(ffmpeg, args);
      return outputConcatPath;
    } catch (copyErr) {
      this.logger.warn(`Direct concat copy failed (${copyErr.message}), falling back to re-encode filter...`);
      const inputs = [];
      const filterSegments = [];
      const firstProbe = await this.probeMedia(trimmedVideoPaths[0]).catch(() => ({ hasAudio: false }));
      const hasAudio = firstProbe.hasAudio;

      trimmedVideoPaths.forEach((p, idx) => {
        inputs.push('-i', p);
        filterSegments.push(`[${idx}:v]`);
        if (hasAudio) filterSegments.push(`[${idx}:a]`);
      });

      const filterStr = hasAudio
        ? `${filterSegments.join('')}concat=n=${trimmedVideoPaths.length}:v=1:a=1[v][a]`
        : `${filterSegments.join('')}concat=n=${trimmedVideoPaths.length}:v=1:a=0[v]`;

      const fallbackArgs = [
        '-y',
        ...inputs,
        '-filter_complex', filterStr,
        '-map', '[v]',
        ...(hasAudio ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-crf', '18',
        '-preset', 'fast',
        outputConcatPath
      ];
      await execFileAsync(ffmpeg, fallbackArgs);
      return outputConcatPath;
    }
  }

  async assembleMasterVideo(options = {}) {
    const {
      sceneVideos,
      outputFinalPath,
      narrationAudioPath,
      backgroundMusicPath,
      resolution = { width: 1920, height: 1080 },
      aspectRatio = '16:9'
    } = options;

    if (!sceneVideos || sceneVideos.length === 0) {
      throw new Error('Cannot assemble video: sceneVideos array is empty.');
    }

    fs.mkdirSync(path.dirname(outputFinalPath), { recursive: true });
    const ffmpeg = getFFmpegPath();

    // 1. First concatenate scenes into an intermediate raw master
    const intermediateConcat = path.join(path.dirname(outputFinalPath), 'intermediate_concat.mp4');
    await this.concatenateScenes(sceneVideos, intermediateConcat);

    // Probe concatenated video to determine duration and native audio presence
    const probeConcat = await this.probeMedia(intermediateConcat);
    const hasNativeAudio = probeConcat.hasAudio;
    const hasNarration = Boolean(narrationAudioPath && fs.existsSync(narrationAudioPath));
    const hasMusic = Boolean(backgroundMusicPath && fs.existsSync(backgroundMusicPath));

    const targetW = resolution.width || 1920;
    const targetH = resolution.height || 1080;

    // 2. Setup inputs and build filter complex
    const inputs = ['-i', intermediateConcat];
    const filterParts = [
      `[0:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v]`
    ];

    let currentInputIdx = 1;
    let narrationInputIdx = -1;
    let musicInputIdx = -1;

    if (hasNarration) {
      inputs.push('-i', narrationAudioPath);
      narrationInputIdx = currentInputIdx++;
    }
    if (hasMusic) {
      inputs.push('-i', backgroundMusicPath);
      musicInputIdx = currentInputIdx++;
    }

    let audioMapping = '[aout]';

    if (hasNarration && hasMusic) {
      // Mix Narration + Music (+ native ambient if present)
      if (hasNativeAudio) {
        filterParts.push(`[0:a]volume=0.25[amb]`);
        filterParts.push(`[${narrationInputIdx}:a]volume=1.0[narr]`);
        filterParts.push(`[${musicInputIdx}:a]volume=0.25[bgm]`);
        filterParts.push(`[narr][amb][bgm]amix=inputs=3:duration=first:dropout_transition=2,dynaudnorm[aout]`);
        this.logger.info('Audio mix: Narration (1.0) + Native Ambient (0.25) + Music (0.25) with dynamic normalization');
      } else {
        filterParts.push(`[${narrationInputIdx}:a]volume=1.0[narr]`);
        filterParts.push(`[${musicInputIdx}:a]volume=0.25[bgm]`);
        filterParts.push(`[narr][bgm]amix=inputs=2:duration=first:dropout_transition=2,dynaudnorm[aout]`);
        this.logger.info('Audio mix: Narration (1.0) + Music (0.25) with dynamic normalization');
      }
    } else if (hasNarration) {
      // Narration only (+ native ambient if present)
      if (hasNativeAudio) {
        filterParts.push(`[0:a]volume=0.3[amb]`);
        filterParts.push(`[${narrationInputIdx}:a]volume=1.0[narr]`);
        filterParts.push(`[narr][amb]amix=inputs=2:duration=first:dropout_transition=2,dynaudnorm[aout]`);
        this.logger.info('Audio mix: Narration (1.0) + Native Ambient (0.3)');
      } else {
        filterParts.push(`[${narrationInputIdx}:a]volume=1.0[aout]`);
        this.logger.info('Audio mix: Narration (1.0)');
      }
    } else if (hasMusic) {
      // Background music only (+ native ambient if present)
      if (hasNativeAudio) {
        filterParts.push(`[0:a]volume=0.5[amb]`);
        filterParts.push(`[${musicInputIdx}:a]volume=0.5[bgm]`);
        filterParts.push(`[amb][bgm]amix=inputs=2:duration=first:dropout_transition=2,dynaudnorm[aout]`);
        this.logger.info('Audio mix: Native Ambient (0.5) + Background Music (0.5)');
      } else {
        filterParts.push(`[${musicInputIdx}:a]volume=0.7[aout]`);
        this.logger.info('Audio mix: Background Music (0.7)');
      }
    } else if (hasNativeAudio) {
      // Preserve native audio generated by the model
      filterParts.push(`[0:a]volume=1.0[aout]`);
      this.logger.info('Audio mix: Preserving native ambient audio from generated clips');
    } else {
      // Clean silence generator for YouTube requirement
      inputs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
      audioMapping = `${currentInputIdx}:a`;
      this.logger.info('Audio mix: Clean silent stereo audio stream (intentional silence)');
    }

    const args = [
      '-y',
      ...inputs,
      '-filter_complex', filterParts.join(';'),
      '-map', '[v]',
      '-map', audioMapping,
      '-c:v', 'libx264',
      '-crf', '17',
      '-preset', 'fast',
      '-r', '24',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-movflags', '+faststart',
      outputFinalPath
    ];

    this.logger.info(`Encoding master video (${targetW}x${targetH} @ 24fps)...`);
    await execFileAsync(ffmpeg, args);

    // Verify output with ffprobe
    const probe = await this.probeMedia(outputFinalPath);
    if (!probe.duration || probe.duration <= 0 || probe.sizeBytes === 0) {
      throw new Error(`Assembled video validation failed. Output file is empty or invalid: ${outputFinalPath}`);
    }

    this.logger.success(`Master video assembled successfully: ${outputFinalPath} (${probe.width}x${probe.height}, ${probe.duration.toFixed(2)}s, ${(probe.sizeBytes / 1e6).toFixed(2)} MB, audio: ${probe.hasAudio ? probe.audioCodec : 'none'})`);
    return {
      outputFinalPath,
      probe
    };
  }
}

module.exports = { ProductionAssembler };
