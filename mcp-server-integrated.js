#!/usr/bin/env node
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} = require('@modelcontextprotocol/sdk/types.js');

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
            name: 'search_salesforce_cases',
            description: 'Search Salesforce support cases by keywords. Returns raw case data including case numbers, subjects, status, priority, and account info.',
            inputSchema: {
              type: 'object',
              properties: {
                keywords: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Keywords to search for in case subjects and descriptions'
                },
                teamId: {
                  type: 'string',
                  description: 'Slack team ID for authentication'
                }
              },
              required: ['keywords', 'teamId']
            }
          },
          {
            name: 'get_recent_cases',
            description: 'Get recent Salesforce cases from a specific time period. Returns cases with full details.',
            inputSchema: {
              type: 'object',
              properties: {
                timeframe: {
                  type: 'string',
                  enum: ['today', 'yesterday', 'this_week', 'last_week', 'this_month'],
                  description: 'Time period for cases'
                },
                teamId: {
                  type: 'string',
                  description: 'Slack team ID for authentication'
                },
                status: {
                  type: 'string',
                  description: 'Filter by case status (optional)'
                },
                priority: {
                  type: 'string',
                  description: 'Filter by priority: High, Medium, Low (optional)'
                }
              },
              required: ['timeframe', 'teamId']
            }
          },
          {
            name: 'search_accounts',
            description: 'Search Salesforce accounts. Returns account details including contacts and recent activity.',
            inputSchema: {
              type: 'object',
              properties: {
                searchTerm: {
                  type: 'string',
                  description: 'Account name or keyword to search for'
                },
                teamId: {
                  type: 'string',
                  description: 'Slack team ID for authentication'
                }
              },
              required: ['searchTerm', 'teamId']
            }
          },
          {
            name: 'get_case_details',
            description: 'Get full details for a specific Salesforce case including description, comments, and history.',
            inputSchema: {
              type: 'object',
              properties: {
                caseId: {
                  type: 'string',
                  description: 'Case ID or Case Number'
                },
                teamId: {
                  type: 'string',
                  description: 'Slack team ID for authentication'
                }
              },
              required: ['caseId', 'teamId']
            }
          },
          {
            name: 'search_opportunities',
            description: 'Search Salesforce opportunities/deals. Returns opportunity data with amounts, stages, and close dates.',
            inputSchema: {
              type: 'object',
              properties: {
                searchTerm: {
                  type: 'string',
                  description: 'Search term for opportunity names or account names'
                },
                stage: {
                  type: 'string',
                  description: 'Filter by stage: won, lost, open (optional)'
                },
                teamId: {
                  type: 'string',
                  description: 'Slack team ID for authentication'
                }
              },
              required: ['searchTerm', 'teamId']
            }
          },
          {
            name: 'get_account_health',
            description: 'Get account health metrics and risk indicators. Returns accounts with health scores and recent case activity.',
            inputSchema: {
              type: 'object',
              properties: {
                riskLevel: {
                  type: 'string',
                  enum: ['high', 'medium', 'low', 'all'],
                  description: 'Filter accounts by risk level'
                },
                teamId: {
                  type: 'string',
                  description: 'Slack team ID for authentication'
                }
              },
              required: ['riskLevel', 'teamId']
            }
          },
          {
            name: 'search_jira_issues',
            description: 'Search Jira issues and tickets. Returns issue keys, summaries, status, and assignees.',
            inputSchema: {
              type: 'object',
              properties: {
                keywords: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Keywords to search for in Jira issues'
                },
                teamId: {
                  type: 'string',
                  description: 'Slack team ID for authentication'
                }
              },
              required: ['keywords', 'teamId']
            }
          },
          {
            name: 'check_team_connections',
            description: 'Check authentication status and available data sources for a team.',
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
          }
        ]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'search_salesforce_cases':
            return await this.handleSearchCases(args);
          case 'get_recent_cases':
            return await this.handleRecentCases(args);
          case 'search_accounts':
            return await this.handleSearchAccounts(args);
          case 'get_case_details':
            return await this.handleCaseDetails(args);
          case 'search_opportunities':
            return await this.handleSearchOpportunities(args);
          case 'get_account_health':
            return await this.handleAccountHealth(args);
          case 'search_jira_issues':
            return await this.handleSearchJira(args);
          case 'check_team_connections':
            return await this.handleCheckConnections(args);
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error) {
        console.error(`Error in ${name}:`, error);
        throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${error.message}`);
      }
    });
  }

  async getTeamCredentials(teamId) {
    // Check cache first
    if (this.userCache.has(teamId)) {
      const cached = this.userCache.get(teamId);
      if (Date.now() - cached.timestamp < 15 * 60 * 1000) { // 15 minute cache
        return cached.team;
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

      // Cache the team
      this.userCache.set(teamId, {
        team: team,
        timestamp: Date.now()
      });

      return team;
    } catch (error) {
      throw new Error(`Authentication failed: ${error.message}`);
    }
  }

  // Simple dumb tools - just return raw data, let Claude do the intelligence
  
  async handleSearchCases(args) {
    const { keywords, teamId } = args;
    const team = await this.getTeamCredentials(teamId);
    const salesforceService = new SalesforceService(team);

    try {
      // Simple keyword search - no AI planning
      const keywordString = keywords.join(' ');
      const cases = await salesforceService.searchSupportTickets(keywordString);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            cases: cases || [],
            totalFound: cases?.length || 0,
            searchTerms: keywords
          }, null, 2)
        }]
      };
    } catch (error) {
      throw new Error(`Case search failed: ${error.message}`);
    }
  }

  async handleRecentCases(args) {
    const { timeframe, teamId, status, priority } = args;
    const team = await this.getTeamCredentials(teamId);
    const salesforceService = new SalesforceService(team);

    try {
      // Build time-based query
      let timeCondition = '';
      switch (timeframe) {
        case 'today': timeCondition = 'CreatedDate = TODAY'; break;
        case 'yesterday': timeCondition = 'CreatedDate = YESTERDAY'; break;
        case 'this_week': timeCondition = 'CreatedDate = THIS_WEEK'; break;
        case 'last_week': timeCondition = 'CreatedDate = LAST_WEEK'; break;
        case 'this_month': timeCondition = 'CreatedDate = THIS_MONTH'; break;
      }

      let conditions = [timeCondition];
      if (status) conditions.push(`Status = '${status}'`);
      if (priority) conditions.push(`Priority = '${priority}'`);

      const query = `SELECT Id, CaseNumber, Subject, Status, Priority, CreatedDate, Account.Name, Contact.Name FROM Case WHERE ${conditions.join(' AND ')} ORDER BY CreatedDate DESC LIMIT 50`;
      
      const response = await salesforceService.executeSOQLQuery(query);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            cases: response.records || [],
            totalFound: response.totalSize || 0,
            query: query
          }, null, 2)
        }]
      };
    } catch (error) {
      throw new Error(`Recent cases failed: ${error.message}`);
    }
  }

  async handleSearchAccounts(args) {
    const { searchTerm, teamId } = args;
    const team = await this.getTeamCredentials(teamId);
    const salesforceService = new SalesforceService(team);

    try {
      const query = `SELECT Id, Name, Type, Industry, Phone, BillingCity, AnnualRevenue FROM Account WHERE Name LIKE '%${searchTerm}%' LIMIT 20`;
      const response = await salesforceService.executeSOQLQuery(query);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            accounts: response.records || [],
            totalFound: response.totalSize || 0
          }, null, 2)
        }]
      };
    } catch (error) {
      throw new Error(`Account search failed: ${error.message}`);
    }
  }

  async handleCaseDetails(args) {
    const { caseId, teamId } = args;
    const team = await this.getTeamCredentials(teamId);
    const salesforceService = new SalesforceService(team);

    try {
      const isId = caseId.startsWith('500') || caseId.length === 18;
      const field = isId ? 'Id' : 'CaseNumber';
      
      const query = `SELECT Id, CaseNumber, Subject, Description, Status, Priority, CreatedDate, Account.Name, Contact.Name, Owner.Name FROM Case WHERE ${field} = '${caseId}'`;
      const response = await salesforceService.executeSOQLQuery(query);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            case: response.records[0] || null,
            found: response.records.length > 0
          }, null, 2)
        }]
      };
    } catch (error) {
      throw new Error(`Case details failed: ${error.message}`);
    }
  }

  async handleSearchOpportunities(args) {
    const { searchTerm, stage, teamId } = args;
    const team = await this.getTeamCredentials(teamId);
    const salesforceService = new SalesforceService(team);

    try {
      let conditions = [`(Name LIKE '%${searchTerm}%' OR Account.Name LIKE '%${searchTerm}%')`];
      
      if (stage === 'won') conditions.push('IsWon = true');
      if (stage === 'lost') conditions.push('IsWon = false AND IsClosed = true');
      if (stage === 'open') conditions.push('IsClosed = false');

      const query = `SELECT Id, Name, StageName, Amount, CloseDate, Account.Name, Owner.Name FROM Opportunity WHERE ${conditions.join(' AND ')} ORDER BY CloseDate DESC LIMIT 20`;
      const response = await salesforceService.executeSOQLQuery(query);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            opportunities: response.records || [],
            totalFound: response.totalSize || 0
          }, null, 2)
        }]
      };
    } catch (error) {
      throw new Error(`Opportunity search failed: ${error.message}`);
    }
  }

  async handleAccountHealth(args) {
    const { riskLevel, teamId } = args;
    const team = await this.getTeamCredentials(teamId);
    const salesforceService = new SalesforceService(team);

    try {
      // Simple proxy: accounts with recent high-priority cases = at risk
      const query = `
        SELECT Account.Id, Account.Name, COUNT(Id) as CaseCount 
        FROM Case 
        WHERE Priority IN ('High', 'Critical') AND CreatedDate = LAST_30_DAYS 
        GROUP BY Account.Id, Account.Name 
        ORDER BY COUNT(Id) DESC 
        LIMIT 20
      `;
      const response = await salesforceService.executeSOQLQuery(query);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            riskAccounts: response.records || [],
            totalFound: response.totalSize || 0,
            note: 'Risk based on recent high-priority case count'
          }, null, 2)
        }]
      };
    } catch (error) {
      throw new Error(`Account health check failed: ${error.message}`);
    }
  }

  async handleSearchJira(args) {
    const { keywords, teamId } = args;
    const team = await this.getTeamCredentials(teamId);
    const jiraService = new JiraService();

    try {
      const keywordString = keywords.join(' ');
      const issues = await jiraService.searchIssues(keywordString);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            issues: issues || [],
            totalFound: issues?.length || 0,
            searchTerms: keywords
          }, null, 2)
        }]
      };
    } catch (error) {
      throw new Error(`Jira search failed: ${error.message}`);
    }
  }

  async handleCheckConnections(args) {
    const { teamId } = args;

    try {
      const team = await Team.findById(teamId);
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            teamId,
            teamName: team?.name || 'Unknown',
            connections: {
              slack: !!team?.slack_access_token,
              salesforce: !!team?.salesforce_access_token,
              jira: true // Jira doesn't require per-team auth
            },
            salesforceInstance: team?.salesforce_instance_url || null
          }, null, 2)
        }]
      };
    } catch (error) {
      throw new Error(`Connection check failed: ${error.message}`);
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