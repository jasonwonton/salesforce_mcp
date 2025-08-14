const { spawn } = require('child_process');
const path = require('path');

class MCPClient {
  constructor() {
    this.serverPath = path.join(__dirname, '../../mcp-server-integrated.js');
  }

  async callMCPTool(toolName, args) {
    return new Promise((resolve, reject) => {
      const server = spawn('node', [this.serverPath], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let response = '';
      let errorOutput = '';

      server.stdout.on('data', (data) => {
        const output = data.toString();
        if (!output.includes('running on stdio')) {
          response += output;
        }
      });

      server.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      const query = {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args
        }
      };

      server.stdin.write(JSON.stringify(query) + '\n');
      server.stdin.end();

      const timeout = setTimeout(() => {
        server.kill();
        reject(new Error('MCP server timeout'));
      }, 30000); // 30 second timeout

      server.on('close', (code) => {
        clearTimeout(timeout);
        
        if (errorOutput.trim()) {
          reject(new Error(`MCP error: ${errorOutput.trim()}`));
          return;
        }

        if (!response.trim()) {
          reject(new Error('No response from MCP server'));
          return;
        }

        try {
          const parsed = JSON.parse(response.trim());
          
          if (parsed.error) {
            reject(new Error(`MCP tool error: ${parsed.error.message}`));
            return;
          }

          resolve(parsed.result);
        } catch (parseError) {
          reject(new Error(`Failed to parse MCP response: ${parseError.message}`));
        }
      });

      server.on('error', (error) => {
        clearTimeout(timeout);
        reject(new Error(`MCP server spawn error: ${error.message}`));
      });
    });
  }

  async searchWithStation(query, teamId, userId = null) {
    try {
      const result = await this.callMCPTool('slack_station_search', {
        query,
        teamId,
        userId
      });

      return result;
    } catch (error) {
      console.error('MCP station search failed:', error);
      throw error;
    }
  }

  async searchSupport(searchTerm, teamId) {
    try {
      const result = await this.callMCPTool('slack_support_search', {
        searchTerm,
        teamId
      });

      return result;
    } catch (error) {
      console.error('MCP support search failed:', error);
      throw error;
    }
  }

  async askAI(question, teamId, context = null) {
    try {
      const result = await this.callMCPTool('salesforce_ask_ai', {
        question,
        teamId,
        context
      });

      return result;
    } catch (error) {
      console.error('MCP AI question failed:', error);
      throw error;
    }
  }

  async checkTeamAuth(teamId) {
    try {
      const result = await this.callMCPTool('team_auth_status', {
        teamId
      });

      return result;
    } catch (error) {
      console.error('MCP auth check failed:', error);
      throw error;
    }
  }
}

module.exports = MCPClient;