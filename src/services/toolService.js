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
        name: 'search_salesforce',
        description: 'Search Salesforce for cases, accounts, opportunities, or contacts with specific filters and criteria.',
        parameters: {
          // Object types to search
          objectTypes: 'array of object types to search: ["Case", "Account", "Opportunity", "Contact"] or "all" for cross-object search',
          
          // Keywords for text search
          keywords: 'array of keywords to search for (e.g., ["United Oil", "Gas", "Singapore"])',
          
          // Time-based filters
          timeRange: 'time filter: "today", "yesterday", "this_week", "this_month", "last_30_days", "last_90_days", "last_6_months", "all_time"',
          
          // Opportunity-specific filters
          opportunityStage: 'opportunity stage filter: "open", "closed", "won", "lost", "in_flight"',
          minAmount: 'minimum dollar amount for opportunities (e.g., 25000)',
          maxAmount: 'maximum dollar amount for opportunities (e.g., 100000)',
          
          // Case-specific filters
          caseStatus: 'case status filter: "open", "closed", "escalated"',
          casePriority: 'case priority filter: "low", "medium", "high", "critical"',
          
          // Account-specific filters
          accountType: 'account type filter: "customer", "prospect", "partner", "internal"',
          accountHealth: 'account health filter: "green", "yellow", "red"',
          
          // Contact-specific filters
          contactRole: 'contact role filter: "internal", "representative", "decision_maker"',
          
          // Analysis depth
          deepAnalysis: 'true|false - whether to provide AI analysis of results'
        }
      },
      {
        name: 'ask_clarification',
        description: 'Ask the user for more specific information when the request is unclear or ambiguous',
        parameters: {
          question: 'specific question to ask the user for clarification'
        }
      },
      {
        name: 'direct_response',
        description: 'Provide a helpful response without searching data - for greetings, help, explanations, or guidance',
        parameters: {
          response: 'helpful response text'
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
- "help me" → direct_response tool
- "billing issues" → search_salesforce tool with query="billing issues in support cases", deepAnalysis="true"
- "opportunities with motor > 25k" → search_salesforce tool with query="opportunities with motor keyword over $25,000", deepAnalysis="true"
- "recent support cases" → search_salesforce tool with query="recent support cases last 30 days", deepAnalysis="true"
- "what's going on" → ask_clarification tool asking "What specifically would you like to know about? For example: recent cases, opportunities, account status, etc."
- "United Oil & Gas" → search_salesforce tool with query="United Oil Gas accounts cases opportunities", deepAnalysis="true"
- "won opportunities last month" → search_salesforce tool with query="won opportunities last 30 days", deepAnalysis="true"

IMPORTANT: 
- Use search_salesforce for any data lookup from Salesforce
- Use ask_clarification when the request is vague or needs more context
- Use direct_response for greetings, help, explanations that don't need data
- Always include deepAnalysis="true" when user wants insights or understanding

Return ONLY JSON, no markdown.
    `;

    try {
      const response = await this.callGeminiAPI(prompt);
      const cleanResponse = response.replace(/```json\n|\n```|```/g, '').trim();
      return JSON.parse(cleanResponse);
    } catch (error) {
      console.error('Tool selection failed:', error);
      throw error;
    }
  }

  async callGeminiAPI(prompt) {
    const axios = require('axios');
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${process.env.GEMINI_API_KEY}`,
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

  async executeTool(toolName, parameters) {
    switch (toolName) {
      case 'search_salesforce':
        return await this.searchSalesforce(parameters);
      case 'ask_clarification':
        return await this.askClarification(parameters);
      case 'direct_response':
        return await this.directResponse(parameters);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  // Implement search_salesforce using combined SOQL + SOSL approach
  async searchSalesforce(params) {
    if (!this.salesforceService) {
      throw new Error('Salesforce not connected');
    }

    try {
      console.log('🔍 Search Salesforce starting with params:', params);
      
      // Determine search strategy based on parameters
      const hasKeywords = params.keywords && params.keywords.length > 0;
      const hasStructuredFilters = params.timeRange || params.opportunityStage || params.minAmount || 
                                  params.maxAmount || params.caseStatus || params.casePriority || 
                                  params.accountType || params.accountHealth || params.contactRole;
      
      let searchResults = {};
      
      // Strategy 1: Combined SOSL + SOQL (keywords + structured filters)
      if (hasKeywords && hasStructuredFilters) {
        console.log('📊 Using combined SOSL + SOQL strategy');
        searchResults = await this.searchWithSOSLAndSOQL(params);
      }
      // Strategy 2: Pure SOQL (structured filters only)
      else if (!hasKeywords && hasStructuredFilters) {
        console.log('📊 Using pure SOQL strategy');
        searchResults = await this.searchWithSOQLOnly(params);
      }
      // Strategy 3: Pure SOSL (keywords only, cross-object)
      else if (hasKeywords && !hasStructuredFilters) {
        console.log('📊 Using pure SOSL strategy');
        searchResults = await this.searchWithSOSLOnly(params);
      }
      // Strategy 4: Default fallback
      else {
        console.log('📊 Using default search strategy');
        searchResults = await this.searchWithDefaultStrategy(params);
      }

      // Deep analysis if requested
      let analysis = null;
      if (params.deepAnalysis === 'true' || params.deepAnalysis === true) {
        analysis = await this.performDeepAnalysis(searchResults, params);
      }

      return {
        success: true,
        toolName: 'search_salesforce',
        data: searchResults,
        deepAnalysis: analysis,
        searchStrategy: this.getSearchStrategy(params),
        parameters: params
      };

    } catch (error) {
      console.error('Search Salesforce error:', error);
      return {
        success: false,
        toolName: 'search_salesforce',
        error: error.message
      };
    }
  }

  // Strategy 1: SOSL for discovery + SOQL for filtering
  async searchWithSOSLAndSOQL(params) {
    const results = { accounts: [], contacts: [], cases: [], opportunities: [] };
    
    // Determine which objects to search
    const objectTypes = this.getObjectTypesToSearch(params.objectTypes);
    
    for (const objectType of objectTypes) {
      try {
        // Step 1: SOSL discovery
        const soslIds = await this.discoverRecordsWithSOSL(objectType, params.keywords);
        
        if (soslIds.length > 0) {
          // Step 2: SOQL filtering with structured criteria
          const filteredRecords = await this.filterRecordsWithSOQL(objectType, soslIds, params);
          results[`${objectType.toLowerCase()}s`] = filteredRecords;
        }
      } catch (error) {
        console.error(`Error searching ${objectType}:`, error.message);
      }
    }
    
    return results;
  }

  // Strategy 2: Pure SOQL with structured filters
  async searchWithSOQLOnly(params) {
    const results = { accounts: [], contacts: [], cases: [], opportunities: [] };
    const objectTypes = this.getObjectTypesToSearch(params.objectTypes);
    
    for (const objectType of objectTypes) {
      try {
        const soqlQuery = this.buildSOQLQuery(objectType, params);
        const response = await this.salesforceService.executeSOQLQuery(soqlQuery);
        results[`${objectType.toLowerCase()}s`] = response.records || [];
      } catch (error) {
        console.error(`Error searching ${objectType}:`, error.message);
      }
    }
    
    return results;
  }

  // Strategy 3: Pure SOSL for cross-object keyword search
  async searchWithSOSLOnly(params) {
    const keywordString = this.sanitizeKeywords(params.keywords).join(' ');
    const soslQuery = `FIND {${keywordString}} RETURNING Account(Id, Name, Industry), Contact(Id, Name, Email), Case(Id, CaseNumber, Subject, Status), Opportunity(Id, Name, StageName, Amount)`;
    
    try {
      const soslResult = await this.salesforceService.executeSOSLQuery(soslQuery);
      
      if (soslResult.searchRecords) {
        return {
          accounts: soslResult.searchRecords.filter(r => r.attributes.type === 'Account'),
          contacts: soslResult.searchRecords.filter(r => r.attributes.type === 'Contact'),
          cases: soslResult.searchRecords.filter(r => r.attributes.type === 'Case'),
          opportunities: soslResult.searchRecords.filter(r => r.attributes.type === 'Opportunity')
        };
      }
    } catch (error) {
      console.error('SOSL search failed:', error.message);
    }
    
    return { accounts: [], contacts: [], cases: [], opportunities: [] };
  }

  // Strategy 4: Default fallback
  async searchWithDefaultStrategy(params) {
    // Default to searching cases with basic criteria
    const defaultQuery = `SELECT Id, CaseNumber, Subject, Status, Priority, CreatedDate, Account.Name FROM Case ORDER BY CreatedDate DESC LIMIT 20`;
    
    try {
      const response = await this.salesforceService.executeSOQLQuery(defaultQuery);
      return { cases: response.records || [], accounts: [], contacts: [], opportunities: [] };
    } catch (error) {
      console.error('Default search failed:', error.message);
      return { accounts: [], contacts: [], cases: [], opportunities: [] };
    }
  }

  // Helper: Discover records using SOSL
  async discoverRecordsWithSOSL(objectType, keywords) {
    const keywordString = this.sanitizeKeywords(keywords).join(' ');
    const soslQuery = `FIND {${keywordString}} RETURNING ${objectType}(Id)`;
    
    try {
      const response = await this.salesforceService.executeSOSLQuery(soslQuery);
      return response.searchRecords ? response.searchRecords.map(r => r.Id) : [];
    } catch (error) {
      console.error(`SOSL discovery failed for ${objectType}:`, error.message);
      return [];
    }
  }

  // Helper: Filter records using SOQL
  async filterRecordsWithSOQL(objectType, recordIds, params) {
    const soqlQuery = this.buildSOQLQuery(objectType, params, recordIds);
    
    try {
      const response = await this.salesforceService.executeSOQLQuery(soqlQuery);
      return response.records || [];
    } catch (error) {
      console.error(`SOQL filtering failed for ${objectType}:`, error.message);
      return [];
    }
  }

  // Helper: Build SOQL query with all filters
  buildSOQLQuery(objectType, params, recordIds = null) {
    let conditions = [];
    
    // ID filter from SOSL results
    if (recordIds && recordIds.length > 0) {
      conditions.push(`Id IN ('${recordIds.join("','")}')`);
    }
    
    // Time-based filters
    if (params.timeRange && params.timeRange !== 'all_time') {
      conditions.push(this.getTimeCondition(params.timeRange));
    }
    
    // Object-specific filters
    switch (objectType) {
      case 'Opportunity':
        conditions.push(...this.getOpportunityFilters(params));
        break;
      case 'Case':
        conditions.push(...this.getCaseFilters(params));
        break;
      case 'Account':
        conditions.push(...this.getAccountFilters(params));
        break;
      case 'Contact':
        conditions.push(...this.getContactFilters(params));
        break;
    }
    
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const fields = this.getFieldsForObject(objectType);
    
    return `SELECT ${fields} FROM ${objectType} ${whereClause} ORDER BY CreatedDate DESC LIMIT 50`;
  }

  // Helper: Get time condition for SOQL
  getTimeCondition(timeRange) {
    const timeMap = {
      'today': 'CreatedDate = TODAY',
      'yesterday': 'CreatedDate = YESTERDAY',
      'this_week': 'CreatedDate = THIS_WEEK',
      'this_month': 'CreatedDate = THIS_MONTH',
      'last_30_days': 'CreatedDate = LAST_N_DAYS:30',
      'last_90_days': 'CreatedDate = LAST_N_DAYS:90',
      'last_6_months': 'CreatedDate = LAST_N_DAYS:180'
    };
    return timeMap[timeRange] || 'CreatedDate = LAST_N_DAYS:30';
  }

  // Helper: Get opportunity-specific filters
  getOpportunityFilters(params) {
    const filters = [];
    
    if (params.opportunityStage) {
      switch (params.opportunityStage) {
        case 'open':
          filters.push('IsClosed = false');
          break;
        case 'closed':
          filters.push('IsClosed = true');
          break;
        case 'won':
          filters.push('IsWon = true');
          break;
        case 'lost':
          filters.push('IsWon = false AND IsClosed = true');
          break;
        case 'in_flight':
          filters.push('IsClosed = false AND StageName NOT IN (\'Closed Won\', \'Closed Lost\')');
          break;
      }
    }
    
    if (params.minAmount) {
      filters.push(`Amount >= ${params.minAmount}`);
    }
    
    if (params.maxAmount) {
      filters.push(`Amount <= ${params.maxAmount}`);
    }
    
    return filters;
  }

  // Helper: Get case-specific filters
  getCaseFilters(params) {
    const filters = [];
    
    if (params.caseStatus) {
      switch (params.caseStatus) {
        case 'open':
          filters.push('IsClosed = false');
          break;
        case 'closed':
          filters.push('IsClosed = true');
          break;
        case 'escalated':
          filters.push('IsEscalated = true');
          break;
      }
    }
    
    if (params.casePriority) {
      filters.push(`Priority = '${params.casePriority}'`);
    }
    
    return filters;
  }

  // Helper: Get account-specific filters
  getAccountFilters(params) {
    const filters = [];
    
    if (params.accountType) {
      filters.push(`Type = '${params.accountType}'`);
    }
    
    if (params.accountHealth) {
      // This would need to be mapped to actual field values in your Salesforce
      filters.push(`Health__c = '${params.accountHealth}'`);
    }
    
    return filters;
  }

  // Helper: Get contact-specific filters
  getContactFilters(params) {
    const filters = [];
    
    if (params.contactRole) {
      // This would need to be mapped to actual field values in your Salesforce
      filters.push(`Role__c = '${params.contactRole}'`);
    }
    
    return filters;
  }

  // Helper: Get object types to search
  getObjectTypesToSearch(objectTypes) {
    if (objectTypes === 'all' || !objectTypes) {
      return ['Account', 'Contact', 'Case', 'Opportunity'];
    }
    return Array.isArray(objectTypes) ? objectTypes : [objectTypes];
  }

  // Helper: Get fields for each object type
  getFieldsForObject(objectType) {
    const fieldMap = {
      'Case': 'Id, CaseNumber, Subject, Status, Priority, CreatedDate, Account.Name, Contact.Name',
      'Account': 'Id, Name, Industry, Type, Phone, CreatedDate',
      'Opportunity': 'Id, Name, StageName, Amount, CloseDate, CreatedDate, Account.Name',
      'Contact': 'Id, Name, Email, Phone, Title, CreatedDate, Account.Name'
    };
    return fieldMap[objectType] || 'Id, Name, CreatedDate';
  }

  // Helper: Sanitize keywords (handle special characters like &)
  sanitizeKeywords(keywords) {
    return keywords.map(keyword => 
      keyword.replace(/[&%*?~]/g, ' ')  // Replace special chars with spaces
             .replace(/\s+/g, ' ')       // Normalize multiple spaces
             .trim()
    ).filter(keyword => keyword.length > 0);
  }

  // Helper: Get search strategy description
  getSearchStrategy(params) {
    const hasKeywords = params.keywords && params.keywords.length > 0;
    const hasFilters = params.timeRange || params.opportunityStage || params.minAmount;
    
    if (hasKeywords && hasFilters) {
      return 'SOSL Discovery + SOQL Filtering';
    } else if (hasKeywords) {
      return 'Pure SOSL Cross-Object Search';
    } else if (hasFilters) {
      return 'Pure SOQL Structured Search';
    } else {
      return 'Default Fallback Search';
    }
  }

  // Helper: Perform deep analysis
  async performDeepAnalysis(results, params) {
    try {
      const totalResults = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
      
      if (totalResults === 0) {
        return "No results found matching your search criteria. Try different keywords or broader search terms.";
      }
      
      const analysisPrompt = `
Analyze these Salesforce search results:

Search Parameters: ${JSON.stringify(params, null, 2)}

Results Found:
${Object.entries(results).map(([type, records]) => 
  `${type}: ${records.length} records`
).join('\n')}

Sample Records:
${Object.entries(results).slice(0, 3).map(([type, records]) => 
  records.slice(0, 2).map(record => 
    `${type}: ${record.Name || record.CaseNumber || record.Subject || 'N/A'}`
  ).join('\n')
).join('\n')}

Provide insights about patterns, priorities, and recommendations based on the search criteria.
      `;
      
      return await this.callGeminiAPI(analysisPrompt);
    } catch (error) {
      return 'Analysis failed but raw results are available';
    }
  }

  async askClarification(params) {
    return {
      success: true,
      toolName: 'ask_clarification',
      data: params.question,
      needsClarification: true
    };
  }

  async directResponse(params) {
    return {
      success: true,
      toolName: 'direct_response',
      data: params.response
    };
  }
  
}

module.exports = ToolService;