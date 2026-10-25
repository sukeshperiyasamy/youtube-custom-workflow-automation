/**
 * YouTube OAuth 2.0 & Data API v3 Authentication Service
 * 
 * Coordinates Google OAuth 2.0 authorization code flow, CSRF state protection,
 * token persistence, channel identity verification, and token revocation.
 */

const { google } = require('googleapis');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Logger } = require('./logger');

const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly'
];

class YouTubeAuthService {
  constructor(options = {}) {
    this.logger = options.logger || new Logger('YouTubeAuth');
    this.clientId = options.clientId || process.env.YOUTUBE_CLIENT_ID || null;
    this.clientSecret = options.clientSecret || process.env.YOUTUBE_CLIENT_SECRET || null;
    this.redirectUri = options.redirectUri || process.env.YOUTUBE_REDIRECT_URI || 'http://127.0.0.1:3456/api/youtube/oauth2callback';
    this.tokenPath = options.tokenPath || process.env.YOUTUBE_TOKEN_PATH || path.join(__dirname, '..', 'data', 'tokens', 'youtube_token.json');
    this.scopes = options.scopes || DEFAULT_SCOPES;

    this.oauth2Client = options.oauth2Client || null;
    this.tokens = null;
    this.activeStates = new Map(); // state -> { expiresAt: number }
  }

  async initialize() {
    this.initOAuth2Client();
    await this.loadTokens();
    return true;
  }

  isConfigured() {
    return Boolean(this.clientId && this.clientSecret);
  }

  hasTokens() {
    return Boolean(this.tokens && (this.tokens.access_token || this.tokens.refresh_token));
  }

  initOAuth2Client() {
    if (this.oauth2Client) return this.oauth2Client;

    if (this.isConfigured()) {
      this.oauth2Client = new google.auth.OAuth2(
        this.clientId,
        this.clientSecret,
        this.redirectUri
      );

      // Listen for token updates (e.g. automatic refresh)
      this.oauth2Client.on('tokens', async (newTokens) => {
        this.logger.info('Received refreshed OAuth tokens from Google');
        this.tokens = {
          ...this.tokens,
          ...newTokens,
          refresh_token: newTokens.refresh_token || this.tokens?.refresh_token
        };
        await this.saveTokens(this.tokens);
      });
    }

    return this.oauth2Client;
  }

  async loadTokens() {
    try {
      if (fsSync.existsSync(this.tokenPath)) {
        const raw = await fs.readFile(this.tokenPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.access_token || parsed.refresh_token)) {
          this.tokens = parsed;
          if (this.oauth2Client) {
            this.oauth2Client.setCredentials(this.tokens);
          }
          this.logger.info('Loaded saved YouTube OAuth tokens from disk');
          return this.tokens;
        }
      }
    } catch (err) {
      this.logger.warn(`Failed to read saved tokens from ${this.tokenPath}: ${err.message}`);
    }
    this.tokens = null;
    return null;
  }

  async saveTokens(tokens) {
    if (!tokens || typeof tokens !== 'object') {
      throw new Error('Invalid token payload to save');
    }
    try {
      const dir = path.dirname(this.tokenPath);
      await fs.mkdir(dir, { recursive: true });
      const serialized = JSON.stringify({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        scope: tokens.scope,
        token_type: tokens.token_type || 'Bearer',
        expiry_date: tokens.expiry_date,
        saved_at: new Date().toISOString()
      }, null, 2);

      await fs.writeFile(this.tokenPath, serialized, 'utf8');
      this.tokens = tokens;
      if (this.oauth2Client) {
        this.oauth2Client.setCredentials(this.tokens);
      }
      this.logger.success(`YouTube OAuth tokens securely stored to ${this.tokenPath}`);
      return true;
    } catch (err) {
      this.logger.error(`Failed to save tokens to ${this.tokenPath}: ${err.message}`);
      throw err;
    }
  }

  generateAuthUrl(customState = null) {
    if (!this.isConfigured()) {
      const err = new Error('Google OAuth Client ID and Secret are not configured in environment (YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET).');
      err.code = 'OAUTH_NOT_CONFIGURED';
      err.status = 503;
      throw err;
    }

    this.initOAuth2Client();

    // Clean up expired states
    const now = Date.now();
    for (const [st, info] of this.activeStates.entries()) {
      if (info.expiresAt < now) this.activeStates.delete(st);
    }

    const state = customState || crypto.randomBytes(24).toString('hex');
    this.activeStates.set(state, { expiresAt: now + 10 * 60 * 1000 }); // 10 minute TTL

    const authUrl = this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // Forces refresh token delivery
      scope: this.scopes,
      state
    });

    return {
      authUrl,
      state,
      redirectUri: this.redirectUri,
      scopes: this.scopes
    };
  }

  validateState(state) {
    if (!state || typeof state !== 'string') return false;
    const record = this.activeStates.get(state);
    if (!record) return false;
    this.activeStates.delete(state); // Single-use CSRF token
    return record.expiresAt >= Date.now();
  }

  async handleCallback(code, state) {
    if (!state || !this.validateState(state)) {
      const err = new Error('Invalid or expired OAuth state parameter (CSRF protection failed).');
      err.code = 'CSRF_STATE_MISMATCH';
      err.status = 400;
      throw err;
    }

    if (!code || typeof code !== 'string') {
      const err = new Error('Missing authorization code from Google OAuth callback.');
      err.code = 'MISSING_AUTH_CODE';
      err.status = 400;
      throw err;
    }

    this.initOAuth2Client();

    try {
      const { tokens } = await this.oauth2Client.getToken(code);
      if (!tokens || (!tokens.access_token && !tokens.refresh_token)) {
        throw new Error('Google returned empty tokens payload.');
      }

      // Preserve existing refresh token if Google didn't return a new one on re-auth
      const mergedTokens = {
        ...tokens,
        refresh_token: tokens.refresh_token || this.tokens?.refresh_token
      };

      await this.saveTokens(mergedTokens);

      return {
        success: true,
        connected: true,
        scope: mergedTokens.scope,
        expiresAt: mergedTokens.expiry_date ? new Date(mergedTokens.expiry_date).toISOString() : null
      };
    } catch (err) {
      this.logger.error(`OAuth token exchange failed: ${err.message}`);
      throw err;
    }
  }

  async getChannelStatus() {
    if (!this.isConfigured()) {
      return {
        configured: false,
        connected: false,
        status: 'unconfigured',
        message: 'YouTube OAuth credentials (YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET) are not configured in environment.',
        redirectUri: this.redirectUri
      };
    }

    if (!this.hasTokens()) {
      return {
        configured: true,
        connected: false,
        status: 'disconnected',
        message: 'No authorized YouTube channel connected. Start OAuth flow to connect.',
        redirectUri: this.redirectUri
      };
    }

    this.initOAuth2Client();

    try {
      const youtube = this.youtubeClient || google.youtube({ version: 'v3', auth: this.oauth2Client });
      const resp = await youtube.channels.list({
        part: 'snippet,statistics',
        mine: true
      });

      const item = resp?.data?.items?.[0];
      if (!item) {
        return {
          configured: true,
          connected: false,
          status: 'channel_not_found',
          message: 'Authenticated account has no associated YouTube channel.'
        };
      }

      // Return clean, safe channel details without tokens or secrets
      return {
        configured: true,
        connected: true,
        status: 'connected',
        channel: {
          id: item.id,
          title: item.snippet?.title || 'Unknown Channel',
          description: item.snippet?.description?.slice(0, 300) || '',
          customUrl: item.snippet?.customUrl || null,
          thumbnailUrl: item.snippet?.thumbnails?.default?.url || null,
          subscriberCount: Number(item.statistics?.subscriberCount || 0),
          videoCount: Number(item.statistics?.videoCount || 0),
          viewCount: Number(item.statistics?.viewCount || 0),
          publishedAt: item.snippet?.publishedAt || null
        },
        grantedScopes: String(this.tokens?.scope || '').split(/\s+/).filter(Boolean),
        expiresAt: this.tokens?.expiry_date ? new Date(this.tokens.expiry_date).toISOString() : null,
        redirectUri: this.redirectUri
      };
    } catch (err) {
      const status = err.response?.status || err.status || 0;
      const isAuthError = status === 401 || err.message?.includes('invalid_grant') || err.message?.includes('invalid_token');

      if (isAuthError) {
        this.logger.warn(`Channel connection check detected expired or revoked token: ${err.message}`);
        return {
          configured: true,
          connected: false,
          status: 'token_expired_or_revoked',
          message: 'Channel authorization has expired or was revoked. Please re-authorize.',
          redirectUri: this.redirectUri
        };
      }

      return {
        configured: true,
        connected: false,
        status: 'network_error',
        message: `Could not verify channel with YouTube API: ${err.message}`,
        redirectUri: this.redirectUri
      };
    }
  }

  async disconnect() {
    if (this.tokens && this.oauth2Client) {
      try {
        const tokenToRevoke = this.tokens.access_token || this.tokens.refresh_token;
        if (tokenToRevoke) {
          await this.oauth2Client.revokeToken(tokenToRevoke);
          this.logger.info('OAuth token revoked successfully with Google');
        }
      } catch (err) {
        this.logger.warn(`Token revocation warning: ${err.message}`);
      }
    }

    if (fsSync.existsSync(this.tokenPath)) {
      try {
        await fs.unlink(this.tokenPath);
        this.logger.info(`Removed local token store: ${this.tokenPath}`);
      } catch (err) {
        this.logger.warn(`Failed to unlink token file: ${err.message}`);
      }
    }

    this.tokens = null;
    if (this.oauth2Client) {
      this.oauth2Client.setCredentials({});
    }

    return {
      success: true,
      connected: false,
      status: 'disconnected',
      message: 'YouTube channel disconnected and stored credentials removed.'
    };
  }

  getYouTubeAuth() {
    if (!this.hasTokens()) {
      const err = new Error('YouTube channel is not connected. Authorize via /api/youtube/auth-url or node cli.js --auth-youtube.');
      err.code = 'YOUTUBE_NOT_AUTHORIZED';
      err.status = 401;
      throw err;
    }
    this.initOAuth2Client();
    return this.oauth2Client;
  }

  getYouTubeClient() {
    const auth = this.getYouTubeAuth();
    return google.youtube({ version: 'v3', auth });
  }
}

module.exports = {
  YouTubeAuthService,
  DEFAULT_SCOPES
};
