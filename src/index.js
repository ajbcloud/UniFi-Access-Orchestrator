/**
 * UniFi Access Orchestrator
 * 
 * Express server with admin GUI dashboard.
 * 
 * API Endpoints:
 *   POST /webhook              - Receives events (Alarm Manager or API webhook)
 *   GET  /health               - Service health + stats
 *   POST /test/unlock/:door    - Manual test unlock
 *   POST /test/event           - Simulate an event through the rules engine
 *   POST /reload               - Reload config without restart
 *   GET  /api/config           - Current running config (sanitized)
 *   PUT  /api/config           - Save config changes
 *   GET  /api/doors            - Discovered doors
 *   GET  /api/users            - Cached user-to-group map
 *   POST /api/sync             - Force user group re-sync
 *   GET  /api/events/stream    - SSE stream for live event feed
 *   GET  /api/events/history   - Recent event history (in-memory)
 * 
 * GUI:
 *   GET  /                     - Admin dashboard (served from /public)
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const UniFiClient = require('./unifi-client');
const Resolver = require('./resolver');
const RulesEngine = require('./rules-engine');

// ---------------------------------------------------------------------------
// Load config
// ---------------------------------------------------------------------------

const CONFIG_PATH = process.env.MIDDLEWARE_CONFIG_PATH || process.env.CONFIG_PATH || path.resolve(__dirname, '../config/config.json');

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  return JSON.parse(raw);
}

let config = loadConfig();

// ---------------------------------------------------------------------------
// Initialize components
// ---------------------------------------------------------------------------

let unifiClient = new UniFiClient(config);
let resolver = new Resolver(config, unifiClient);
let rulesEngine = new RulesEngine(config, unifiClient, resolver);

// ---------------------------------------------------------------------------
// Event history + SSE clients
// ---------------------------------------------------------------------------

const EVENT_HISTORY_MAX = 200;
const eventHistory = [];
const sseClients = new Set();

function broadcastEvent(eventData) {
  const entry = {
    id: Date.now(),
    timestamp: new Date().toISOString(),
    ...eventData
  };
  eventHistory.unshift(entry);
  if (eventHistory.length > EVENT_HISTORY_MAX) {
    eventHistory.length = EVENT_HISTORY_MAX;
  }
  for (const client of sseClients) {
    client.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
}

// Patch the rules engine to broadcast events to the GUI
const origHandleEvent = rulesEngine.handleEvent.bind(rulesEngine);
rulesEngine.handleEvent = async function(rawPayload) {
  const beforeStats = { ...this.getStats() };
  await origHandleEvent(rawPayload);
  const afterStats = this.getStats();

  // Broadcast to GUI
  broadcastEvent({
    type: afterStats.last_event?.type || 'unknown',
    actor: afterStats.last_event?.actor || 'unknown',
    location: afterStats.last_event?.location || 'unknown',
    device: afterStats.last_event?.device || null,
    action: afterStats.unlocks_triggered > beforeStats.unlocks_triggered
      ? `Unlocked: ${afterStats.last_unlock?.door || 'unknown'}`
      : afterStats.events_skipped_self > beforeStats.events_skipped_self
        ? 'Skipped (self-triggered)'
        : afterStats.events_skipped_location > beforeStats.events_skipped_location
          ? 'Skipped (wrong location)'
          : afterStats.events_skipped_no_action > beforeStats.events_skipped_no_action
            ? 'No action needed'
            : 'Processed',
    success: afterStats.unlocks_failed <= beforeStats.unlocks_failed,
    unlock_door: afterStats.last_unlock?.door || null,
    unlock_reason: afterStats.last_unlock?.reason || null
  });
};

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

function timingSafeCompare(a, b) {
  const aBuf = Buffer.from(a || '', 'utf8');
  const bBuf = Buffer.from(b || '', 'utf8');

  if (aBuf.length !== bBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(aBuf, bBuf);
}

function requireAdminApiKey(req, res, next) {
  const expectedApiKey = config.server?.admin_api_key;
  if (!expectedApiKey) {
    return next();
  }

  const providedApiKey = req.get('x-api-key');
  if (!timingSafeCompare(providedApiKey, expectedApiKey)) {
    logger.warn(`Blocked unauthorized request: ${req.method} ${req.path}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

// Serve static GUI files
app.use(express.static(path.resolve(__dirname, '../public')));

// Request logging (skip health checks and static files)
app.use((req, res, next) => {
  if (req.path !== '/health' && !req.path.startsWith('/css') && !req.path.startsWith('/js') && req.path !== '/favicon.ico') {
    logger.debug(`${req.method} ${req.path}`);
  }
  next();
});

app.use('/api', requireAdminApiKey);
app.use('/reload', requireAdminApiKey);
app.use('/test', requireAdminApiKey);

// ---------------------------------------------------------------------------
// POST /webhook
// ---------------------------------------------------------------------------

app.post('/webhook', async (req, res) => {
  const webhookSecret = config.event_source?.api_webhook?.secret;
  if (webhookSecret) {
    const signatureHeader = req.get('x-orchestrator-signature') || '';
    const expectedSignature = `sha256=${crypto.createHmac('sha256', webhookSecret).update(req.rawBody || '').digest('hex')}`;
    if (!timingSafeCompare(signatureHeader, expectedSignature)) {
      logger.warn('Rejected webhook with invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    logger.warn('Webhook received empty or invalid payload');
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const eventType = payload.event || payload.type || payload.event_type || 'unknown';
  logger.info(`Webhook received: ${eventType}`);
  logger.debug(`Webhook payload: ${JSON.stringify(payload).substring(0, 500)}`);

  try {
    await rulesEngine.handleEvent(payload);
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    logger.error(`Error processing webhook: ${err.message}`);
    res.status(500).json({ error: 'Processing failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({
    status: 'running',
    uptime_seconds: Math.floor(process.uptime()),
    event_source: config.event_source?.mode || 'alarm_manager',
    unifi: unifiClient.getStatus(),
    engine: rulesEngine.getStats(),
    memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 10) / 10
  });
});

// ---------------------------------------------------------------------------
// GET /api/events/stream - SSE for live events
// ---------------------------------------------------------------------------

app.get('/api/events/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ---------------------------------------------------------------------------
// GET /api/events/history - Recent events
// ---------------------------------------------------------------------------

app.get('/api/events/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, EVENT_HISTORY_MAX);
  res.json(eventHistory.slice(0, limit));
});

// ---------------------------------------------------------------------------
// POST /test/unlock/:door
// ---------------------------------------------------------------------------

app.post('/test/unlock/:door', async (req, res) => {
  const doorName = decodeURIComponent(req.params.door);
  logger.info(`Manual test unlock requested: "${doorName}"`);
  const result = await unifiClient.unlockDoorByName(doorName, 'manual test (GUI)');

  broadcastEvent({
    type: 'test.unlock',
    actor: 'GUI Admin',
    location: doorName,
    action: result.success ? `Unlocked: ${doorName}` : `Failed: ${result.error}`,
    success: result.success,
    unlock_door: doorName
  });

  res.json(result);
});

// ---------------------------------------------------------------------------
// POST /test/event
// ---------------------------------------------------------------------------

app.post('/test/event', async (req, res) => {
  const { user_id, user_name, location, event_type, reason_code, device_name } = req.body;
  if (!location) {
    return res.status(400).json({ error: 'location is required' });
  }

  const synthetic = {
    event: event_type || 'access.door.unlock',
    event_object_id: `test-${Date.now()}`,
    data: {
      location: { id: `test-loc-${Date.now()}`, location_type: 'door', name: location },
      device: { name: device_name || 'Test Device', device_type: 'TEST' },
      actor: user_id ? { id: user_id, name: user_name || 'Test User', type: 'user' } : null,
      object: {
        authentication_type: event_type === 'access.doorbell.completed' ? 'CALL' : 'NFC',
        policy_id: '', policy_name: '', result: 'Access Granted',
        reason_code: reason_code !== undefined ? parseInt(reason_code) : undefined
      }
    }
  };

  logger.info(`Simulating event: type=${synthetic.event} at "${location}"`);

  try {
    await rulesEngine.handleEvent(synthetic);
    res.json({ status: 'ok', simulated_event: synthetic.event });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /reload
// ---------------------------------------------------------------------------

app.post('/reload', async (req, res) => {
  logger.info('Config reload requested');
  try {
    const newConfig = loadConfig();
    unifiClient.shutdown();
    unifiClient = new UniFiClient(newConfig);
    resolver = new Resolver(newConfig, unifiClient);
    rulesEngine = new RulesEngine(newConfig, unifiClient, resolver);

    // Re-patch the event handler for SSE broadcasting
    const newOrigHandler = rulesEngine.handleEvent.bind(rulesEngine);
    rulesEngine.handleEvent = async function(rawPayload) {
      const before = { ...this.getStats() };
      await newOrigHandler(rawPayload);
      const after = this.getStats();
      broadcastEvent({
        type: after.last_event?.type || 'unknown',
        actor: after.last_event?.actor || 'unknown',
        location: after.last_event?.location || 'unknown',
        action: after.unlocks_triggered > before.unlocks_triggered
          ? `Unlocked: ${after.last_unlock?.door}` : 'Processed',
        success: after.unlocks_failed <= before.unlocks_failed
      });
    };

    await unifiClient.initialize();
    config = newConfig;

    broadcastEvent({ type: 'system.reload', actor: 'GUI Admin', location: '-', action: 'Config reloaded', success: true });
    logger.info('Config reloaded successfully');
    res.json({ status: 'reloaded' });
  } catch (err) {
    logger.error(`Config reload failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/config
// ---------------------------------------------------------------------------

app.get('/api/config', (req, res) => {
  const sanitized = JSON.parse(JSON.stringify(config));
  if (sanitized.unifi?.token) sanitized.unifi.token = '***REDACTED***';
  res.json(sanitized);
});

// ---------------------------------------------------------------------------
// PUT /api/config - Save config changes
// ---------------------------------------------------------------------------

app.put('/api/config', async (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Invalid config data' });
  }

  try {
    // Read current config (with real token)
    const current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

    // Deep merge updates (only allow specific safe keys)
    const safeKeys = ['unlock_rules', 'doorbell_rules', 'event_source', 'logging', 'server', 'unifi', 'resolver', 'doors'];

    // recursive merge for plain objects: source values override primitives/arrays
    function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
    function deepMerge(target, source) {
      if (!isPlainObject(source)) return source;
      if (!isPlainObject(target)) target = {};
      for (const k of Object.keys(source)) {
        const sv = source[k];
        if (isPlainObject(sv)) {
          target[k] = deepMerge(target[k], sv);
        } else {
          target[k] = sv;
        }
      }
      return target;
    }

    for (const key of safeKeys) {
      if (updates[key] !== undefined) {
        if (isPlainObject(updates[key]) && isPlainObject(current[key])) {
          current[key] = deepMerge(current[key], updates[key]);
        } else {
          current[key] = updates[key];
        }
      }
    }

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2));
    logger.info('Config saved to disk');

    // Auto-reload the service to apply changes immediately
    try {
      const newConfig = loadConfig();
      unifiClient.shutdown();
      unifiClient = new UniFiClient(newConfig);
      resolver = new Resolver(newConfig, unifiClient);
      rulesEngine = new RulesEngine(newConfig, unifiClient, resolver);

      // Re-patch the event handler for SSE broadcasting
      const newOrigHandler = rulesEngine.handleEvent.bind(rulesEngine);
      rulesEngine.handleEvent = async function(rawPayload) {
        const before = { ...this.getStats() };
        await newOrigHandler(rawPayload);
        const after = this.getStats();
        broadcastEvent({
          type: after.last_event?.type || 'unknown',
          actor: after.last_event?.actor || 'unknown',
          location: after.last_event?.location || 'unknown',
          action: after.unlocks_triggered > before.unlocks_triggered
            ? `Unlocked: ${after.last_unlock?.door}` : 'Processed',
          success: after.unlocks_failed <= before.unlocks_failed
        });
      };

      await unifiClient.initialize();
      config = newConfig;
      broadcastEvent({ type: 'system.config_reload', actor: 'API', location: '-', action: 'Config reloaded', success: true });
      logger.info('Config reloaded automatically');
    } catch (reloadErr) {
      logger.warn(`Auto-reload after config save failed: ${reloadErr.message}`);
      // Return success anyway; user can click Reload Service manually
    }

    res.json({ status: 'saved', note: 'Config applied automatically' });
  } catch (err) {
    logger.error(`Config save failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/docs - Serve README content for in-app documentation
// ---------------------------------------------------------------------------

app.get('/api/docs', (req, res) => {
  const readmeCandidates = [
    path.resolve(__dirname, '../README.md'),
    path.resolve(process.resourcesPath || '', 'README.md')
  ];

  for (const candidate of readmeCandidates) {
    if (fs.existsSync(candidate)) {
      const content = fs.readFileSync(candidate, 'utf-8');
      return res.json({ content });
    }
  }

  res.json({ content: '# Documentation\n\nREADME file not found. Visit https://github.com/ajbcloud/UniFi-Access-Orchestrator for documentation.' });
});

// ---------------------------------------------------------------------------
// GET /api/test-connection - Test connectivity to Access Gateway
// ---------------------------------------------------------------------------

app.get('/api/test-connection', async (req, res) => {
  const net = require('net');
  const https = require('https');
  const results = {
    host: config.unifi?.host || '',
    port: config.unifi?.port || 12445,
    steps: []
  };

  if (!results.host) {
    results.steps.push({ name: 'Configuration', status: 'fail', detail: 'No Access Gateway IP configured. Go to File > Connection Settings.' });
    return res.json(results);
  }

  // Step 1: DNS / IP resolution
  results.steps.push({ name: 'IP Address', status: 'ok', detail: results.host });

  // Step 2: TCP connectivity to port
  const tcpResult = await new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(5000);
    socket.on('connect', () => { socket.destroy(); resolve({ status: 'ok', detail: `Port ${results.port} is reachable` }); });
    socket.on('timeout', () => { socket.destroy(); resolve({ status: 'fail', detail: `Connection timed out on port ${results.port}. The Access Gateway may be offline or on a different network.` }); });
    socket.on('error', (err) => { socket.destroy(); resolve({ status: 'fail', detail: `Cannot reach port ${results.port}: ${err.message}` }); });
    socket.connect(results.port, results.host);
  });
  results.steps.push({ name: 'Network Connectivity', ...tcpResult });

  if (tcpResult.status === 'fail') {
    return res.json(results);
  }

  // Step 3: HTTPS / API response
  const apiResult = await new Promise((resolve) => {
    const req = https.get(`https://${results.host}:${results.port}/api/v1/developer/doors`, {
      rejectUnauthorized: false,
      timeout: 10000,
      headers: config.unifi?.token ? { 'Authorization': `Bearer ${config.unifi.token}` } : {}
    }, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        if (apiRes.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            const doorCount = parsed.data?.length || 0;
            resolve({ status: 'ok', detail: `API responding. Found ${doorCount} door${doorCount !== 1 ? 's' : ''}.` });
          } catch {
            resolve({ status: 'ok', detail: 'API responding (could not parse door list).' });
          }
        } else if (apiRes.statusCode === 401 || apiRes.statusCode === 403) {
          resolve({ status: 'fail', detail: `API reachable but authentication failed (HTTP ${apiRes.statusCode}). Check your API token.` });
        } else {
          resolve({ status: 'warn', detail: `API returned HTTP ${apiRes.statusCode}. The Access application may not be running.` });
        }
      });
    });
    req.on('error', (err) => resolve({ status: 'fail', detail: `HTTPS request failed: ${err.message}` }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 'fail', detail: 'API request timed out after 10 seconds.' }); });
  });
  results.steps.push({ name: 'Access API', ...apiResult });

  // Step 4: User groups (if API is working)
  if (apiResult.status === 'ok') {
    const userResult = await new Promise((resolve) => {
      const req = https.get(`https://${results.host}:${results.port}/api/v1/developer/users`, {
        rejectUnauthorized: false,
        timeout: 10000,
        headers: { 'Authorization': `Bearer ${config.unifi.token}` }
      }, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
          if (apiRes.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              const userCount = parsed.data?.length || 0;
              resolve({ status: 'ok', detail: `Found ${userCount} user${userCount !== 1 ? 's' : ''}.` });
            } catch {
              resolve({ status: 'ok', detail: 'Users endpoint responding.' });
            }
          } else {
            resolve({ status: 'warn', detail: `Users endpoint returned HTTP ${apiRes.statusCode}.` });
          }
        });
      });
      req.on('error', (err) => resolve({ status: 'warn', detail: `Users request failed: ${err.message}` }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 'warn', detail: 'Users request timed out.' }); });
    });
    results.steps.push({ name: 'User Groups', ...userResult });
  }

  res.json(results);
});

// ---------------------------------------------------------------------------
// GET /api/discover - Scan local network for UniFi controllers
// ---------------------------------------------------------------------------

app.get('/api/discover', async (req, res) => {
  const net = require('net');
  const os = require('os');
  const https = require('https');

  logger.info('Network discovery started');

  // Get all local network interfaces to determine subnets to scan
  const interfaces = os.networkInterfaces();
  const subnets = new Set();

  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        // Extract the /24 subnet base (e.g. 192.168.1.x -> 192.168.1)
        const parts = addr.address.split('.');
        subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
      }
    }
  }

  if (subnets.size === 0) {
    return res.json({ controllers: [], message: 'No network interfaces found' });
  }

  const port = 12445;
  const timeout = 1500; // ms per connection attempt
  const found = [];

  // Scan function: try to TCP connect to port 12445
  function probe(ip) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeout);

      socket.on('connect', () => {
        socket.destroy();
        resolve(ip);
      });

      socket.on('timeout', () => { socket.destroy(); resolve(null); });
      socket.on('error', () => { socket.destroy(); resolve(null); });

      socket.connect(port, ip);
    });
  }

  // For each subnet, scan common controller IPs first, then the rest
  // Priority IPs: .1, .2, .10, .20, .100, .200, .254 (common for gateways/controllers)
  // Then scan the rest in batches
  const priorityOctets = [1, 2, 10, 20, 50, 100, 150, 200, 210, 220, 250, 254];

  for (const subnet of subnets) {
    // Phase 1: Priority IPs (fast)
    const priorityIps = priorityOctets.map(o => `${subnet}.${o}`);
    const priorityResults = await Promise.all(priorityIps.map(probe));

    for (const ip of priorityResults) {
      if (ip) {
        // Try to get device info
        const info = await getControllerInfo(ip, port);
        found.push({ ip, port, ...info });
      }
    }

    // Phase 2: Scan remaining IPs in batches of 30
    const remaining = [];
    for (let i = 1; i <= 254; i++) {
      if (!priorityOctets.includes(i)) {
        remaining.push(`${subnet}.${i}`);
      }
    }

    for (let batch = 0; batch < remaining.length; batch += 30) {
      const chunk = remaining.slice(batch, batch + 30);
      const results = await Promise.all(chunk.map(probe));
      for (const ip of results) {
        if (ip) {
          const info = await getControllerInfo(ip, port);
          found.push({ ip, port, ...info });
        }
      }
    }
  }

  logger.info(`Discovery complete: found ${found.length} controller(s) on ${subnets.size} subnet(s)`);
  res.json({ controllers: found, subnets_scanned: [...subnets] });
});

// Try to identify a UniFi controller by hitting its API
function getControllerInfo(ip, port) {
  const https = require('https');
  return new Promise((resolve) => {
    const req = https.get(`https://${ip}:${port}/api/v1/developer/doors`, {
      rejectUnauthorized: false,
      timeout: 3000,
      headers: { 'Authorization': 'Bearer test' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Even with a bad token, if we get a JSON response it's a UniFi Access API
        const isAccess = res.statusCode === 401 || res.statusCode === 403 || 
                         (res.statusCode === 200 && data.includes('"code"'));
        resolve({
          confirmed: isAccess,
          status_code: res.statusCode,
          type: isAccess ? 'UniFi Access Controller' : 'Unknown service on port ' + port
        });
      });
    });
    req.on('error', () => resolve({ confirmed: false, type: 'Connection failed' }));
    req.on('timeout', () => { req.destroy(); resolve({ confirmed: false, type: 'Timeout' }); });
  });
}

// ---------------------------------------------------------------------------
// GET /api/doors
// ---------------------------------------------------------------------------

app.get('/api/doors', (req, res) => {
  res.json({
    discovered: Object.fromEntries(unifiClient.doors),
    configured: config.doors
  });
});

// ---------------------------------------------------------------------------
// GET /api/users
// ---------------------------------------------------------------------------

app.get('/api/users', (req, res) => {
  const users = [];
  for (const [userId, group] of unifiClient.userGroupMap) {
    users.push({ id: userId, name: unifiClient.getUserName(userId) || 'unknown', group });
  }
  res.json({ count: users.length, users });
});

// ---------------------------------------------------------------------------
// GET /api/groups/discovered
// ---------------------------------------------------------------------------

app.get('/api/groups/discovered', (req, res) => {
  const groups = unifiClient.getDiscoveredGroups();
  const users = unifiClient.getDiscoveredUsers();
  res.json({ groups, users });
});

// ---------------------------------------------------------------------------
// POST /api/sync
// ---------------------------------------------------------------------------

app.post('/api/sync', async (req, res) => {
  logger.info('Manual user group sync requested');
  await unifiClient.syncUserGroups();
  broadcastEvent({ type: 'system.sync', actor: 'GUI Admin', location: '-', action: `Synced ${unifiClient.userGroupMap.size} users`, success: true });
  res.json({ status: 'synced', users_mapped: unifiClient.userGroupMap.size });
});

// ---------------------------------------------------------------------------
// Fallback: serve GUI for all non-API routes
// ---------------------------------------------------------------------------

app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../public/index.html'));
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start() {
  logger.info('=== UniFi Access Orchestrator Starting ===');
  logger.info(`Event source mode: ${config.event_source?.mode || 'alarm_manager'}`);

  const port = config.server?.port || 3000;
  const host = config.server?.host || '0.0.0.0';

  app.listen(port, host, () => {
    logger.info(`Server listening on ${host}:${port}`);
    logger.info(`Dashboard: http://${host}:${port}`);
    logger.info(`Webhook: http://${host}:${port}/webhook`);
    logger.info('=== Orchestrator Ready ===');
  });

  const initialized = await unifiClient.initialize();
  if (!initialized) {
    logger.error('UniFi client initialization failed. Server will start but unlocks will fail until connectivity is restored.');
  }

  const mode = config.event_source?.mode || 'alarm_manager';
  if (mode === 'api_webhook') {
    const webhookConfig = config.event_source.api_webhook;
    if (webhookConfig) {
      const result = await unifiClient.registerWebhookEndpoint(webhookConfig);
      if (result.success) logger.info(`API webhook ${result.existing ? 'already registered' : 'registered successfully'}`);
      else logger.error(`API webhook registration failed: ${result.error}`);
    }
  } else if (mode === 'websocket') {
    const reconnectSec = config.event_source.websocket?.reconnect_interval_seconds || 5;
    unifiClient.connectWebSocket((event) => {
      rulesEngine.handleEvent(event).catch(err => logger.error(`WebSocket event error: ${err.message}`));
    }, reconnectSec);
  }
}

// ---------------------------------------------------------------------------
// Export for Electron (require as module) or run standalone
// ---------------------------------------------------------------------------

module.exports = { start, app };

// If run directly (node src/index.js), start immediately
// If required by Electron, it will call start() when ready
if (require.main === module) {
  process.on('SIGTERM', () => { logger.info('SIGTERM'); unifiClient.shutdown(); process.exit(0); });
  process.on('SIGINT', () => { logger.info('SIGINT'); unifiClient.shutdown(); process.exit(0); });
  process.on('uncaughtException', (err) => { logger.error(`Uncaught: ${err.message}\n${err.stack}`); });
  process.on('unhandledRejection', (reason) => { logger.error(`Unhandled rejection: ${reason}`); });

  start().catch(err => { logger.error(`Fatal: ${err.message}`); process.exit(1); });
}
