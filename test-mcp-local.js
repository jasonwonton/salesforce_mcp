#!/usr/bin/env node

const { spawn } = require('child_process');

// Test queries
const tests = [
  {
    name: 'List Tools',
    query: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {}
    }
  },
  {
    name: 'Team Auth Status',
    query: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'team_auth_status',
        arguments: {
          teamId: 'T06R08GRWAG'
        }
      }
    }
  },
  {
    name: 'Station Search Test',
    query: {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'slack_station_search',
        arguments: {
          query: 'billing issues today',
          teamId: 'T06R08GRWAG'
        }
      }
    }
  }
];

async function testMCP() {
  console.log('🧪 Testing MCP Server...\n');

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i];
    console.log(`\n🔍 Test ${i + 1}: ${test.name}`);
    console.log(`📤 Sending: ${JSON.stringify(test.query, null, 2)}`);

    const server = spawn('node', ['mcp-server-integrated.js'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let response = '';
    let errorOutput = '';

    server.stdout.on('data', (data) => {
      const output = data.toString();
      // Filter out the "running on stdio" message
      if (!output.includes('running on stdio')) {
        response += output;
      }
    });

    server.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    // Send the query
    server.stdin.write(JSON.stringify(test.query) + '\n');
    server.stdin.end();

    // Wait for response
    await new Promise((resolve) => {
      server.on('close', () => {
        resolve();
      });
    });

    if (response.trim()) {
      console.log(`📥 Response: ${response.trim()}`);
    } else if (errorOutput.trim()) {
      console.log(`❌ Error: ${errorOutput.trim()}`);
    } else {
      console.log(`⚠️  No response received`);
    }

    console.log('---');
  }
}

testMCP().catch(console.error);