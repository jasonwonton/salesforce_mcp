const SalesforceService = require('./salesforce');
const JiraService = require('./jiraService');

class ToolService {
  constructor(team) {
    this.team = team;
    this.salesforceService = team ? new SalesforceService(team) : null;
    this.jiraService = new JiraService();
  }

  // Define available tools for the AI to choose from
  getAvailableTools() {
    return [
      {
        name: 'search_recent_cases',
        description: 'Search recent Salesforce cases from today, yesterday, this week, etc.',
        parameters: {
          timeframe: 'today|yesterday|this_week|this_month',
          priority: 'High|Medium|Low (optional)',
          keywords: 'array of search terms (optional)'
        }
      },
      {
        name: 'search_cases_by_keywords',
        description: 'Search Salesforce cases by specific keywords or terms',
        parameters: {
          keywords: 'array of search terms',
          status: 'Open|Closed (optional)'
        }
      },
      {
        name: 'search_all_objects',
        description: 'Search across ALL Salesforce objects (Accounts, Contacts, Cases, Opportunities) at once using SOSL',
        parameters: {
          searchTerm: 'term to search across all objects'
        }
      },
      {
        name: 'search_accounts',
        description: 'Search for Salesforce accounts by name or criteria',
        parameters: {
          searchTerm: 'account name or keyword'
        }
      },
      {
        name: 'get_account_health',
        description: 'Find accounts with health issues or high case volume',
        parameters: {
          riskLevel: 'high|medium|low'
        }
      },
      {
        name: 'search_opportunities',
        description: 'Search deals/opportunities in Salesforce',
        parameters: {
          searchTerm: 'opportunity or account name',
          stage: 'won|lost|open (optional)'
        }
      },
      {
        name: 'search_jira_issues',
        description: 'Search Jira tickets and issues',
        parameters: {
          keywords: 'array of search terms'
        }
      },
      {
        name: 'conversational_response',
        description: 'Provide a helpful conversational response without searching data',
        parameters: {
          responseType: 'greeting|help|explanation|guidance'
        }
      }
    ];
  }

  async analyzeRequestAndSelectTools(userRequest) {
    const tools = this.getAvailableTools();
    
    const prompt = `
User request: "${userRequest}"

Available tools:
${tools.map(t => `- ${t.name}: ${t.description}`).join('\n')}

Analyze the user request and determine which tool(s) to use. Return JSON:

{
  "reasoning": "why you chose these tools",
  "selectedTools": [
    {
      "toolName": "tool_name",
      "parameters": {...}
    }
  ]
}

Examples:
- "help me" → conversational_response tool
- "billing issues today" → search_recent_cases tool with timeframe=today, keywords=["billing"]
- "red accounts" → get_account_health tool with riskLevel=high
- "Microsoft deals" → search_opportunities tool with searchTerm="Microsoft"

Return ONLY JSON, no markdown.
    `;

    try {
      const response = await this.callGeminiAPI(prompt);
      const cleanResponse = response.replace(/```json\n|\n```|```/g, '').trim();
      return JSON.parse(cleanResponse);
    } catch (error) {
      console.error('Tool selection failed:', error);
      // Fallback logic
      return this.fallbackToolSelection(userRequest);
    }
  }

  async callGeminiAPI(prompt) {
    const axios = require('axios');
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL || 'gemini-1.5-flash'}:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            contents: [{
              parts: [{
                text: prompt
              }]
            }],
            generationConfig: {
              temperature: 0.3,
              maxOutputTokens: 500
            }
          },
          {
            headers: {
              'Content-Type': 'application/json'
            }
          }
        );

        return response.data.candidates[0].content.parts[0].text;
      } catch (error) {
        if (error.response?.status === 429 && attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, attempt * 2000));
          continue;
        }
        throw error;
      }
    }
  }

  fallbackToolSelection(userRequest) {
    const lower = userRequest.toLowerCase();
    
    if (lower.includes('help') || lower.includes('hi') || lower.includes('hello')) {
      return {
        reasoning: 'Conversational request detected',
        selectedTools: [{ 
          toolName: 'conversational_response', 
          parameters: { responseType: 'help' } 
        }]
      };
    }
    
    if (lower.includes('today') || lower.includes('recent')) {
      return {
        reasoning: 'Recent data request detected',
        selectedTools: [{ 
          toolName: 'search_recent_cases', 
          parameters: { timeframe: 'today' } 
        }]
      };
    }
    
    // Default to keyword search
    const keywords = userRequest.split(' ').filter(word => word.length > 3);
    return {
      reasoning: 'General search request',
      selectedTools: [{ 
        toolName: 'search_cases_by_keywords', 
        parameters: { keywords } 
      }]
    };
  }

  async executeTool(toolName, parameters) {
    switch (toolName) {
      case 'search_recent_cases':
        return await this.searchRecentCases(parameters);
      case 'search_cases_by_keywords':
        return await this.searchCasesByKeywords(parameters);
      case 'search_all_objects':
        return await this.searchAllObjects(parameters);
      case 'search_accounts':
        return await this.searchAccounts(parameters);
      case 'get_account_health':
        return await this.getAccountHealth(parameters);
      case 'search_opportunities':
        return await this.searchOpportunities(parameters);
      case 'search_jira_issues':
        return await this.searchJiraIssues(parameters);
      case 'conversational_response':
        return await this.conversationalResponse(parameters);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  // Tool implementations
  async searchRecentCases(params) {
    if (!this.salesforceService) {
      throw new Error('Salesforce not connected');
    }

    let timeCondition = '';
    switch (params.timeframe) {
      case 'today': timeCondition = 'CreatedDate = TODAY'; break;
      case 'yesterday': timeCondition = 'CreatedDate = YESTERDAY'; break;
      case 'this_week': timeCondition = 'CreatedDate = THIS_WEEK'; break;
      case 'this_month': timeCondition = 'CreatedDate = THIS_MONTH'; break;
      default: timeCondition = 'CreatedDate = TODAY';
    }

    let conditions = [timeCondition];
    if (params.priority) conditions.push(`Priority = '${params.priority}'`);

    const query = `SELECT Id, CaseNumber, Subject, Status, Priority, CreatedDate, Account.Name FROM Case WHERE ${conditions.join(' AND ')} ORDER BY CreatedDate DESC LIMIT 20`;
    
    try {
      const response = await this.salesforceService.executeSOQLQuery(query);
      return {
        toolName: 'search_recent_cases',
        success: true,
        data: response.records || [],
        count: response.totalSize || 0
      };
    } catch (error) {
      return { toolName: 'search_recent_cases', success: false, error: error.message };
    }
  }

  async searchCasesByKeywords(params) {
    if (!this.salesforceService) {
      throw new Error('Salesforce not connected');
    }

    try {
      const keywordString = params.keywords.join(' ');
      const cases = await this.salesforceService.searchSupportTickets(keywordString);
      
      return {
        toolName: 'search_cases_by_keywords',
        success: true,
        data: cases || [],
        count: cases?.length || 0
      };
    } catch (error) {
      return { toolName: 'search_cases_by_keywords', success: false, error: error.message };
    }
  }

  async searchAllObjects(params) {
    if (!this.salesforceService) {
      throw new Error('Salesforce not connected');
    }

    try {
      // Use the FIND query you mentioned!
      const soslQuery = `FIND {${params.searchTerm}} RETURNING Account(Name, Id), Contact(Name, Email, Id), Case(CaseNumber, Subject, Status, Id), Opportunity(Name, StageName, Amount, Id)`;
      
      const response = await this.salesforceService.executeSOSLQuery(soslQuery);
      
      // Parse SOSL results by object type
      const results = {
        accounts: [],
        contacts: [],
        cases: [],
        opportunities: []
      };
      
      if (response.searchRecords) {
        response.searchRecords.forEach(record => {
          switch (record.attributes.type) {
            case 'Account':
              results.accounts.push(record);
              break;
            case 'Contact':
              results.contacts.push(record);
              break;
            case 'Case':
              results.cases.push(record);
              break;
            case 'Opportunity':
              results.opportunities.push(record);
              break;
          }
        });
      }
      
      return {
        toolName: 'search_all_objects',
        success: true,
        data: results,
        count: response.searchRecords?.length || 0,
        breakdown: {
          accounts: results.accounts.length,
          contacts: results.contacts.length,
          cases: results.cases.length,
          opportunities: results.opportunities.length
        }
      };
    } catch (error) {
      return { toolName: 'search_all_objects', success: false, error: error.message };
    }
  }

  async searchAccounts(params) {
    if (!this.salesforceService) {
      throw new Error('Salesforce not connected');
    }

    try {
      const query = `SELECT Id, Name, Type, Industry, Phone FROM Account WHERE Name LIKE '%${params.searchTerm}%' LIMIT 10`;
      const response = await this.salesforceService.executeSOQLQuery(query);
      
      return {
        toolName: 'search_accounts',
        success: true,
        data: response.records || [],
        count: response.totalSize || 0
      };
    } catch (error) {
      return { toolName: 'search_accounts', success: false, error: error.message };
    }
  }

  async getAccountHealth(params) {
    if (!this.salesforceService) {
      throw new Error('Salesforce not connected');
    }

    try {
      // Find accounts with recent high-priority cases
      const query = `
        SELECT Account.Id, Account.Name, COUNT(Id) as CaseCount 
        FROM Case 
        WHERE Priority IN ('High', 'Critical') AND CreatedDate = LAST_30_DAYS 
        GROUP BY Account.Id, Account.Name 
        ORDER BY COUNT(Id) DESC 
        LIMIT 15
      `;
      const response = await this.salesforceService.executeSOQLQuery(query);
      
      return {
        toolName: 'get_account_health',
        success: true,
        data: response.records || [],
        count: response.totalSize || 0
      };
    } catch (error) {
      return { toolName: 'get_account_health', success: false, error: error.message };
    }
  }

  async searchOpportunities(params) {
    if (!this.salesforceService) {
      throw new Error('Salesforce not connected');
    }

    try {
      let conditions = [`(Name LIKE '%${params.searchTerm}%' OR Account.Name LIKE '%${params.searchTerm}%')`];
      
      if (params.stage === 'won') conditions.push('IsWon = true');
      if (params.stage === 'lost') conditions.push('IsWon = false AND IsClosed = true');
      if (params.stage === 'open') conditions.push('IsClosed = false');

      const query = `SELECT Id, Name, StageName, Amount, Account.Name FROM Opportunity WHERE ${conditions.join(' AND ')} LIMIT 10`;
      const response = await this.salesforceService.executeSOQLQuery(query);
      
      return {
        toolName: 'search_opportunities',
        success: true,
        data: response.records || [],
        count: response.totalSize || 0
      };
    } catch (error) {
      return { toolName: 'search_opportunities', success: false, error: error.message };
    }
  }

  async searchJiraIssues(params) {
    try {
      const keywordString = params.keywords.join(' ');
      const issues = await this.jiraService.searchIssues(keywordString);
      
      return {
        toolName: 'search_jira_issues',
        success: true,
        data: issues || [],
        count: issues?.length || 0
      };
    } catch (error) {
      return { toolName: 'search_jira_issues', success: false, error: error.message };
    }
  }

  async conversationalResponse(params) {
    const responses = {
      help: "I can help you search Salesforce cases, accounts, opportunities, and Jira issues. Try asking about recent cases, specific accounts, or billing issues.",
      greeting: "Hello! I'm your AI assistant for searching Salesforce and Jira data. What would you like to find?",
      explanation: "I can search across your connected data sources and provide intelligent analysis of your support tickets, accounts, and deals.",
      guidance: "Ask me about recent support cases, account health, opportunities, or specific issues you're tracking."
    };

    return {
      toolName: 'conversational_response',
      success: true,
      message: responses[params.responseType] || responses.help
    };
  }
}

module.exports = ToolService;