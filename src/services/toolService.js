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
        name: 'search_records',
        description: 'Search any Salesforce object with keywords and filters. Supports keyword discovery via SOSL and structured filtering via SOQL.',
        parameters: {
          object: 'Case|Account|Opportunity|Contact - which Salesforce object to search',
          keywords: 'array of search terms for keyword discovery (optional)',
          timeframe: 'last_30_days|last_90_days|last_6_months|all_time (optional)',
          minAmount: 'minimum amount filter for opportunities (optional)',
          maxAmount: 'maximum amount filter for opportunities (optional)',
          stage: 'Won|Lost|Closed|Open|Negotiation for opportunities (optional)',
          priority: 'High|Medium|Low for cases (optional)',
          status: 'Open|Closed for cases (optional)',
          limit: 'number of results to return (default 20)',
          deepAnalysis: 'true|false - whether to perform LLM analysis of results'
        }
      },
      {
        name: 'analyze_record',
        description: 'Deep analysis of a specific record by ID with comprehensive LLM insights',
        parameters: {
          recordId: 'Salesforce record ID',
          recordType: 'Case|Account|Opportunity|Contact',
          analysisType: 'summary|root_cause|recommendations|patterns|trends|all'
        }
      },
      {
        name: 'cross_object_search',
        description: 'Search across multiple Salesforce objects simultaneously using SOSL',
        parameters: {
          keywords: 'array of search terms to find across objects',
          objects: 'array of objects to search: Case,Account,Opportunity,Contact',
          timeframe: 'last_30_days|last_90_days|all_time (optional)',
          deepAnalysis: 'true|false - whether to perform LLM analysis'
        }
      },
      {
        name: 'conversational_response',
        description: 'Provide helpful guidance or explanation without searching Salesforce data',
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
- "billing issues" → search_records tool with object="Case", keywords=["billing"], timeframe="last_30_days", deepAnalysis="true"
- "opportunities with motor > 25k" → search_records tool with object="Opportunity", keywords=["motor"], minAmount=25000, deepAnalysis="true"
- "recent support cases" → search_records tool with object="Case", timeframe="last_30_days", deepAnalysis="true"
- "analyze case 12345" → analyze_record tool with recordId="12345", recordType="Case", analysisType="all"
- "United Oil & Gas accounts and cases" → cross_object_search tool with keywords=["United", "Oil", "Gas"], objects=["Account", "Case"], deepAnalysis="true"
- "won opportunities last month" → search_records tool with object="Opportunity", stage="Won", timeframe="last_30_days"

IMPORTANT: 
- Use search_records for single object searches (cases, accounts, opportunities, contacts)
- Use cross_object_search when user wants to search across multiple object types
- Use analyze_record for specific record analysis by ID
- Use deepAnalysis="true" when user wants insights, patterns, or understanding
- Keywords trigger SOSL discovery, filters trigger SOQL constraints

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
      case 'search_records':
        return await this.searchRecords(parameters);
      case 'analyze_record':
        return await this.analyzeRecord(parameters);
      case 'cross_object_search':
        return await this.crossObjectSearch(parameters);
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

  // New SOSL Discovery Search - Your brilliant approach!
  async soslDiscoverySearch(params) {
    if (!this.salesforceService) {
      throw new Error('Salesforce not connected');
    }

    try {
      console.log('🔍 SOSL Discovery Search starting:', params);
      
      const allResults = {
        accounts: [],
        contacts: [],
        cases: [],
        opportunities: [],
        searchStrategy: 'SOSL Discovery with Time Filtering and LLM Analysis',
        thinkingSteps: [],
        executedQueries: []
      };

      // Phase 1: SOSL Discovery
      allResults.thinkingSteps.push("🔍 Phase 1: Using SOSL to discover all matching records...");
      
      for (const keyword of params.keywords.slice(0, 3)) {
        try {
          const soslQuery = `FIND {${keyword}} RETURNING Account(Name, Id, Industry, CreatedDate), Contact(Name, Email, Id, CreatedDate), Case(CaseNumber, Subject, Status, Id, CreatedDate, Priority), Opportunity(Name, StageName, Amount, Id, CreatedDate, CloseDate)`;
          
          // Add query to results for Slack display
          allResults.executedQueries.push(`SOSL: ${soslQuery}`);
          allResults.thinkingSteps.push(`🔍 Searching keyword: "${keyword}"`);
          
          console.log(`🔍 SOSL Discovery for keyword: ${keyword}`);
          const response = await this.salesforceService.executeSOSLQuery(soslQuery);
          
          // Add response info to thinking steps
          const recordCount = response.searchRecords ? response.searchRecords.length : 0;
          allResults.thinkingSteps.push(`📊 Found ${recordCount} records for "${keyword}"`);
          
          if (response.searchRecords && response.searchRecords.length > 0) {
            response.searchRecords.forEach(record => {
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
          }
        } catch (keywordError) {
          console.error(`SOSL failed for keyword "${keyword}":`, keywordError.message);
          continue;
        }
      }

      // Phase 2: Time Filtering
      if (params.timeFilter && params.timeFilter !== 'all_time') {
        allResults.thinkingSteps.push(`⏰ Phase 2: Filtering results by ${params.timeFilter}...`);
        
        const cutoffDate = new Date();
        if (params.timeFilter === 'last_30_days') {
          cutoffDate.setDate(cutoffDate.getDate() - 30);
        } else if (params.timeFilter === 'last_90_days') {
          cutoffDate.setDate(cutoffDate.getDate() - 90);
        }
        
        // Filter cases by date
        allResults.cases = allResults.cases.filter(case_ => {
          if (case_.CreatedDate) {
            const caseDate = new Date(case_.CreatedDate);
            return caseDate >= cutoffDate;
          }
          return true; // Keep if no date
        });
        
        allResults.thinkingSteps.push(`✅ Filtered to ${allResults.cases.length} cases within timeframe`);
      }

      // Phase 3: Deep Analysis (if requested)
      if (params.deepAnalysis === 'true' && allResults.cases.length > 0) {
        allResults.thinkingSteps.push("🧠 Phase 3: Performing deep LLM analysis of findings...");
        
        // Get detailed analysis of top cases
        const topCases = allResults.cases.slice(0, 5);
        const analysisPrompt = `
Analyze these Salesforce cases found through keyword search:

Cases Found:
${topCases.map(c => `- ${c.CaseNumber}: ${c.Subject} (${c.Status}, Priority: ${c.Priority})`).join('\n')}

Keywords Searched: ${params.keywords.join(', ')}

Please provide:
1. **Patterns**: What common themes do you see?
2. **Priority Assessment**: Which cases need immediate attention?
3. **Root Cause Insights**: What might be causing these issues?
4. **Recommendations**: What actions should be taken?

Be specific and actionable.
        `;

        try {
          const aiAnalysis = await this.callGeminiAPI(analysisPrompt);
          allResults.deepAnalysis = aiAnalysis.replace(/```.*?\n|\n```/g, '').trim();
          allResults.thinkingSteps.push("✅ Deep analysis complete");
        } catch (error) {
          console.error('Deep analysis failed:', error);
          allResults.deepAnalysis = "Deep analysis failed - but raw results are available";
        }
      }

      const totalFound = allResults.accounts.length + allResults.contacts.length + 
                        allResults.cases.length + allResults.opportunities.length;

      return {
        toolName: 'sosl_discovery_search',
        success: true,
        data: allResults,
        count: totalFound,
        breakdown: {
          accounts: allResults.accounts.length,
          contacts: allResults.contacts.length,
          cases: allResults.cases.length,
          opportunities: allResults.opportunities.length
        },
        deepAnalysisPerformed: params.deepAnalysis === 'true',
        thinkingProcess: allResults.thinkingSteps,
        executedQueries: allResults.executedQueries
      };

    } catch (error) {
      return { toolName: 'sosl_discovery_search', success: false, error: error.message };
    }
  }

  // Deep Record Analysis - Get full context of any record
  async deepRecordAnalysis(params) {
    if (!this.salesforceService) {
      throw new Error('Salesforce not connected');
    }

    try {
      console.log('🕵️ Deep Record Analysis starting:', params);
      
      let query = '';

      // Build query based on record type
      switch (params.recordType) {
        case 'Case':
          query = `
            SELECT Id, CaseNumber, Subject, Description, Status, Priority, Type, Reason, Origin,
                   CreatedDate, LastModifiedDate, ClosedDate, IsClosed,
                   Account.Name, Account.Id, Account.Industry, Account.Type,
                   Contact.Name, Contact.Email, Contact.Phone,
                   Owner.Name, Owner.Email
            FROM Case 
            WHERE Id = '${params.recordId}' OR CaseNumber = '${params.recordId}'
          `;
          break;
        case 'Account':
          query = `
            SELECT Id, Name, Type, Industry, AnnualRevenue, NumberOfEmployees,
                   BillingCity, BillingState, Phone, Website, Description,
                   CreatedDate, LastModifiedDate
            FROM Account 
            WHERE Id = '${params.recordId}' OR Name LIKE '%${params.recordId}%'
            LIMIT 1
          `;
          break;
      }

      const response = await this.salesforceService.executeSOQLQuery(query);
      
      if (!response.records || response.records.length === 0) {
        return { toolName: 'deep_record_analysis', success: false, error: `Record ${params.recordId} not found` };
      }

      const record = response.records[0];

      // Get related records for context
      let relatedRecords = [];
      if (params.recordType === 'Case' && record.Account?.Id) {
        const relatedQuery = `
          SELECT Id, CaseNumber, Subject, Status, Priority, CreatedDate
          FROM Case 
          WHERE AccountId = '${record.Account.Id}' 
          AND Id != '${record.Id}'
          ORDER BY CreatedDate DESC 
          LIMIT 10
        `;
        const relatedResponse = await this.salesforceService.executeSOQLQuery(relatedQuery);
        relatedRecords = relatedResponse.records || [];
      }

      // LLM Analysis
      let aiAnalysis = '';
      if (params.analysisType !== 'none') {
        const analysisPrompt = `
Analyze this ${params.recordType} record in detail:

RECORD DETAILS:
${JSON.stringify(record, null, 2)}

RELATED RECORDS: ${relatedRecords.length} found

Analysis Type: ${params.analysisType}

Provide detailed insights, patterns, and recommendations.
        `;

        try {
          aiAnalysis = await this.callGeminiAPI(analysisPrompt);
        } catch (error) {
          aiAnalysis = 'Analysis failed, but raw data available';
        }
      }

      return {
        toolName: 'deep_record_analysis',
        success: true,
        record,
        relatedRecords: relatedRecords.length,
        aiAnalysis: aiAnalysis.replace(/```.*?\n|\n```/g, '').trim(),
        analysisType: params.analysisType,
        recordType: params.recordType
      };

    } catch (error) {
      return { toolName: 'deep_record_analysis', success: false, error: error.message };
    }
  }

  // Thinking Updates for user feedback
  async thinkingUpdate(params) {
    return {
      toolName: 'thinking_update',
      success: true,
      message: params.thinkingMessage,
      progress: params.progress || null,
      isThinking: true
    };
  }

  // Advanced Opportunity Search - SOSL + SOQL combination
  async advancedOpportunitySearch(params) {
    if (!this.salesforceService) {
      throw new Error('Salesforce not connected');
    }

    try {
      console.log('🎯 Advanced Opportunity Search starting:', params);
      
      let opportunityIds = [];
      let searchStrategy = '';
      let executedQueries = [];
      
      // Phase 1: Keyword Discovery (if keywords provided)
      if (params.keywords && params.keywords.length > 0) {
        searchStrategy = 'SOSL keyword discovery + SOQL filtering';
        
        for (const keyword of params.keywords.slice(0, 3)) {
          try {
            const soslQuery = `FIND {${keyword}} RETURNING Opportunity(Id, Name, StageName, Amount, CloseDate, Account.Name)`;
            console.log(`🔍 SOSL for keyword: ${keyword}`);
            
            // Add query to results for display
            executedQueries.push(`SOSL: ${soslQuery}`);
            
            const response = await this.salesforceService.executeSOSLQuery(soslQuery);
            if (response.searchRecords && response.searchRecords.length > 0) {
              response.searchRecords.forEach(record => {
                if (record.attributes.type === 'Opportunity' && !opportunityIds.includes(record.Id)) {
                  opportunityIds.push(record.Id);
                }
              });
            }
          } catch (error) {
            console.error(`SOSL failed for keyword "${keyword}":`, error.message);
          }
        }
      }
      
      // Phase 2: Build SOQL Filter
      let conditions = [];
      
      // Keyword filter (if we found IDs via SOSL)
      if (opportunityIds.length > 0) {
        conditions.push(`Id IN ('${opportunityIds.join("','")}')`);
      } else if (params.keywords && params.keywords.length > 0) {
        // Fallback to SOQL LIKE if SOSL failed
        const keywordConditions = params.keywords.map(keyword => 
          `(Name LIKE '%${keyword}%' OR Description LIKE '%${keyword}%')`
        );
        conditions.push(`(${keywordConditions.join(' OR ')})`);
        searchStrategy = 'SOQL keyword + structured filtering';
      } else {
        searchStrategy = 'Pure SOQL structured filtering';
      }
      
      // Amount filters
      if (params.minAmount) {
        conditions.push(`Amount >= ${params.minAmount}`);
      }
      if (params.maxAmount) {
        conditions.push(`Amount <= ${params.maxAmount}`);
      }
      
      // Stage filters
      if (params.stage) {
        if (params.stage === 'Won') {
          conditions.push('IsWon = true');
        } else if (params.stage === 'Lost') {
          conditions.push('IsWon = false AND IsClosed = true');
        } else if (params.stage === 'Closed') {
          conditions.push('IsClosed = true');
        } else if (params.stage === 'Open') {
          conditions.push('IsClosed = false');
        } else {
          conditions.push(`StageName = '${params.stage}'`);
        }
      }
      
      // Time filters
      if (params.timeframe) {
        if (params.timeframe === 'last_30_days') {
          conditions.push('CreatedDate = LAST_N_DAYS:30');
        } else if (params.timeframe === 'last_90_days') {
          conditions.push('CreatedDate = LAST_N_DAYS:90');
        }
      }
      
      // Build final query
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const soqlQuery = `
        SELECT Id, Name, StageName, Amount, CloseDate, CreatedDate, 
               Account.Name, Account.Id, Type, LeadSource, Probability
        FROM Opportunity 
        ${whereClause}
        ORDER BY Amount DESC NULLS LAST, CreatedDate DESC 
        LIMIT 25
      `;
      
      console.log('📊 Final SOQL Query:', soqlQuery);
      
      // Add final SOQL query to results for display
      executedQueries.push(`SOQL: ${soqlQuery.replace(/\s+/g, ' ').trim()}`);
      
      const response = await this.salesforceService.executeSOQLQuery(soqlQuery);
      
      return {
        toolName: 'advanced_opportunity_search',
        success: true,
        data: response.records || [],
        count: response.totalSize || 0,
        searchStrategy,
        query: soqlQuery,
        executedQueries,
        filters: {
          keywords: params.keywords,
          minAmount: params.minAmount,
          maxAmount: params.maxAmount,
          stage: params.stage,
          timeframe: params.timeframe
        }
      };
      
    } catch (error) {
      return { toolName: 'advanced_opportunity_search', success: false, error: error.message };
    }
  }

  // Advanced Account Search with Health Analysis
  async advancedAccountSearch(params) {
    if (!this.salesforceService) {
      throw new Error('Salesforce not connected');
    }

    try {
      console.log('🏢 Advanced Account Search starting:', params);
      
      let accountIds = [];
      let searchStrategy = '';
      
      // Phase 1: Keyword Discovery (if keywords provided)
      if (params.keywords && params.keywords.length > 0) {
        searchStrategy = 'SOSL keyword discovery + health analysis';
        
        for (const keyword of params.keywords.slice(0, 3)) {
          try {
            const soslQuery = `FIND {${keyword}} RETURNING Account(Id, Name, Industry, Type)`;
            console.log(`🔍 SOSL for keyword: ${keyword}`);
            
            const response = await this.salesforceService.executeSOSLQuery(soslQuery);
            if (response.searchRecords && response.searchRecords.length > 0) {
              response.searchRecords.forEach(record => {
                if (record.attributes.type === 'Account' && !accountIds.includes(record.Id)) {
                  accountIds.push(record.Id);
                }
              });
            }
          } catch (error) {
            console.error(`SOSL failed for keyword "${keyword}":`, error.message);
          }
        }
      }
      
      // Phase 2: Get Account Details
      let conditions = [];
      if (accountIds.length > 0) {
        conditions.push(`Id IN ('${accountIds.join("','")}')`);
      } else if (params.keywords && params.keywords.length > 0) {
        const keywordConditions = params.keywords.map(keyword => 
          `Name LIKE '%${keyword}%'`
        );
        conditions.push(`(${keywordConditions.join(' OR ')})`);
        searchStrategy = 'SOQL keyword search + health analysis';
      } else {
        searchStrategy = 'All accounts health analysis';
      }
      
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const accountQuery = `
        SELECT Id, Name, Type, Industry, AnnualRevenue, NumberOfEmployees,
               BillingCity, BillingState, Phone, Website, CreatedDate
        FROM Account 
        ${whereClause}
        ORDER BY Name 
        LIMIT 20
      `;
      
      const accountResponse = await this.salesforceService.executeSOQLQuery(accountQuery);
      const accounts = accountResponse.records || [];
      
      // Phase 3: Health Analysis (if requested)
      let healthData = [];
      if (params.analysisDepth === 'full' && accounts.length > 0) {
        const accountIdList = accounts.map(a => a.Id);
        const healthQuery = `
          SELECT AccountId, Account.Name, COUNT(Id) as CaseCount,
                 SUM(CASE WHEN Priority = 'High' THEN 1 ELSE 0 END) as HighPriorityCases,
                 MAX(CreatedDate) as LastCaseDate
          FROM Case 
          WHERE AccountId IN ('${accountIdList.join("','")}')
          AND CreatedDate = LAST_N_DAYS:90
          GROUP BY AccountId, Account.Name
          ORDER BY CaseCount DESC
        `;
        
        const healthResponse = await this.salesforceService.executeSOQLQuery(healthQuery);
        healthData = healthResponse.records || [];
      }
      
      // Phase 4: Include Contacts (if requested)
      let contactData = [];
      if (params.includeContacts === 'true' && accounts.length > 0) {
        const accountIdList = accounts.map(a => a.Id);
        const contactQuery = `
          SELECT Id, Name, Email, Phone, Title, AccountId, Account.Name
          FROM Contact 
          WHERE AccountId IN ('${accountIdList.join("','")}')
          ORDER BY Account.Name, Name
          LIMIT 50
        `;
        
        const contactResponse = await this.salesforceService.executeSOQLQuery(contactQuery);
        contactData = contactResponse.records || [];
      }
      
      return {
        toolName: 'advanced_account_search',
        success: true,
        data: {
          accounts,
          healthData,
          contactData
        },
        count: accounts.length,
        searchStrategy,
        filters: {
          keywords: params.keywords,
          healthFilter: params.healthFilter,
          includeContacts: params.includeContacts,
          analysisDepth: params.analysisDepth
        }
      };
      
    } catch (error) {
      return { toolName: 'advanced_account_search', success: false, error: error.message };
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

  // NEW SIMPLIFIED TOOLS

  async searchRecords(params) {
    if (!this.salesforceService) {
      throw new Error('Salesforce not connected');
    }

    try {
      const executedQueries = [];
      let results = [];
      let searchStrategy = '';

      // Determine search strategy
      if (params.keywords && params.keywords.length > 0) {
        searchStrategy = 'SOSL keyword discovery + SOQL filtering';
        
        // Phase 1: SOSL Discovery
        const discoveredIds = [];
        for (const keyword of params.keywords.slice(0, 3)) {
          const soslQuery = `FIND {${keyword}} RETURNING ${params.object}(Id)`;
          executedQueries.push(`SOSL: ${soslQuery}`);
          
          const response = await this.salesforceService.executeSOSLQuery(soslQuery);
          if (response.searchRecords) {
            response.searchRecords.forEach(record => {
              if (!discoveredIds.includes(record.Id)) {
                discoveredIds.push(record.Id);
              }
            });
          }
        }

        // Phase 2: SOQL with filters
        if (discoveredIds.length > 0) {
          const soqlQuery = this.buildSOQLQuery(params, discoveredIds);
          executedQueries.push(`SOQL: ${soqlQuery}`);
          const response = await this.salesforceService.executeSOQLQuery(soqlQuery);
          results = response.records || [];
        }
      } else {
        searchStrategy = 'Direct SOQL filtering';
        
        // Direct SOQL query
        const soqlQuery = this.buildSOQLQuery(params);
        executedQueries.push(`SOQL: ${soqlQuery}`);
        const response = await this.salesforceService.executeSOQLQuery(soqlQuery);
        results = response.records || [];
      }

      // Deep analysis if requested
      let deepAnalysis = null;
      if (params.deepAnalysis === 'true' && results.length > 0) {
        deepAnalysis = await this.performDeepAnalysis(results, params.object);
      }

      return {
        toolName: 'search_records',
        success: true,
        data: results,
        count: results.length,
        searchStrategy,
        executedQueries,
        deepAnalysis
      };

    } catch (error) {
      return { toolName: 'search_records', success: false, error: error.message };
    }
  }

  async analyzeRecord(params) {
    if (!this.salesforceService) {
      throw new Error('Salesforce not connected');
    }

    try {
      const executedQueries = [];
      
      // Get record details
      const query = this.buildRecordQuery(params.recordType, params.recordId);
      executedQueries.push(`SOQL: ${query}`);
      
      const response = await this.salesforceService.executeSOQLQuery(query);
      const record = response.records && response.records[0];
      
      if (!record) {
        return { toolName: 'analyze_record', success: false, error: 'Record not found' };
      }

      // Perform AI analysis
      const analysis = await this.performRecordAnalysis(record, params.recordType, params.analysisType);

      return {
        toolName: 'analyze_record',
        success: true,
        record,
        analysis,
        executedQueries
      };

    } catch (error) {
      return { toolName: 'analyze_record', success: false, error: error.message };
    }
  }

  async crossObjectSearch(params) {
    if (!this.salesforceService) {
      throw new Error('Salesforce not connected');
    }

    try {
      const executedQueries = [];
      const allResults = {
        accounts: [],
        contacts: [],
        cases: [],
        opportunities: []
      };

      // Build SOSL query for multiple objects
      const objectsToSearch = params.objects || ['Account', 'Contact', 'Case', 'Opportunity'];
      const soslParts = objectsToSearch.map(obj => {
        const fields = this.getFieldsForObject(obj);
        return `${obj}(${fields})`;
      });

      for (const keyword of params.keywords.slice(0, 3)) {
        const soslQuery = `FIND {${keyword}} RETURNING ${soslParts.join(', ')}`;
        executedQueries.push(`SOSL: ${soslQuery}`);
        
        const response = await this.salesforceService.executeSOSLQuery(soslQuery);
        
        if (response.searchRecords) {
          response.searchRecords.forEach(record => {
            const type = record.attributes.type;
            const recordId = record.Id;
            
            switch (type) {
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
        }
      }

      // Time filtering if specified
      if (params.timeframe && params.timeframe !== 'all_time') {
        allResults.cases = this.filterByTime(allResults.cases, params.timeframe);
        allResults.opportunities = this.filterByTime(allResults.opportunities, params.timeframe);
      }

      // Deep analysis if requested
      let deepAnalysis = null;
      if (params.deepAnalysis === 'true') {
        deepAnalysis = await this.performCrossObjectAnalysis(allResults);
      }

      const totalCount = allResults.accounts.length + allResults.contacts.length + 
                        allResults.cases.length + allResults.opportunities.length;

      return {
        toolName: 'cross_object_search',
        success: true,
        data: allResults,
        count: totalCount,
        breakdown: {
          accounts: allResults.accounts.length,
          contacts: allResults.contacts.length,
          cases: allResults.cases.length,
          opportunities: allResults.opportunities.length
        },
        executedQueries,
        deepAnalysis
      };

    } catch (error) {
      return { toolName: 'cross_object_search', success: false, error: error.message };
    }
  }

  // Helper methods
  buildSOQLQuery(params, idFilter = null) {
    const object = params.object;
    const fields = this.getFieldsForObject(object);
    let conditions = [];

    // ID filter from SOSL discovery
    if (idFilter && idFilter.length > 0) {
      const idList = idFilter.map(id => `'${id}'`).join(',');
      conditions.push(`Id IN (${idList})`);
    }

    // Time filter
    if (params.timeframe && params.timeframe !== 'all_time') {
      const timeCondition = this.getTimeCondition(params.timeframe);
      conditions.push(timeCondition);
    }

    // Object-specific filters
    if (object === 'Opportunity') {
      if (params.minAmount) conditions.push(`Amount >= ${params.minAmount}`);
      if (params.maxAmount) conditions.push(`Amount <= ${params.maxAmount}`);
      if (params.stage === 'Won') conditions.push('IsWon = true');
      if (params.stage === 'Lost') conditions.push('IsWon = false AND IsClosed = true');
      if (params.stage === 'Open') conditions.push('IsClosed = false');
    }

    if (object === 'Case') {
      if (params.priority) conditions.push(`Priority = '${params.priority}'`);
      if (params.status) conditions.push(`Status = '${params.status}'`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = params.limit || 20;
    
    return `SELECT ${fields} FROM ${object} ${whereClause} ORDER BY CreatedDate DESC LIMIT ${limit}`;
  }

  getFieldsForObject(object) {
    const fieldMap = {
      'Case': 'Id, CaseNumber, Subject, Status, Priority, CreatedDate, Account.Name, Contact.Name',
      'Account': 'Id, Name, Industry, Type, Phone, CreatedDate',
      'Opportunity': 'Id, Name, StageName, Amount, CloseDate, CreatedDate, Account.Name',
      'Contact': 'Id, Name, Email, Phone, Title, CreatedDate, Account.Name'
    };
    return fieldMap[object] || 'Id, Name, CreatedDate';
  }

  getTimeCondition(timeframe) {
    switch (timeframe) {
      case 'last_30_days': return 'CreatedDate = LAST_N_DAYS:30';
      case 'last_90_days': return 'CreatedDate = LAST_N_DAYS:90';
      case 'last_6_months': return 'CreatedDate = LAST_N_DAYS:180';
      default: return 'CreatedDate = LAST_N_DAYS:30';
    }
  }

  buildRecordQuery(recordType, recordId) {
    const fields = this.getFieldsForObject(recordType);
    return `SELECT ${fields} FROM ${recordType} WHERE Id = '${recordId}'`;
  }

  filterByTime(records, timeframe) {
    if (!timeframe || timeframe === 'all_time') return records;
    
    const cutoffDate = new Date();
    if (timeframe === 'last_30_days') cutoffDate.setDate(cutoffDate.getDate() - 30);
    else if (timeframe === 'last_90_days') cutoffDate.setDate(cutoffDate.getDate() - 90);
    else if (timeframe === 'last_6_months') cutoffDate.setDate(cutoffDate.getDate() - 180);
    
    return records.filter(record => {
      if (record.CreatedDate) {
        return new Date(record.CreatedDate) >= cutoffDate;
      }
      return true;
    });
  }

  async performDeepAnalysis(results, objectType) {
    try {
      const analysisPrompt = `
Analyze these Salesforce ${objectType} records:

${results.slice(0, 5).map((record, i) => {
  if (objectType === 'Case') {
    return `${i + 1}. ${record.CaseNumber}: ${record.Subject} (${record.Status}, Priority: ${record.Priority})`;
  } else if (objectType === 'Opportunity') {
    return `${i + 1}. ${record.Name}: $${record.Amount} (${record.StageName})`;
  } else if (objectType === 'Account') {
    return `${i + 1}. ${record.Name} (${record.Industry || 'Unknown'})`;
  } else {
    return `${i + 1}. ${record.Name}`;
  }
}).join('\n')}

Provide insights about patterns, priorities, and recommendations.
      `;

      return await this.callGeminiAPI(analysisPrompt);
    } catch (error) {
      return 'Analysis failed but raw results are available';
    }
  }

  async performRecordAnalysis(record, recordType, analysisType) {
    try {
      const analysisPrompt = `
Analyze this Salesforce ${recordType}:

${JSON.stringify(record, null, 2)}

Focus on: ${analysisType}

Provide specific insights and recommendations.
      `;

      return await this.callGeminiAPI(analysisPrompt);
    } catch (error) {
      return 'Analysis failed but record details are available';
    }
  }

  async performCrossObjectAnalysis(results) {
    try {
      const analysisPrompt = `
Analyze these cross-object Salesforce results:

Accounts: ${results.accounts.length}
Contacts: ${results.contacts.length}  
Cases: ${results.cases.length}
Opportunities: ${results.opportunities.length}

Identify relationships, patterns, and insights across these objects.
      `;

      return await this.callGeminiAPI(analysisPrompt);
    } catch (error) {
      return 'Cross-object analysis failed but individual results are available';
    }
  }
}

module.exports = ToolService;