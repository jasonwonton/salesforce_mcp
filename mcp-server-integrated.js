#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// Import your existing services
const Team = require('./src/models/Team.js');
const SalesforceService = require('./src/services/salesforce.js');
const MultiSourceService = require('./src/services/multiSourceService.js');

class SalesforceIntegratedMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'salesforce-integrated-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Cache authenticated users to avoid database hits
    this.userCache = new Map();
    this.setupToolHandlers();
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'slack_station_search',
            description: 'Perform intelligent search exactly like /station command - uses existing team authentication',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Search query (same format as /station command)'
                },
                teamId: {
                  type: 'string',
                  description: 'Slack team ID (from existing authenticated team)'
                },
                userId: {
                  type: 'string',
                  description: 'Slack user ID (optional, for user-specific context)'
                }
              },
              required: ['query', 'teamId']
            }
          },
          {
            name: 'slack_support_search',
            description: 'Direct Salesforce support ticket search like /support command',
            inputSchema: {
              type: 'object',
              properties: {
                searchTerm: {
                  type: 'string',
                  description: 'Support ticket search term'
                },
                teamId: {
                  type: 'string',
                  description: 'Slack team ID'
                }
              },
              required: ['searchTerm', 'teamId']
            }
          },
          {
            name: 'salesforce_ask_ai',
            description: 'Ask follow-up AI questions about previous search results',
            inputSchema: {
              type: 'object',
              properties: {
                question: {
                  type: 'string',
                  description: 'Follow-up question to ask the AI'
                },
                teamId: {
                  type: 'string',
                  description: 'Slack team ID'
                },
                context: {
                  type: 'string',
                  description: 'Previous search context (optional)'
                }
              },
              required: ['question', 'teamId']
            }
          },
          {
            name: 'team_auth_status',
            description: 'Check authentication status for a team',
            inputSchema: {
              type: 'object',
              properties: {
                teamId: {
                  type: 'string',
                  description: 'Slack team ID to check'
                }
              },
              required: ['teamId']
            }
          },
          {
            name: 'list_authenticated_teams',
            description: 'List all teams with Salesforce authentication',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false
            }
          }
        ]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'slack_station_search':
            return await this.handleStationSearch(args);
          case 'slack_support_search':
            return await this.handleSupportSearch(args);
          case 'salesforce_ask_ai':
            return await this.handleAskAI(args);
          case 'team_auth_status':
            return await this.handleAuthStatus(args);
          case 'list_authenticated_teams':
            return await this.handleListTeams();
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error) {
        console.error(`Error in ${name}:`, error);
        throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${error.message}`);
      }
    });
  }

  async getTeamService(teamId) {
    // Check cache first
    if (this.userCache.has(teamId)) {
      const cached = this.userCache.get(teamId);
      if (Date.now() - cached.timestamp < 15 * 60 * 1000) { // 15 minute cache
        return cached.service;
      }
    }

    try {
      const team = await Team.findById(teamId);
      if (!team) {
        throw new Error(`Team ${teamId} not found. Please ensure the team is registered and authenticated.`);
      }

      if (!team.salesforce_access_token) {
        const oauthUrl = `${process.env.APP_URL || 'http://localhost:3000'}/oauth/salesforce/connect/${teamId}`;
        throw new Error(`Team ${team.name} needs Salesforce authentication. Visit: ${oauthUrl}`);
      }

      const multiSourceService = new MultiSourceService(team);
      
      // Cache the service
      this.userCache.set(teamId, {
        service: multiSourceService,
        team: team,
        timestamp: Date.now()
      });

      return multiSourceService;
    } catch (error) {
      throw new Error(`Authentication failed: ${error.message}`);
    }
  }

  async handleStationSearch(args) {
    const { query, teamId, userId } = args;

    const progressMessages = [];
    const multiSourceService = await this.getTeamService(teamId);

    try {
      // Use your existing intelligent planning search
      const results = await multiSourceService.searchWithIntelligentPlanning(
        query,
        async (message) => {
          progressMessages.push({
            timestamp: new Date().toISOString(),
            message: message
          });
        }
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            query,
            teamId,
            searchMethod: 'Intelligent AI Planning (same as /station)',
            progress: progressMessages,
            results: {
              salesforce: results.salesforce || null,
              jira: results.jira || null,
              summary: results.summary || null,
              totalFound: (results.salesforce?.cases?.length || 0) + (results.jira?.issues?.length || 0)
            },
            timestamp: new Date().toISOString()
          }, null, 2)
        }]
      };
    } catch (error) {
      throw new Error(`Station search failed: ${error.message}`);
    }
  }

  async handleSupportSearch(args) {
    const { searchTerm, teamId } = args;

    try {
      const team = await Team.findById(teamId);
      if (!team || !team.salesforce_access_token) {
        throw new Error('Team not authenticated with Salesforce');
      }

      const salesforceService = new SalesforceService({
        accessToken: team.salesforce_access_token,
        instanceUrl: team.salesforce_instance_url,
        refreshToken: team.salesforce_refresh_token
      });

      // Use your existing support ticket search
      const cases = await salesforceService.searchSupportTickets(searchTerm);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            searchTerm,
            teamId,
            searchMethod: 'Direct Salesforce SOSL (same as /support)',
            cases: cases || [],
            totalFound: cases?.length || 0,
            timestamp: new Date().toISOString()
          }, null, 2)
        }]
      };
    } catch (error) {
      throw new Error(`Support search failed: ${error.message}`);
    }
  }

  async handleAskAI(args) {
    const { question, teamId, context } = args;

    try {
      const multiSourceService = await this.getTeamService(teamId);

      // Get recent context if not provided
      let searchResults = {};
      if (context) {
        try {
          searchResults = JSON.parse(context);
        } catch (e) {
          // If context parsing fails, do a quick search
          searchResults = await multiSourceService.searchWithIntelligentPlanning(
            'recent tickets', 
            () => {} // no progress callback needed for context
          );
        }
      } else {
        // Get recent context
        searchResults = await multiSourceService.searchWithIntelligentPlanning(
          'recent tickets',
          () => {}
        );
      }

      // Use your existing AI question answering
      const aiResponse = await multiSourceService.answerFollowUpQuestion(question, searchResults);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            question,
            teamId,
            aiResponse,
            contextUsed: !!context,
            method: 'Google Gemini AI Analysis (same as /station ask)',
            timestamp: new Date().toISOString()
          }, null, 2)
        }]
      };
    } catch (error) {
      throw new Error(`AI question failed: ${error.message}`);
    }
  }

  async handleAuthStatus(args) {
    const { teamId } = args;

    try {
      const team = await Team.findById(teamId);
      
      if (!team) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              teamId,
              authenticated: false,
              error: 'Team not found',
              action: 'Team needs to install the Slack app first'
            }, null, 2)
          }]
        };
      }

      const hasSlackAuth = !!team.slack_access_token;
      const hasSalesforceAuth = !!team.salesforce_access_token;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            teamId,
            teamName: team.name,
            authenticated: hasSalesforceAuth,
            slackConnected: hasSlackAuth,
            salesforceConnected: hasSalesforceAuth,
            salesforceInstance: team.salesforce_instance_url || null,
            lastUpdated: team.updated_at,
            oauthUrl: hasSalesforceAuth ? null : `${process.env.APP_URL || 'http://localhost:3000'}/oauth/salesforce/connect/${teamId}`
          }, null, 2)
        }]
      };
    } catch (error) {
      throw new Error(`Auth status check failed: ${error.message}`);
    }
  }

  async handleListTeams() {
    try {
      // This would need to be implemented in your Team model
      // For now, we'll return a simple message
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            message: 'To list teams, you need a specific team ID. Use team_auth_status with a known team ID.',
            suggestion: 'Teams authenticate through Slack app installation and then Salesforce OAuth.',
            authFlow: [
              '1. Install Slack app in workspace',
              '2. Use /support or /station command',
              '3. Follow Salesforce OAuth link if needed',
              '4. Use team ID from Slack context'
            ]
          }, null, 2)
        }]
      };
    } catch (error) {
      throw new Error(`List teams failed: ${error.message}`);
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Salesforce Integrated MCP server running on stdio');
  }
}

const server = new SalesforceIntegratedMCPServer();
server.run().catch(console.error);