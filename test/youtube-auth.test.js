/**
 * YouTube Custom Workflow Automation - YouTube OAuth & Publishing Safeguards Test Suite
 * 
 * Tests OAuth 2.0 flow, CSRF state protection, token redaction, channel status checks,
 * metadata validation, and upload authorization invariants without making real YouTube API calls.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { YouTubeAuthService } = require('../utils/youtube-auth-service');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');
const { ProductionOrchestrator } = require('../agents/production-orchestrator');
const { assertValidYouTubeMetadata } = require('../utils/youtube-metadata-validator');
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
  console.log('🧪 TEST: YOUTUBE OAUTH, CHANNEL CONNECTION & PUBLISHING SAFEGUARDS');
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

  const tmpTokenPath = path.join(__dirname, 'scratch_test_token.json');
  if (fs.existsSync(tmpTokenPath)) fs.unlinkSync(tmpTokenPath);

  try {
    // 1. Missing OAuth configuration
    await check('Unconfigured YouTube service rejects authUrl creation with 503', () => {
      const authService = new YouTubeAuthService({ clientId: '', clientSecret: '' });
      assert.strictEqual(authService.isConfigured(), false);
      assert.throws(() => {
        authService.generateAuthUrl();
      }, /OAUTH_NOT_CONFIGURED|Client ID and Secret are not configured/);
    });

    // 2. Authorization URL creation & CSRF state
    await check('Configured service generates valid OAuth URL with random CSRF state', () => {
      const authService = new YouTubeAuthService({
        clientId: 'mock-client-id.apps.googleusercontent.com',
        clientSecret: 'mock-client-secret',
        redirectUri: 'http://127.0.0.1:3456/api/youtube/oauth2callback'
      });
      assert.strictEqual(authService.isConfigured(), true);
      const authData = authService.generateAuthUrl();
      assert.ok(authData.authUrl.includes('accounts.google.com'));
      assert.ok(authData.authUrl.includes('mock-client-id.apps.googleusercontent.com'));
      assert.ok(authData.authUrl.includes('access_type=offline'));
      assert.ok(authData.authUrl.includes('prompt=consent'));
      assert.ok(authData.state.length >= 16);
      assert.ok(authService.activeStates.has(authData.state));
    });

    // 3. OAuth state mismatch (CSRF rejection)
    await check('Rejects callback with invalid or expired CSRF state', async () => {
      const authService = new YouTubeAuthService({
        clientId: 'mock-client-id',
        clientSecret: 'mock-secret'
      });
      authService.generateAuthUrl(); // populates a legitimate state
      await assert.rejects(async () => {
        await authService.handleCallback('mock-code', 'forged-or-expired-state');
      }, /CSRF protection failed/);
    });

    // 4. Callback errors handling
    await check('REST API callback handles error parameter gracefully (400)', async () => {
      const engine = new WorkflowEngine({
        youtubeConfig: { clientId: 'mock', clientSecret: 'mock' }
      });
      await engine.initialize();
      const testPort = 3991;
      const app = engine.createApiServer(testPort);
      const server = await new Promise(r => { const s = app.listen(testPort, () => r(s)); });
      try {
        const res = await makeRequest(testPort, 'GET', '/api/youtube/oauth2callback?error=access_denied');
        assert.strictEqual(res.status, 400);
        assert.ok(String(res.data).includes('Authorization Rejected or Cancelled'));
      } finally {
        await new Promise(r => server.close(r));
      }
    });

    // 5. Successful mocked token exchange
    await check('Exchanges valid code for tokens and persists safely', async () => {
      const mockOAuthClient = {
        generateAuthUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
        getToken: async (code) => {
          assert.strictEqual(code, 'legit-code');
          return {
            tokens: {
              access_token: 'mock-access-token-12345',
              refresh_token: 'mock-refresh-token-67890',
              scope: 'https://www.googleapis.com/auth/youtube.upload',
              expiry_date: Date.now() + 3600000
            }
          };
        },
        setCredentials: () => {},
        on: () => {}
      };

      const authService = new YouTubeAuthService({
        clientId: 'mock-client-id',
        clientSecret: 'mock-client-secret',
        tokenPath: tmpTokenPath,
        oauth2Client: mockOAuthClient
      });

      const { state } = authService.generateAuthUrl();
      const result = await authService.handleCallback('legit-code', state);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.connected, true);
      assert.strictEqual(fs.existsSync(tmpTokenPath), true);

      const savedContent = JSON.parse(fs.readFileSync(tmpTokenPath, 'utf8'));
      assert.strictEqual(savedContent.access_token, 'mock-access-token-12345');
      assert.strictEqual(savedContent.refresh_token, 'mock-refresh-token-67890');
    });

    // 6. Token refresh failure handling
    await check('Detects expired/revoked refresh token and marks as disconnected', async () => {
      const authService = new YouTubeAuthService({
        clientId: 'mock-client-id',
        clientSecret: 'mock-secret',
        tokenPath: tmpTokenPath
      });
      await authService.initialize();

      // Mock client that returns 401 invalid_grant
      authService.youtubeClient = {
        channels: {
          list: async () => {
            const err = new Error('invalid_grant: Token has been expired or revoked');
            err.status = 401;
            throw err;
          }
        }
      };
      const status = await authService.getChannelStatus();
      assert.strictEqual(status.connected, false);
      assert.strictEqual(status.status, 'token_expired_or_revoked');
    });

    // 7. Disconnected channel status
    await check('Reports disconnected status when no tokens are present', async () => {
      if (fs.existsSync(tmpTokenPath)) fs.unlinkSync(tmpTokenPath);
      const authService = new YouTubeAuthService({
        clientId: 'mock-client-id',
        clientSecret: 'mock-secret',
        tokenPath: tmpTokenPath
      });
      await authService.initialize();
      const status = await authService.getChannelStatus();
      assert.strictEqual(status.configured, true);
      assert.strictEqual(status.connected, false);
      assert.strictEqual(status.status, 'disconnected');
    });

    // 8. Token redaction in status and responses
    await check('Channel status strictly redacts all tokens and client secrets', async () => {
      const authService = new YouTubeAuthService({
        clientId: 'mock-id-secret-sensitive',
        clientSecret: 'super-sensitive-secret-999',
        tokenPath: tmpTokenPath
      });
      authService.tokens = {
        access_token: 'secret-access-token-abc',
        refresh_token: 'secret-refresh-token-xyz',
        scope: 'youtube.upload'
      };
      const status = await authService.getChannelStatus();
      const statusJson = JSON.stringify(status);
      assert.strictEqual(statusJson.includes('secret-access-token-abc'), false);
      assert.strictEqual(statusJson.includes('secret-refresh-token-xyz'), false);
      assert.strictEqual(statusJson.includes('super-sensitive-secret-999'), false);
    });

    // 9. Missing / invalid video paths
    await check('Publishing agent rejects nonexistent or non-MP4 video files', async () => {
      const agent = new PublishingSchedulingAgent({}, {});
      await assert.rejects(async () => {
        await agent.getVideoStream('does_not_exist_file.mp4');
      }, /video file not found/);

      const fakeTxt = path.join(__dirname, 'temp_fake.txt');
      fs.writeFileSync(fakeTxt, 'dummy');
      try {
        await assert.rejects(async () => {
          await agent.getVideoStream(fakeTxt);
        }, /video file not found — refusing to upload placeholder/);
      } finally {
        fs.unlinkSync(fakeTxt);
      }
    });

    // 10. Invalid metadata handling
    await check('Rejects empty or oversized YouTube metadata', () => {
      assert.throws(() => {
        assertValidYouTubeMetadata({ title: '' });
      }, /A video title is required/);

      assert.throws(() => {
        assertValidYouTubeMetadata({ title: 'A'.repeat(105) });
      }, /Title exceeds 100 characters/);
    });

    // 11. Upload authorization failure
    await check('Rejects video upload with 401 when YouTube channel is disconnected', async () => {
      const mockDb = {
        getPublishQueue: async () => [],
        updateScheduleEntry: async () => {}
      };
      const authService = new YouTubeAuthService({ clientId: '', clientSecret: '' });
      const agent = new PublishingSchedulingAgent(mockDb, authService);
      await agent.initialize();

      const testVideo = path.join(__dirname, 'valid_test.mp4');
      fs.writeFileSync(testVideo, 'mock-mp4-data');
      try {
        await assert.rejects(async () => {
          await agent.uploadToYouTube({
            metadata: {
              seo: { title: 'Test Video', description: 'Desc', tags: ['one', 'two', 'three'] },
              video: { path: testVideo },
              audio: { intentionalSilence: true, silenceReason: 'Cinematic soundtrack embedded', silenceConfirmedAt: new Date().toISOString() }
            }
          });
        }, /YouTube channel is not connected/);
      } finally {
        fs.unlinkSync(testVideo);
      }
    });

    // 12. Upload failure and retry behavior (reconciliation required)
    await check('Flags status reconciliation_required on 5xx network timeout', async () => {
      let savedStatus = null;
      let savedError = null;
      const mockDb = {
        getPublishQueue: async () => [],
        updateScheduleEntry: async (entry) => {
          savedStatus = entry.status;
          savedError = entry.error;
        }
      };

      const testVideo = path.join(__dirname, 'valid_test2.mp4');
      fs.writeFileSync(testVideo, 'mock-mp4-data');
      try {
        const agent = new PublishingSchedulingAgent(mockDb, {
          getYouTubeAuth: () => ({})
        });
        agent.youtube = {
          videos: {
            insert: async () => {
              const err = new Error('Google 503 Service Unavailable');
              err.status = 503;
              throw err;
            }
          }
        };

        const scheduleEntry = {
          productionId: 'prod-retry-test',
          metadata: {
            seo: { title: 'Retry Test Video', description: 'Desc', tags: ['one', 'two', 'three'] },
            video: { path: testVideo },
            audio: { intentionalSilence: true, silenceReason: 'Cinematic soundtrack embedded', silenceConfirmedAt: new Date().toISOString() }
          }
        };
        agent.publishQueue = [scheduleEntry];

        await assert.rejects(async () => {
          await agent.publishContent('prod-retry-test');
        }, /UPLOAD_OUTCOME_UNKNOWN|Upload outcome is unknown/);

        assert.strictEqual(savedStatus, 'reconciliation_required');
      } finally {
        await new Promise(r => setImmediate(r));
        if (fs.existsSync(testVideo)) fs.unlinkSync(testVideo);
      }
    });

    // 13. Rights confirmation enforcement
    await check('Approval rejects with HTTP 409 when confirmRights is false', async () => {
      const mockDb = {
        getGenerationJob: async (id) => ({
          id,
          status: 'awaiting_approval',
          details: {
            qualityEval: { passed: true, score: 95, blockingFailures: [] }
          }
        })
      };
      const orchestrator = new ProductionOrchestrator({ db: mockDb });
      await assert.rejects(async () => {
        await orchestrator.approveAndPublish('job-1', {}, { confirmRights: false });
      }, /Confirm the factual review and media rights checks before approval/);
    });

    // 14. Private-by-default upload configuration
    await check('Upload metadata enforces private visibility by default', async () => {
      let capturedStatus = null;
      const testVideo = path.join(__dirname, 'valid_test3.mp4');
      fs.writeFileSync(testVideo, 'mock-mp4-data');
      try {
        const agent = new PublishingSchedulingAgent({}, { getYouTubeAuth: () => ({}) });
        agent.youtube = {
          videos: {
            insert: async ({ requestBody }) => {
              capturedStatus = requestBody.status;
              return { data: { id: 'mock-uploaded-id-123' } };
            }
          }
        };

        const result = await agent.uploadToYouTube({
          metadata: {
            seo: { title: 'Private Video Test', description: 'Desc', tags: ['one', 'two', 'three'] },
            video: { path: testVideo }
          }
        });

        assert.strictEqual(result.id, 'mock-uploaded-id-123');
        assert.strictEqual(capturedStatus.privacyStatus, 'private');
      } finally {
        await new Promise(r => setImmediate(r));
        if (fs.existsSync(testVideo)) fs.unlinkSync(testVideo);
      }
    });

    // 15. No upload without explicit approved job state
    await check('Rejects approval of draft or unverified jobs with HTTP 409', async () => {
      const mockDb = {
        getGenerationJob: async (id) => ({ id, status: 'draft' })
      };
      const orchestrator = new ProductionOrchestrator({ db: mockDb });
      await assert.rejects(async () => {
        await orchestrator.approveAndPublish('job-draft', {}, { confirmRights: true });
      }, /Cannot approve job in status 'draft'/);
    });

  } finally {
    if (fs.existsSync(tmpTokenPath)) fs.unlinkSync(tmpTokenPath);
  }

  console.log(`\n════════════════════════════════════════════════════════════`);
  console.log(`📊 YouTube Auth & Safeguards Test Results: ${passed} passed, ${failed} failed`);
  console.log(`════════════════════════════════════════════════════════════\n`);

  if (failed > 0) process.exit(1);
}

if (require.main === module) {
  run().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
  });
}

module.exports = { run };
