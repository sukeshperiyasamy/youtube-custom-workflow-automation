const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { Logger } = require('./logger');

class ComfyUIClient {
  constructor(baseUrlOrOptions = process.env.COMFYUI_URL || 'http://127.0.0.1:8188') {
    const rawUrl = typeof baseUrlOrOptions === 'object' && baseUrlOrOptions !== null
      ? (baseUrlOrOptions.baseUrl || process.env.COMFYUI_URL || 'http://127.0.0.1:8188')
      : String(baseUrlOrOptions || 'http://127.0.0.1:8188');
    this.baseUrl = rawUrl.replace(/\/+$/, '');
    this.logger = new Logger('ComfyUIClient');
    this.comfyDir = path.resolve('D:\\comfyui');
    this.comfyInputDir = path.join(this.comfyDir, 'ComfyUI', 'input');
    this.comfyOutputDir = path.join(this.comfyDir, 'ComfyUI', 'output');
  }

  async _request(method, endpoint, body = null, timeoutMs = 15000) {
    const targetUrl = new URL(this.baseUrl + endpoint);
    const isHttps = targetUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const options = {
        method,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        },
        timeout: timeoutMs
      };

      const req = transport.request(options, res => {
        let rawData = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { rawData += chunk; });
        res.on('end', () => {
          try {
            const parsed = rawData ? JSON.parse(rawData) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              const err = new Error(`ComfyUI error HTTP ${res.statusCode}: ${rawData}`);
              err.statusCode = res.statusCode;
              err.data = parsed;
              reject(err);
            }
          } catch (e) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(rawData);
            } else {
              reject(new Error(`ComfyUI HTTP ${res.statusCode}: ${rawData}`));
            }
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`ComfyUI request timed out after ${timeoutMs}ms for ${endpoint}`));
      });

      req.on('error', err => {
        reject(new Error(`Failed to connect to ComfyUI at ${this.baseUrl}: ${err.message}`));
      });

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  async isAvailable() {
    try {
      const stats = await this._request('GET', '/system_stats', null, 3000);
      return Boolean(stats && stats.system);
    } catch (_error) {
      return false;
    }
  }

  async getSystemStats() {
    return this._request('GET', '/system_stats');
  }

  async getObjectInfo() {
    return this._request('GET', '/object_info');
  }

  async freeMemory() {
    try {
      return await this._request('POST', '/free', { unload_models: true, free_memory: true }, 5000);
    } catch (err) {
      this.logger.warn(`Failed to call /free memory: ${err.message}`);
      return null;
    }
  }

  async queuePrompt(promptDict, clientId = 'youtube_auto_producer') {
    const payload = {
      prompt: promptDict,
      client_id: clientId
    };
    return this._request('POST', '/prompt', payload, 30000);
  }

  async getQueue() {
    return this._request('GET', '/queue');
  }

  async getHistory(promptId = null) {
    const endpoint = promptId ? `/history/${encodeURIComponent(promptId)}` : '/history';
    return this._request('GET', endpoint);
  }

  async cancelPrompt(promptId) {
    try {
      await this._request('POST', '/interrupt', {});
      return true;
    } catch (e) {
      this.logger.warn(`Failed to interrupt prompt: ${e.message}`);
      return false;
    }
  }

  async waitForPrompt(promptId, options = {}) {
    const timeoutMs = options.timeoutMs || 900000;
    const pollIntervalMs = options.pollIntervalMs || 4000;
    const onProgress = options.onProgress || (() => {});
    const startTime = Date.now();

    this.logger.info(`Monitoring ComfyUI prompt ${promptId}...`);

    while (Date.now() - startTime < timeoutMs) {
      if (options.shouldCancel && options.shouldCancel()) {
        await this.cancelPrompt(promptId);
        throw new Error(`Generation of prompt ${promptId} was cancelled by user.`);
      }

      let queueData;
      try {
        queueData = await this.getQueue();
      } catch (e) {
        this.logger.warn(`Polling notice (queue): ${e.message}`);
      }

      const running = queueData?.queue_running || [];
      const pending = queueData?.queue_pending || [];
      const isActive = running.some(item => JSON.stringify(item).includes(promptId)) ||
                       pending.some(item => JSON.stringify(item).includes(promptId));

      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      onProgress({ promptId, elapsedSec, isExecuting: running.some(item => JSON.stringify(item).includes(promptId)) });

      if (!isActive) {
        let historyData;
        try {
          historyData = await this.getHistory(promptId);
        } catch (e) {
          this.logger.warn(`Polling notice (history): ${e.message}`);
        }

        if (historyData && historyData[promptId]) {
          const entry = historyData[promptId];
          const status = entry.status;
          if (status?.status_str === 'error') {
            const errorDetails = status.messages || entry.error || 'Unknown execution error';
            throw new Error(`ComfyUI generation failed for prompt ${promptId}: ${JSON.stringify(errorDetails)}`);
          }

          this.logger.success(`ComfyUI prompt ${promptId} finished successfully in ${elapsedSec}s.`);
          return {
            promptId,
            elapsedSec,
            outputs: entry.outputs || {},
            history: entry
          };
        }
      }

      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    throw new Error(`ComfyUI generation timed out after ${Math.round(timeoutMs / 1000)}s for prompt ${promptId}`);
  }

  copyAssetToInput(srcFilePath, destFilename) {
    if (!fs.existsSync(srcFilePath)) {
      throw new Error(`Source asset not found: ${srcFilePath}`);
    }
    fs.mkdirSync(this.comfyInputDir, { recursive: true });
    const targetPath = path.join(this.comfyInputDir, destFilename);
    fs.copyFileSync(srcFilePath, targetPath);
    return targetPath;
  }

  findOutputFiles(prefixPattern, extension = '.mp4') {
    const results = [];
    if (!fs.existsSync(this.comfyOutputDir)) return results;

    function walk(dir) {
      const files = fs.readdirSync(dir, { withFileTypes: true });
      for (const f of files) {
        const full = path.join(dir, f.name);
        if (f.isDirectory()) {
          walk(full);
        } else if (f.name.endsWith(extension) && f.name.includes(prefixPattern)) {
          results.push(full);
        }
      }
    }

    walk(this.comfyOutputDir);
    results.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return results;
  }
}

module.exports = { ComfyUIClient };