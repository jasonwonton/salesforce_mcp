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
        description: 'Search recent Salesforce cases within specific time periods, optionally filtered by keywords',
        parameters: {
          timeframe: 'today|yesterday|this_week|this_month|last_30_days|last_90_days|last_6_months',
          priority: 'High|Medium|Low (optional)',
          keywords: 'array of search terms to filter results (optional)'
        },
        // Example queries this tool generates:
        // Basic: SELECT Id, CaseNumber, Subject, Status, Priority, CreatedDate, Account.Name FROM Case WHERE CreatedDate = LAST_N_DAYS:30 ORDER BY CreatedDate DESC LIMIT 20
        // With keywords: SELECT Id, CaseNumber, Subject, Status, Priority, CreatedDate, Account.Name FROM Case WHERE CreatedDate = LAST_N_DAYS:90 AND ((Subject LIKE '%billing%' OR Description LIKE '%billing%')) ORDER BY CreatedDate DESC LIMIT 20
      },
      {
        name: 'search_cases_by_keywords',
        description: 'Search Salesforce cases by specific keywords or terms',
        parameters: {
          keywords: 'array of search terms',
          status: 'Open|Closed (optional)'
        },
        // Example query: Uses salesforceService.searchSupportTickets() which generates:
        // SOSL: FIND {billing} IN ALL FIELDS RETURNING Case(Id, CaseNumber, Subject, Status, CreatedDate, Account.Name, Contact.Name, Priority, Description WHERE Status != 'Closed') LIMIT 20
        // SOQL Fallback: SELECT Id, CaseNumber, Subject, Status, CreatedDate, Account.Name, Contact.Name, Priority, Description FROM Case WHERE Subject LIKE '%billing%'
      },
      {
        name: 'search_all_objects',
        description: 'Search across ALL Salesforce objects (Accounts, Contacts, Cases, Opportunities) at once using SOSL',
        parameters: {
          searchTerm: 'term to search across all objects'
        },
        // Example query: Searches individual keywords, for searchTerm="Acme billing":
        // FIND {Acme} RETURNING Account(Name, Id), Contact(Name, Email, Id), Case(CaseNumber, Subject, Status, Id), Opportunity(Name, StageName, Amount, Id)
        // FIND {billing} RETURNING Account(Name, Id), Contact(Name, Email, Id), Case(CaseNumber, Subject, Status, Id), Opportunity(Name, StageName, Amount, Id)
      },
      {
        name: 'search_accounts',
        description: 'Search for Salesforce accounts by name or criteria',
        parameters: {
          searchTerm: 'account name or keyword'
        },
        // Example query: SELECT Id, Name, Type, Industry, Phone FROM Account WHERE Name LIKE '%Acme%' LIMIT 10
      },
      {
        name: 'get_account_health',
        description: 'Find accounts with health issues or high case volume',
        parameters: {
          riskLevel: 'high|medium|low'
        },
        // Example query: SELECT Account.Id, Account.Name, COUNT(Id) as CaseCount FROM Case WHERE Priority IN ('High', 'Critical') AND CreatedDate = LAST_30_DAYS GROUP BY Account.Id, Account.Name ORDER BY COUNT(Id) DESC LIMIT 15
      },
      {
        name: 'search_opportunities',
        description: 'Search deals/opportunities in Salesforce',
        parameters: {
          searchTerm: 'opportunity or account name',
          stage: 'won|lost|open (optional)'
        },
        // Example query: SELECT Id, Name, StageName, Amount, Account.Name FROM Opportunity WHERE (Name LIKE '%Microsoft%' OR Account.Name LIKE '%Microsoft%') LIMIT 10
      },
      {
        name: 'search_jira_issues',
        description: 'Search Jira tickets and issues',
        parameters: {
          keywords: 'array of search terms'
        }
      },
      {
        name: 'analyze_case_details',
        description: 'Get full case details and AI analysis of the situation, root cause, and recommendations',
        parameters: {
          caseId: 'Case ID or Case Number to analyze deeply'
        }
      },
      {
        name: 'analyze_account_health',
        description: 'Deep dive into account health with case history analysis and risk assessment',
        parameters: {
          accountId: 'Account ID or Name to analyze'
        }
      },
      {
        name: 'analyze_pattern_trends',
        description: 'AI analysis of patterns across multiple cases/accounts to identify trends',
        parameters: {
          analysisType: 'case_patterns|account_risks|support_trends',
          timeframe: 'this_week|this_month|last_30_days'
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
- "find support cases past days" → search_recent_cases tool with timeframe=last_30_days
- "cases with login problems last 90 days" → search_recent_cases tool with timeframe=last_90_days, keywords=["login"]
- "recent billing issues" → search_recent_cases tool with timeframe=this_month, keywords=["billing"]
- "red accounts" → get_account_health tool with riskLevel=high
- "Microsoft deals" → search_opportunities tool with searchTerm="Microsoft"

IMPORTANT: 
- For ANY request mentioning time periods (recent, past days, last X days, etc.), use search_recent_cases
- For specific keywords + time, use search_recent_cases with both timeframe AND keywords
- Only use search_cases_by_keywords for keyword-only searches without time context

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
      case 'analyze_case_details':
        return await this.analyzeCaseDetails(parameters);
      case 'analyze_account_health':
        return await this.analyzeAccountHealth(parameters);
      case 'analyze_pattern_trends':
        return await this.analyzePatternTrends(parameters);
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
      case 'last_30_days': timeCondition = 'CreatedDate = LAST_N_DAYS:30'; break;
      case 'last_90_days': timeCondition = 'CreatedDate = LAST_N_DAYS:90'; break;
      case 'last_6_months': timeCondition = 'CreatedDate = LAST_N_DAYS:180'; break;
      default: timeCondition = 'CreatedDate = LAST_N_DAYS:30'; // Default to last 30 days
    }

    let conditions = [timeCondition];
    if (params.priority) conditions.push(`Priority = '${params.priority}'`);
    
    // Add keyword filtering if provided
    if (params.keywords && params.keywords.length > 0) {
      const keywordConditions = params.keywords.map(keyword => 
        `(Subject LIKE '%${keyword}%' OR Description LIKE '%${keyword}%')`
      );
      conditions.push(`(${keywordConditions.join(' OR ')})`);
    }

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
      // Validate search term
      if (!params.searchTerm || params.searchTerm.trim() === '') {
        return { toolName: 'search_all_objects', success: false, error: 'Search term is required' };
      }
      
      // Parse search term - could be single word or multiple keywords
      const keywords = params.searchTerm.split(' ').filter(word => word.length > 2);
      
      const allResults = {
        accounts: [],
        contacts: [],
        cases: [],
        opportunities: []
      };
      
      let totalFound = 0;
      
      // Search one keyword at a time for better results
      for (const keyword of keywords.slice(0, 3)) { // Limit to 3 keywords to avoid too many API calls
        try {
          const soslQuery = `FIND {${keyword}} RETURNING Account(Name, Id), Contact(Name, Email, Id), Case(CaseNumber, Subject, Status, Id), Opportunity(Name, StageName, Amount, Id)`;
          
          console.log(`Searching for keyword: ${keyword}`);
          const response = await this.salesforceService.executeSOSLQuery(soslQuery);
          
          if (response.searchRecords && response.searchRecords.length > 0) {
            response.searchRecords.forEach(record => {
              // Avoid duplicates by checking if ID already exists
              const recordId = record.Id;
              
              switch (record.attributes.type) {
                case 'Account':
                  if (!allResults.accounts.find(a => a.Id === recordId)) {
                    allResults.accounts.push(record);
                  }
                  break;
                case 'Contact':
                  if (!allResults.contacts.find(c => c.Id === recordId)) {
                    allResults.contacts.push(record);
                  }
                  break;
                case 'Case':
                  if (!allResults.cases.find(c => c.Id === recordId)) {
                    allResults.cases.push(record);
                  }
                  break;
                case 'Opportunity':
                  if (!allResults.opportunities.find(o => o.Id === recordId)) {
                    allResults.opportunities.push(record);
                  }
                  break;
              }
            });
            
            totalFound += response.searchRecords.length;
            console.log(`Found ${response.searchRecords.length} results for "${keyword}"`);
          }
        } catch (keywordError) {
          console.error(`Search failed for keyword "${keyword}":`, keywordError.message);
          continue; // Try next keyword
        }
      }
      
      return {
        toolName: 'search_all_objects',
        success: true,
        data: allResults,
        count: totalFound,
        breakdown: {
          accounts: allResults.accounts.length,
          contacts: allResults.contacts.length,
          cases: allResults.cases.length,
          opportunities: allResults.opportunities.length
        },
        searchStrategy: `Searched ${keywords.length} keywords individually: ${keywords.join(', ')}`
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

  async analyzeCaseDetails(params) {
    if (!this.salesforceService) {
      throw new Error('Salesforce not connected');
    }

    try {
      // Get full case details including description, comments, history
      const isId = params.caseId.startsWith('500') || params.caseId.length === 18;
      const field = isId ? 'Id' : 'CaseNumber';
      
      const detailQuery = `
        SELECT Id, CaseNumber, Subject, Description, Status, Priority, Type, Reason, Origin,
               CreatedDate, LastModifiedDate, ClosedDate, IsClosed,
               Account.Name, Account.Id, Account.Industry, Account.Type,
               Contact.Name, Contact.Email, Contact.Phone,
               Owner.Name, Owner.Email,
               ParentId, Parent.CaseNumber
        FROM Case 
        WHERE ${field} = '${params.caseId}'
      `;
      
      const caseResponse = await this.salesforceService.executeSOQLQuery(detailQuery);
      
      if (!caseResponse.records || caseResponse.records.length === 0) {
        return { toolName: 'analyze_case_details', success: false, error: `Case ${params.caseId} not found` };
      }
      
      const caseData = caseResponse.records[0];
      
      // Get related cases from same account for context
      const relatedQuery = `
        SELECT Id, CaseNumber, Subject, Status, Priority, CreatedDate
        FROM Case 
        WHERE AccountId = '${caseData.Account?.Id}' 
        AND Id != '${caseData.Id}'
        ORDER BY CreatedDate DESC 
        LIMIT 10
      `;
      
      const relatedResponse = await this.salesforceService.executeSOQLQuery(relatedQuery);
      const relatedCases = relatedResponse.records || [];
      
      // AI analysis of the case
      const analysisPrompt = `
      Analyze this Salesforce support case and provide insights:

      CASE DETAILS:
      - Case Number: ${caseData.CaseNumber}
      - Subject: ${caseData.Subject}
      - Description: ${caseData.Description || 'No description'}
      - Status: ${caseData.Status}
      - Priority: ${caseData.Priority}
      - Type: ${caseData.Type || 'Unknown'}
      - Account: ${caseData.Account?.Name} (${caseData.Account?.Industry})
      - Created: ${caseData.CreatedDate}
      - Owner: ${caseData.Owner?.Name}

      RELATED CASES FROM SAME ACCOUNT:
      ${relatedCases.map(c => `- ${c.CaseNumber}: ${c.Subject} (${c.Status})`).join('\n')}

      Please provide:
      1. Root cause analysis
      2. Severity assessment
      3. Recommended next steps
      4. Pattern analysis (if related cases show trends)
      5. Risk assessment for the account

      Be concise but insightful.
      `;

      const aiAnalysis = await this.callGeminiAPI(analysisPrompt);
      
      return {
        toolName: 'analyze_case_details',
        success: true,
        caseData,
        relatedCases: relatedCases.length,
        aiAnalysis: aiAnalysis.replace(/```.*?\n|\n```/g, '').trim(),
        analysis: 'deep'
      };
      
    } catch (error) {
      return { toolName: 'analyze_case_details', success: false, error: error.message };
    }
  }

  async analyzeAccountHealth(params) {
    if (!this.salesforceService) {
      throw new Error('Salesforce not connected');
    }

    try {
      // Get account details
      const isId = params.accountId.startsWith('001') || params.accountId.length === 18;
      const field = isId ? 'Id' : 'Name';
      const searchValue = isId ? params.accountId : `%${params.accountId}%`;
      const operator = isId ? '=' : 'LIKE';
      
      const accountQuery = `
        SELECT Id, Name, Type, Industry, AnnualRevenue, NumberOfEmployees,
               BillingCity, BillingState, Phone, Website, Description,
               CreatedDate, LastModifiedDate
        FROM Account 
        WHERE ${field} ${operator} '${searchValue}'
        LIMIT 1
      `;
      
      const accountResponse = await this.salesforceService.executeSOQLQuery(accountQuery);
      
      if (!accountResponse.records || accountResponse.records.length === 0) {
        return { toolName: 'analyze_account_health', success: false, error: `Account ${params.accountId} not found` };
      }
      
      const account = accountResponse.records[0];
      
      // Get case history for health analysis
      const caseHistoryQuery = `
        SELECT Id, CaseNumber, Subject, Status, Priority, Type, CreatedDate, ClosedDate,
               CASE WHEN ClosedDate != null THEN 
                 DATEDIFF(ClosedDate, CreatedDate) 
               ELSE 
                 DATEDIFF(TODAY(), CreatedDate) 
               END as DaysOpen
        FROM Case 
        WHERE AccountId = '${account.Id}'
        ORDER BY CreatedDate DESC 
        LIMIT 25
      `;
      
      const caseResponse = await this.salesforceService.executeSOQLQuery(caseHistoryQuery);
      const cases = caseResponse.records || [];
      
      // Get recent opportunities
      const oppQuery = `
        SELECT Id, Name, StageName, Amount, CloseDate, Type, LeadSource
        FROM Opportunity 
        WHERE AccountId = '${account.Id}'
        ORDER BY CreatedDate DESC 
        LIMIT 10
      `;
      
      const oppResponse = await this.salesforceService.executeSOQLQuery(oppQuery);
      const opportunities = oppResponse.records || [];
      
      // AI health analysis
      const healthPrompt = `
      Analyze the health of this Salesforce account:

      ACCOUNT INFO:
      - Name: ${account.Name}
      - Industry: ${account.Industry}
      - Type: ${account.Type}
      - Revenue: ${account.AnnualRevenue || 'Unknown'}
      - Employees: ${account.NumberOfEmployees || 'Unknown'}

      SUPPORT HISTORY (last 25 cases):
      ${cases.map(c => `- ${c.CaseNumber}: ${c.Subject} (${c.Status}, Priority: ${c.Priority})`).join('\n')}

      RECENT OPPORTUNITIES:
      ${opportunities.map(o => `- ${o.Name}: ${o.StageName} ($${o.Amount || 'Unknown'})`).join('\n')}

      Provide a health assessment including:
      1. Overall health score (1-10)
      2. Key risk factors
      3. Support patterns and trends
      4. Business relationship status
      5. Recommended actions

      Be specific and actionable.
      `;

      const aiAnalysis = await this.callGeminiAPI(healthPrompt);
      
      return {
        toolName: 'analyze_account_health',
        success: true,
        account,
        caseCount: cases.length,
        opportunityCount: opportunities.length,
        aiAnalysis: aiAnalysis.replace(/```.*?\n|\n```/g, '').trim(),
        analysis: 'deep'
      };
      
    } catch (error) {
      return { toolName: 'analyze_account_health', success: false, error: error.message };
    }
  }

  async analyzePatternTrends(params) {
    if (!this.salesforceService) {
      throw new Error('Salesforce not connected');
    }

    try {
      let timeCondition = '';
      switch (params.timeframe) {
        case 'this_week': timeCondition = 'CreatedDate = THIS_WEEK'; break;
        case 'this_month': timeCondition = 'CreatedDate = THIS_MONTH'; break;
        case 'last_30_days': timeCondition = 'CreatedDate = LAST_N_DAYS:30'; break;
        default: timeCondition = 'CreatedDate = THIS_MONTH';
      }

      let analysisQuery = '';
      let analysisPrompt = '';
      
      if (params.analysisType === 'case_patterns') {
        analysisQuery = `
          SELECT Type, Priority, Status, COUNT(Id) as CaseCount, 
                 AVG(CASE WHEN ClosedDate != null THEN DATEDIFF(ClosedDate, CreatedDate) END) as AvgDaysToClose
          FROM Case 
          WHERE ${timeCondition}
          GROUP BY Type, Priority, Status
          ORDER BY CaseCount DESC
        `;
        
        analysisPrompt = `Analyze these case patterns and identify trends, bottlenecks, and recommendations for support improvement:`;
      } else if (params.analysisType === 'account_risks') {
        analysisQuery = `
          SELECT Account.Name, Account.Industry, COUNT(Id) as CaseCount,
                 SUM(CASE WHEN Priority = 'High' THEN 1 ELSE 0 END) as HighPriorityCases
          FROM Case 
          WHERE ${timeCondition}
          GROUP BY Account.Name, Account.Industry
          HAVING COUNT(Id) >= 3
          ORDER BY CaseCount DESC, HighPriorityCases DESC
        `;
        
        analysisPrompt = `Identify accounts at risk based on support case volume and priority. Provide risk assessment and intervention recommendations:`;
      }
      
      const response = await this.salesforceService.executeSOQLQuery(analysisQuery);
      const data = response.records || [];
      
      const fullPrompt = `${analysisPrompt}

DATA:
${JSON.stringify(data, null, 2)}

Provide insights on:
1. Key patterns and trends
2. Risk areas requiring attention
3. Operational improvements needed
4. Specific recommendations with priorities
`;

      const aiAnalysis = await this.callGeminiAPI(fullPrompt);
      
      return {
        toolName: 'analyze_pattern_trends',
        success: true,
        analysisType: params.analysisType,
        timeframe: params.timeframe,
        dataPoints: data.length,
        aiAnalysis: aiAnalysis.replace(/```.*?\n|\n```/g, '').trim(),
        analysis: 'trends'
      };
      
    } catch (error) {
      return { toolName: 'analyze_pattern_trends', success: false, error: error.message };
    }
  }

  async conversationalResponse(params) {
    const responses = {
      help: "I can help you search Salesforce cases, accounts, opportunities, and Jira issues. I can also do deep analysis of specific cases or accounts. Try asking about recent cases, specific accounts, or billing issues.",
      greeting: "Hello! I'm your AI assistant for searching Salesforce and Jira data. I can also analyze specific cases and accounts in detail. What would you like to find?",
      explanation: "I can search across your connected data sources and provide intelligent analysis of your support tickets, accounts, and deals. I can drill down into specific records for detailed insights.",
      guidance: "Ask me about recent support cases, account health, opportunities, or specific issues you're tracking. I can also analyze patterns and trends across your data."
    };

    return {
      toolName: 'conversational_response',
      success: true,
      message: responses[params.responseType] || responses.help
    };
  }
}

module.exports = ToolService;