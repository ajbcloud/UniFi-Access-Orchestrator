#!/usr/bin/env node

/**
 * UniFi Access Orchestrator - Validation Tool
 * 
 * Run before deploying the orchestrator to verify API connectivity,
 * discover door IDs, list user groups/members, and test unlocks.
 * 
 * Usage:
 *   npm run validate                  # Run all checks
 *   npm run validate -- --doors       # Discover doors only
 *   npm run validate -- --users       # List users/groups only
 *   npm run validate -- --unlock DOOR # Test-unlock a door by name
 *   npm run validate -- --webhooks    # List registered webhook endpoints
 *   npm run validate -- --register    # Register API webhook endpoint
 * 
 * API endpoints used:
 *   GET  /doors                        (section 7.8)
 *   PUT  /doors/:id/unlock             (section 7.9)
 *   GET  /user_groups                  (section 3.12)
 *   GET  /user_groups/:id/users/all    (section 3.19)
 *   GET  /users?expand[]=access_policy (section 3.5)
 *   GET  /webhooks/endpoints           (section 11.3)
 *   POST /webhooks/endpoints           (section 11.4)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.resolve(__dirname, '../config/config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

const BASE_URL = `https://${config.unifi.host}:${config.unifi.port}/api/v1/developer`;
const TOKEN = config.unifi.token;
const VERIFY_SSL = config.unifi.verify_ssl;

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function apiRequest(method, apiPath, body = null) {
  const url = `${BASE_URL}${apiPath}`;

  return new Promise((resolve, reject) => {
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      rejectUnauthorized: VERIFY_SSL
    };

    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, body: parsed });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Request timeout')));

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Validation functions
// ---------------------------------------------------------------------------

async function testConnectivity() {
  console.log('\n=== API Connectivity Test ===');
  console.log(`Target: ${BASE_URL}`);

  try {
    const result = await apiRequest('GET', '/doors');
    if (result.body.code === 'SUCCESS') {
      console.log('  PASS: API connection successful');
      return true;
    } else {
      console.log(`  FAIL: API returned code "${result.body.code}" - ${result.body.msg}`);
      return false;
    }
  } catch (err) {
    console.log(`  FAIL: ${err.message}`);
    if (err.code === 'ECONNREFUSED') {
      console.log('  Hint: Is the Access Gateway reachable? Check host/port in config.json');
    }
    if (err.code === 'CERT_HAS_EXPIRED' || err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
      console.log('  Hint: Set verify_ssl to false in config.json for self-signed certs');
    }
    return false;
  }
}

async function discoverDoors() {
  console.log('\n=== Door Discovery (GET /doors) ===');

  const result = await apiRequest('GET', '/doors');
  const doors = Array.isArray(result.body.data) ? result.body.data : [];

  if (doors.length === 0) {
    console.log('  No doors found. Check that Door Hubs are adopted.');
    return;
  }

  console.log(`  Found ${doors.length} doors:\n`);
  console.log('  Name                          | ID                                   | Lock Status  | Position');
  console.log('  ' + '-'.repeat(100));

  for (const door of doors) {
    const name = (door.name || door.full_name || 'unnamed').padEnd(30);
    const id = door.id;
    const lock = (door.door_lock_relay_status || 'unknown').padEnd(12);
    const pos = door.door_position_status || 'unknown';
    console.log(`  ${name}| ${id} | ${lock} | ${pos}`);
  }

  // Print config-ready format
  console.log('\n  Config-ready door mapping (paste into config.json "doors" section):');
  for (const door of doors) {
    const name = door.name || door.full_name;
    console.log(`    "${name}": "${door.id}",`);
  }
}

async function listUserGroups() {
  console.log('\n=== User Groups (GET /user_groups) ===');

  const result = await apiRequest('GET', '/user_groups');
  const groups = Array.isArray(result.body.data) ? result.body.data : [];

  if (groups.length === 0) {
    console.log('  No user groups found.');
    return;
  }

  console.log(`  Found ${groups.length} user groups:\n`);

  for (const group of groups) {
    const groupName = group.name || group.full_name;
    const logicalName = config.resolver?.unifi_group_to_group?.[groupName] || '(not mapped)';
    console.log(`  Group: "${groupName}" (id: ${group.id})`);
    console.log(`    Mapped to: ${logicalName}`);

    // Fetch members
    try {
      const membersResult = await apiRequest('GET', `/user_groups/${group.id}/users/all`);
      const members = Array.isArray(membersResult.body.data) ? membersResult.body.data : [];
      console.log(`    Members (${members.length}):`);
      for (const user of members) {
        const name = user.full_name || `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'unnamed';
        const status = user.status || 'unknown';
        console.log(`      - ${name} (id: ${user.id}, status: ${status})`);
      }
    } catch (err) {
      console.log(`    Failed to fetch members: ${err.message}`);
    }
    console.log('');
  }
}

async function testUnlock(doorName) {
  console.log(`\n=== Test Unlock: "${doorName}" ===`);

  // First discover doors to get the ID
  const result = await apiRequest('GET', '/doors');
  const doors = Array.isArray(result.body.data) ? result.body.data : [];
  const door = doors.find(d => (d.name || d.full_name) === doorName);

  if (!door) {
    console.log(`  FAIL: Door "${doorName}" not found.`);
    console.log(`  Available doors: ${doors.map(d => d.name || d.full_name).join(', ')}`);
    return;
  }

  console.log(`  Door ID: ${door.id}`);
  console.log(`  Current lock status: ${door.door_lock_relay_status}`);
  console.log(`  Sending PUT /doors/${door.id}/unlock ...`);

  const unlockResult = await apiRequest('PUT', `/doors/${door.id}/unlock`, {
    actor_id: 'validation-tool',
    actor_name: 'Validation Tool',
    extra: {
      source: 'validate',
      timestamp: new Date().toISOString()
    }
  });

  if (unlockResult.body.code === 'SUCCESS') {
    console.log('  PASS: Unlock command accepted');
    console.log('  Check the door physically and verify it unlocked.');
    console.log('  The door should re-lock automatically based on its auto-lock timer.');
  } else {
    console.log(`  FAIL: ${unlockResult.body.code} - ${unlockResult.body.msg}`);
  }
}

async function listWebhooks() {
  console.log('\n=== Registered Webhook Endpoints (GET /webhooks/endpoints) ===');

  try {
    const result = await apiRequest('GET', '/webhooks/endpoints');
    const endpoints = Array.isArray(result.body.data) ? result.body.data : [];

    if (endpoints.length === 0) {
      console.log('  No webhook endpoints registered.');
      console.log('  Use --register to add one, or use Alarm Manager mode.');
      return;
    }

    for (const ep of endpoints) {
      console.log(`\n  Endpoint: ${ep.endpoint}`);
      console.log(`    Name: ${ep.name}`);
      console.log(`    ID: ${ep.id}`);
      console.log(`    Events: ${(ep.events || []).join(', ')}`);
      if (ep.headers) {
        console.log(`    Headers: ${JSON.stringify(ep.headers)}`);
      }
    }
  } catch (err) {
    console.log(`  Failed: ${err.message}`);
    console.log('  Webhook API requires firmware 2.2.10 or later.');
  }
}

async function registerWebhook() {
  console.log('\n=== Register Webhook Endpoint (POST /webhooks/endpoints) ===');

  const webhookConfig = config.event_source?.api_webhook;
  if (!webhookConfig) {
    console.log('  No api_webhook config found in config.json event_source section.');
    return;
  }

  console.log(`  Endpoint URL: ${webhookConfig.endpoint_url}`);
  console.log(`  Name: ${webhookConfig.endpoint_name}`);
  console.log(`  Events: ${webhookConfig.events.join(', ')}`);

  const body = {
    endpoint: webhookConfig.endpoint_url,
    name: webhookConfig.endpoint_name,
    events: webhookConfig.events
  };

  try {
    const result = await apiRequest('POST', '/webhooks/endpoints', body);
    if (result.body.code === 'SUCCESS') {
      console.log('  PASS: Webhook endpoint registered');
      console.log(`  Response: ${JSON.stringify(result.body.data)}`);
    } else {
      console.log(`  FAIL: ${result.body.code} - ${result.body.msg}`);
    }
  } catch (err) {
    console.log(`  Failed: ${err.message}`);
  }
}

async function fetchSampleUser() {
  console.log('\n=== Sample User with Access Policies (GET /users?expand[]=access_policy) ===');

  try {
    const result = await apiRequest('GET', '/users?page_num=1&page_size=3&expand[]=access_policy');
    const users = Array.isArray(result.body.data) ? result.body.data : [];

    if (users.length === 0) {
      console.log('  No users found.');
      return;
    }

    for (const user of users) {
      const name = user.full_name || `${user.first_name || ''} ${user.last_name || ''}`.trim();
      console.log(`\n  User: ${name} (id: ${user.id})`);
      console.log(`    Status: ${user.status}`);
      console.log(`    Employee #: ${user.employee_number || 'none'}`);

      if (user.access_policies && user.access_policies.length > 0) {
        console.log(`    Access Policies:`);
        for (const policy of user.access_policies) {
          console.log(`      - "${policy.name}" (id: ${policy.id})`);
          if (policy.resources) {
            for (const res of policy.resources) {
              console.log(`        Resource: ${res.type} (id: ${res.id})`);
            }
          }
        }
      } else {
        console.log(`    Access Policies: none (try adding ?expand[]=access_policy)`);
      }

      if (user.access_policy_ids?.length > 0) {
        console.log(`    Policy IDs: ${user.access_policy_ids.join(', ')}`);
      }
    }
  } catch (err) {
    console.log(`  Failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  console.log('UniFi Access Orchestrator - Validation Tool');
  console.log(`Config: ${CONFIG_PATH}`);
  console.log(`Target: ${config.unifi.host}:${config.unifi.port}`);

  // Always test connectivity first
  const connected = await testConnectivity();
  if (!connected) {
    console.log('\nConnectivity failed. Fix connection issues before continuing.');
    process.exit(1);
  }

  if (args.includes('--doors')) {
    await discoverDoors();
  } else if (args.includes('--users')) {
    await listUserGroups();
  } else if (args.includes('--unlock')) {
    const doorIndex = args.indexOf('--unlock') + 1;
    const doorName = args[doorIndex];
    if (!doorName) {
      console.log('Usage: npm run validate -- --unlock "Door Name"');
      process.exit(1);
    }
    await testUnlock(doorName);
  } else if (args.includes('--webhooks')) {
    await listWebhooks();
  } else if (args.includes('--register')) {
    await registerWebhook();
  } else if (args.includes('--sample-user')) {
    await fetchSampleUser();
  } else {
    // Run all checks
    await discoverDoors();
    await listUserGroups();
    await fetchSampleUser();
    await listWebhooks();
  }

  console.log('\n=== Validation Complete ===');
  process.exit(0);
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
