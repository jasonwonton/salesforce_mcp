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

  // Simplified search: SOSL first (if keywords), then SOQL filtering
  async searchSalesforce(params) {
    if (!this.salesforceService) {
      throw new Error('Salesforce not connected');
    }

    try {
      console.log('🔍 Search Salesforce starting with params:', JSON.stringify(params, null, 2));
      
      // Parse natural language query if only 'query' parameter is provided
      let parsedParams = params;
      if (params.query && !params.keywords && !params.objectTypes) {
        console.log('🔄 Parsing natural language query:', params.query);
        parsedParams = this.parseNaturalLanguageQuery(params.query);
        console.log('✅ Parsed parameters:', JSON.stringify(parsedParams, null, 2));
      }
      
      // Use LLM to determine search strategy
      const searchStrategy = await this.hasSearchableKeywordsLLM(parsedParams, params.query || '');
      console.log('🧠 LLM search strategy:', searchStrategy);
      
      // Override object types with LLM decision
      const finalParams = { 
        ...parsedParams, 
        objectTypes: searchStrategy.objectTypes 
      };
      
      // Initialize query tracking
      this.lastExecutedQueries = [];
      
      let searchResults = {};
      let strategy = '';
      
      if (searchStrategy.hasKeywords) {
        // Strategy 1: SOSL discovery → SOQL filtering
        console.log('🔍 Using SOSL → SOQL strategy');
        console.log('📝 Short keywords for SOSL:', searchStrategy.shortKeywords);
        console.log('🎯 Target objects:', searchStrategy.objectTypes);
        strategy = 'SOSL Discovery + SOQL Filtering';
        searchResults = await this.searchSOSLThenSOQL(finalParams, searchStrategy.shortKeywords);
      } else {
        // Strategy 2: Direct SOQL with all filters
        console.log('📊 Using direct SOQL strategy (no searchable keywords)');
        console.log('🎯 Target objects:', searchStrategy.objectTypes);
        strategy = 'Direct SOQL with Filters';
        searchResults = await this.searchWithSOQLOnly(finalParams);
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
        searchStrategy: strategy,
        parameters: params,
        executedQueries: this.lastExecutedQueries || []
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

  // Use LLM to determine if query has searchable keywords and extract short ones
  async hasSearchableKeywordsLLM(params, originalQuery) {
    const prompt = `
Analyze this search query and determine the search strategy:

Original Query: "${originalQuery}"
Parsed Keywords: ${JSON.stringify(params.keywords || [], null, 2)}

Determine:
1. Which Salesforce objects to search: Case, Account, Opportunity, Contact
2. Are there any actual searchable keywords (company names, product names, people names, specific terms)?
3. Extract the SHORTEST, most essential keywords for SOSL search (max 2-3 words total)

Context clues for object selection:
- "cases", "support cases", "support tickets", "tickets" → Case object ONLY
- "opportunities", "deals", "won", "lost", "closed" → Opportunity object ONLY  
- "accounts", "companies" → Account object ONLY
- "contacts", "people" → Contact object ONLY
- Company names WITHOUT object type specified (like "Acme Corp data") → Search all objects
- Generic searches without specific object type → Search all objects

IMPORTANT: If the user specifically mentions "support cases", "cases", or "tickets", ONLY search the Case object.

Ignore ONLY status/filter words like: open, closed, won, lost, high, medium, low, recent, last, days, etc.

DO search for business/industry terms like: oil, gas, energy, technology, healthcare, manufacturing, etc.

Examples:
- "recent support cases" → Objects: ["Case"], No searchable keywords
- "support cases with United Oil" → Objects: ["Case"], Keywords: ["United Oil"]
- "won opportunities" → Objects: ["Opportunity"], No searchable keywords  
- "oil and gas accounts" → Objects: ["Account"], Keywords: ["oil", "gas"]
- "United Oil Gas issues" → Objects: ["Case"], Keywords: ["United Oil", "gas"] (issues = support cases)
- "United Oil Gas data" → Objects: ["Case", "Account", "Opportunity", "Contact"], Keywords: ["United Oil", "gas"] (generic data = all objects)
- "Acme Corp" → Objects: ["Case", "Account", "Opportunity", "Contact"], Keywords: ["Acme Corp"]
- "technology companies" → Objects: ["Account"], Keywords: ["technology"]

Return JSON:
{
  "objectTypes": ["Case"] or ["Opportunity"] or ["Account"] or ["Contact"] or ["Case", "Account", "Opportunity", "Contact"],
  "hasKeywords": boolean,
  "shortKeywords": ["word1", "word2"], 
  "reasoning": "why these objects and keywords were selected"
}
    `;

    try {
      const response = await this.callGeminiAPI(prompt);
      const cleanResponse = response.replace(/```json\n|\n```|```/g, '').trim();
      return JSON.parse(cleanResponse);
    } catch (error) {
      console.error('LLM keyword analysis failed:', error);
      // Fallback to simple heuristic
      const hasKeywords = params.keywords && params.keywords.length > 0 && 
                         !params.keywords.every(k => ['open', 'closed', 'won', 'lost', 'high', 'medium', 'low'].includes(k.toLowerCase()));
      return {
        hasKeywords,
        shortKeywords: hasKeywords ? params.keywords.slice(0, 2) : [],
        reasoning: 'Fallback heuristic due to LLM failure'
      };
    }
  }

  // New unified SOSL → SOQL approach  
  async searchSOSLThenSOQL(params, shortKeywords) {
    const results = { accounts: [], contacts: [], cases: [], opportunities: [] };
    const objectTypes = this.getObjectTypesToSearch(params.objectTypes);
    
    console.log(`🚀 Step 1: SOSL Discovery with keywords: [${shortKeywords.join(', ')}]`);
    
    for (const objectType of objectTypes) {
      try {
        // Step 1: SOSL to find records with keywords (search each keyword individually)
        let allFoundIds = new Set();
        
        for (const keyword of this.sanitizeKeywords(shortKeywords)) {
          const soslQuery = `FIND {${keyword}} RETURNING ${objectType}(Id)`;
          
          console.log(`  🔍 SOSL for ${objectType} with keyword "${keyword}": ${soslQuery}`);
          this.lastExecutedQueries.push({ type: 'SOSL', query: soslQuery });
          
          const soslResult = await this.salesforceService.executeSOSLQuery(soslQuery);
          
          const foundIds = soslResult.searchRecords ? soslResult.searchRecords.map(r => r.Id) : [];
          console.log(`  📊 SOSL found ${foundIds.length} ${objectType} records for "${keyword}"`);
          
          // Add to combined results
          foundIds.forEach(id => allFoundIds.add(id));
        }
        
        const combinedIds = Array.from(allFoundIds);
        console.log(`  🎯 Combined SOSL results: ${combinedIds.length} unique ${objectType} records`);
        
        if (combinedIds.length > 0) {
          // Step 2: SOQL to filter and enrich with full data
          console.log(`  🔍 Step 2: SOQL filtering for ${objectType}...`);
          const filteredRecords = await this.filterRecordsWithSOQL(objectType, combinedIds, params);
          results[`${objectType.toLowerCase()}s`] = filteredRecords;
          console.log(`  ✅ Final ${objectType} results: ${filteredRecords.length} records`);
        }
        
      } catch (error) {
        console.error(`❌ Error in SOSL→SOQL for ${objectType}:`, error.message);
        // If SOSL fails, try direct SOQL for this object type
        try {
          console.log(`  🔄 SOSL failed, trying direct SOQL for ${objectType}...`);
          const soqlQuery = this.buildSOQLQuery(objectType, params);
          const response = await this.salesforceService.executeSOQLQuery(soqlQuery);
          results[`${objectType.toLowerCase()}s`] = response.records || [];
        } catch (soqlError) {
          console.error(`❌ Direct SOQL also failed for ${objectType}:`, soqlError.message);
        }
      }
    }
    
    return results;
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
    
    console.log(`🚀 Executing SOQL-only search for objects: ${objectTypes.join(', ')}`);
    
    for (const objectType of objectTypes) {
      try {
        console.log(`\n📊 Searching ${objectType}...`);
        const soqlQuery = this.buildSOQLQuery(objectType, params);
        
        console.log(`  ⚡ Executing SOQL query...`);
        const startTime = Date.now();
        const response = await this.salesforceService.executeSOQLQuery(soqlQuery);
        const endTime = Date.now();
        
        console.log(`  ✅ Query executed in ${endTime - startTime}ms`);
        console.log(`  📊 Records returned: ${response.records ? response.records.length : 0}`);
        
        results[`${objectType.toLowerCase()}s`] = response.records || [];
        
        if (response.records && response.records.length > 0) {
          console.log(`  🎯 Sample results:`);
          response.records.slice(0, 2).forEach((record, i) => {
            const name = record.Name || record.CaseNumber || record.Subject || 'N/A';
            console.log(`    ${i + 1}. ${name}`);
          });
        }
        
      } catch (error) {
        console.error(`❌ Error searching ${objectType}:`, error.message);
        console.error(`  Stack:`, error.stack);
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
    console.log('🔄 Using default fallback strategy - searching recent cases');
    
    // Default to searching cases with basic criteria
    const defaultQuery = `SELECT Id, CaseNumber, Subject, Status, CreatedDate, Account.Name, Account.AnnualRevenue FROM Case ORDER BY CreatedDate DESC LIMIT 1000`;
    
    console.log(`  🔍 Default SOQL query: ${defaultQuery}`);
    
    try {
      console.log('  ⚡ Executing default query...');
      const startTime = Date.now();
      const response = await this.salesforceService.executeSOQLQuery(defaultQuery);
      const endTime = Date.now();
      
      console.log(`  ✅ Default query executed in ${endTime - startTime}ms`);
      console.log(`  📊 Records returned: ${response.records ? response.records.length : 0}`);
      
      if (response.records && response.records.length > 0) {
        console.log('  🎯 Sample results:');
        response.records.slice(0, 3).forEach((record, i) => {
          console.log(`    ${i + 1}. Case ${record.CaseNumber}: ${record.Subject} (${record.Status})`);
        });
      }
      
      return { cases: response.records || [], accounts: [], contacts: [], opportunities: [] };
    } catch (error) {
      console.error('❌ Default search failed:', error.message);
      console.error('  Stack:', error.stack);
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
    this.lastExecutedQueries.push({ type: 'SOQL', query: soqlQuery });
    
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
      const timeCondition = this.getTimeCondition(params.timeRange);
      conditions.push(timeCondition);
      console.log(`  ⏰ Time filter: ${timeCondition}`);
    }
    
    // Object-specific filters
    switch (objectType) {
      case 'Opportunity':
        const oppFilters = this.getOpportunityFilters(params);
        conditions.push(...oppFilters);
        if (oppFilters.length > 0) {
          console.log(`  💰 Opportunity filters: ${oppFilters.join(', ')}`);
        }
        break;
      case 'Case':
        const caseFilters = this.getCaseFilters(params);
        conditions.push(...caseFilters);
        if (caseFilters.length > 0) {
          console.log(`  🎫 Case filters: ${caseFilters.join(', ')}`);
        }
        break;
      case 'Account':
        const accFilters = this.getAccountFilters(params);
        conditions.push(...accFilters);
        if (accFilters.length > 0) {
          console.log(`  🏢 Account filters: ${accFilters.join(', ')}`);
        }
        break;
      case 'Contact':
        const conFilters = this.getContactFilters(params);
        conditions.push(...conFilters);
        if (conFilters.length > 0) {
          console.log(`  👤 Contact filters: ${conFilters.join(', ')}`);
        }
        break;
    }
    
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const fields = this.getFieldsForObject(objectType);
    
    const finalQuery = `SELECT ${fields} FROM ${objectType} ${whereClause} ORDER BY CreatedDate DESC LIMIT 1000`;
    
    console.log(`  🔍 Generated SOQL for ${objectType}:`);
    console.log(`    ${finalQuery}`);
    
    return finalQuery;
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
      'Case': 'Id, CaseNumber, Subject, Status, CreatedDate, Account.Name, Account.AnnualRevenue, Contact.Name',
      'Account': 'Id, Name, Industry, Type, Phone, CreatedDate, AnnualRevenue',
      'Opportunity': 'Id, Name, StageName, Amount, CloseDate, CreatedDate, Account.Name, Account.AnnualRevenue',
      'Contact': 'Id, Name, Email, Phone, Title, CreatedDate, Account.Name, Account.AnnualRevenue'
    };
    return fieldMap[objectType] || 'Id, Name, CreatedDate';
  }

  // Helper: Check if keywords are actually searchable or just filter values
  hasSearchableKeywords(params) {
    if (!params.keywords || params.keywords.length === 0) return false;
    
    // Keywords that are filter values, not searchable text
    const filterKeywords = [
      'open', 'closed', 'won', 'lost', 'high', 'medium', 'low', 'critical',
      'customer', 'prospect', 'partner', 'internal', 'green', 'yellow', 'red',
      'today', 'yesterday', 'this_week', 'this_month', 'last_30_days', 'last_90_days'
    ];
    
    // If all keywords are filter values, they're not searchable
    const allFilterKeywords = params.keywords.every(keyword => 
      filterKeywords.includes(keyword.toLowerCase())
    );
    
    return !allFilterKeywords;
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

    // Helper: Parse natural language query into structured parameters
  parseNaturalLanguageQuery(query) {
    const lowerQuery = query.toLowerCase();
    const params = {};
    
    // Extract object types
    if (lowerQuery.includes('case') || lowerQuery.includes('support') || lowerQuery.includes('ticket')) {
      params.objectTypes = ['Case'];
    } else if (lowerQuery.includes('opportunity') || lowerQuery.includes('deal')) {
      params.objectTypes = ['Opportunity'];
    } else if (lowerQuery.includes('account') || lowerQuery.includes('company')) {
      params.objectTypes = ['Account'];
    } else if (lowerQuery.includes('contact') || lowerQuery.includes('person')) {
      params.objectTypes = ['Contact'];
    } else {
      params.objectTypes = ['Case', 'Account', 'Opportunity', 'Contact']; // Default to all
    }
    
    // Extract time ranges
    if (lowerQuery.includes('last 30 days') || lowerQuery.includes('past month')) {
      params.timeRange = 'last_30_days';
    } else if (lowerQuery.includes('last 90 days') || lowerQuery.includes('past quarter')) {
      params.timeRange = 'last_90_days';
    } else if (lowerQuery.includes('this week')) {
      params.timeRange = 'this_week';
    } else if (lowerQuery.includes('this month')) {
      params.timeRange = 'this_month';
    } else if (lowerQuery.includes('today')) {
      params.timeRange = 'today';
    } else if (lowerQuery.includes('yesterday')) {
      params.timeRange = 'yesterday';
      } else {
      params.timeRange = 'last_30_days'; // Default
    }
    
    // Extract keywords (remove common words and extract meaningful terms)
    const commonWords = ['get', 'find', 'show', 'me', 'all', 'the', 'with', 'in', 'on', 'at', 'to', 'for', 'of', 'a', 'an', 'and', 'or', 'but', 'recent', 'support', 'cases', 'opportunities', 'accounts', 'contacts', 'last', 'days', 'weeks', 'months', 'year'];
    const words = query.toLowerCase().split(/\s+/).filter(word => 
      word.length > 2 && !commonWords.includes(word) && !word.match(/^\d+$/)
    );
    params.keywords = words;
    
    // Extract specific filters
    if (lowerQuery.includes('won')) {
      params.opportunityStage = 'won';
    } else if (lowerQuery.includes('lost')) {
      params.opportunityStage = 'lost';
    } else if (lowerQuery.includes('open')) {
      params.caseStatus = 'open';
    } else if (lowerQuery.includes('closed')) {
      params.caseStatus = 'closed';
    }
    
    // Extract amounts
    const amountMatch = query.match(/\$?(\d+)[kK]/);
    if (amountMatch) {
      const amount = parseInt(amountMatch[1]) * 1000;
      if (lowerQuery.includes('>') || lowerQuery.includes('more than') || lowerQuery.includes('at least')) {
        params.minAmount = amount;
      } else if (lowerQuery.includes('<') || lowerQuery.includes('less than') || lowerQuery.includes('under')) {
        params.maxAmount = amount;
      }
    }
    
    return params;
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