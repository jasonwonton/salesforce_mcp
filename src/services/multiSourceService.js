const SalesforceService = require('./salesforce');
const JiraService = require('./jiraService');
const axios = require('axios');

class MultiSourceService {
  constructor(team) {
    this.salesforceService = new SalesforceService(team);
    this.jiraService = new JiraService();
  }

  async generateSearchTerms(userPrompt) {
    const prompt = `
    User wants to search for: "${userPrompt}"
    
    Generate 3-5 relevant search keywords that would help find related tickets/issues in Salesforce and Jira.
    Focus on technical terms, business terms, and common variations.
    
    Return ONLY a JSON array of strings, like: ["keyword1", "keyword2", "keyword3"]
    
    Examples:
    - "payment issues" → ["payment", "billing", "invoice", "charge", "refund"]
    - "login problems" → ["login", "authentication", "signin", "password", "auth"]
    - "slow performance" → ["performance", "slow", "timeout", "speed", "latency"]
    `;

    try {
      // Using Google Gemini API
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          contents: [{
            parts: [{
              text: prompt
            }]
          }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 100
          }
        },
        {
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      const generatedText = response.data.candidates[0].content.parts[0].text;
      const searchTerms = JSON.parse(generatedText);
      return searchTerms;
    } catch (error) {
      console.error('LLM search term generation failed:', error.message);
      // Fallback to simple keyword extraction
      return this.extractKeywords(userPrompt);
    }
  }

  extractKeywords(text) {
    // Simple fallback - extract meaningful words
    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 3)
      .filter(word => !['this', 'that', 'with', 'have', 'will', 'from', 'they', 'been', 'would', 'could'].includes(word));
    
    return words.slice(0, 3); // Take first 3 meaningful words
  }

  async searchWithIntelligentPlanning(userPrompt, respondCallback) {
    // Step 1: AI Planning
    await respondCallback('🤖 **AI Planning:** Analyzing your request...');
    
    const searchTerms = await this.generateSearchTerms(userPrompt);
    await respondCallback(`🧠 **AI Thinking:** I'll search for: ${searchTerms.map(term => `"${term}"`).join(', ')}`);
    
    // Step 2: Check connections
    await respondCallback('🔍 **Checking connections...**');
    
    const connectionStatus = await this.checkConnections();
    let statusMessage = '📊 **Connection Status:**\n';
    
    if (connectionStatus.salesforce.connected) {
      statusMessage += '✅ Salesforce: Connected\n';
    } else {
      statusMessage += `❌ Salesforce: ${connectionStatus.salesforce.reason}\n`;
    }
    
    if (connectionStatus.jira.connected) {
      statusMessage += '✅ Jira: Connected';
    } else {
      statusMessage += `❌ Jira: ${connectionStatus.jira.reason}`;
    }
    
    await respondCallback(statusMessage);
    
    // Step 3: Search available sources
    const searchPromises = [];
    let searchMessage = '🔍 **Searching:**';
    
    if (connectionStatus.salesforce.connected) {
      searchMessage += ' Salesforce';
      searchPromises.push(this.searchSalesforce(searchTerms));
    }
    
    if (connectionStatus.jira.connected) {
      searchMessage += searchPromises.length > 0 ? ' + Jira' : ' Jira';
      searchPromises.push(this.searchJira(searchTerms));
    }
    
    if (searchPromises.length === 0) {
      await respondCallback('❌ **No systems available to search.** Please connect at least one system.');
      return { salesforce: [], jira: [], searchTerms, connectionStatus };
    }
    
    await respondCallback(searchMessage + '...');
    
    // Execute searches
    const results = await Promise.all(searchPromises);
    
    const finalResults = {
      salesforce: connectionStatus.salesforce.connected ? results[connectionStatus.jira.connected ? 0 : 0] || [] : [],
      jira: connectionStatus.jira.connected ? results[connectionStatus.salesforce.connected ? 1 : 0] || [] : [],
      searchTerms,
      connectionStatus
    };
    
    return finalResults;
  }

  async checkConnections() {
    const status = {
      salesforce: { connected: false, reason: '' },
      jira: { connected: false, reason: '' }
    };
    
    // Check Salesforce
    try {
      if (!this.salesforceService.accessToken) {
        status.salesforce.reason = 'Not connected - need to authorize';
      } else {
        status.salesforce.connected = true;
      }
    } catch (error) {
      status.salesforce.reason = 'Connection error';
    }
    
    // Check Jira
    try {
      if (!this.jiraService.baseUrl || 
          this.jiraService.baseUrl === 'https://example.atlassian.net' ||
          !this.jiraService.username || 
          this.jiraService.username === 'placeholder' ||
          !this.jiraService.apiToken || 
          this.jiraService.apiToken === 'placeholder') {
        status.jira.reason = 'Not configured properly';
      } else {
        status.jira.connected = true;
      }
    } catch (error) {
      status.jira.reason = 'Connection error';
    }
    
    return status;
  }

  async searchSalesforce(searchTerms) {
    const allResults = [];
    for (const searchTerm of searchTerms) {
      try {
        const results = await this.salesforceService.searchSupportTickets(searchTerm);
        allResults.push(...results);
      } catch (error) {
        console.error(`Salesforce search failed for "${searchTerm}":`, error.message);
      }
    }
    return this.removeDuplicates(allResults, 'Id');
  }

  async searchJira(searchTerms) {
    const allResults = [];
    for (const searchTerm of searchTerms) {
      try {
        const results = await this.jiraService.searchIssues(searchTerm);
        allResults.push(...results);
      } catch (error) {
        console.error(`Jira search failed for "${searchTerm}":`, error.message);
        // If there's a connection error, don't continue with other terms
        if (error.message.includes('ENOTFOUND') || error.message.includes('authentication')) {
          throw error;
        }
      }
    }
    return this.removeDuplicates(allResults, 'key');
  }

  removeDuplicates(array, idField) {
    const seen = new Set();
    return array.filter(item => {
      const id = item[idField];
      if (seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    });
  }

  formatFinalResults(results, userPrompt) {
    const { salesforce, jira, searchTerms, connectionStatus } = results;
    
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*📊 Final Results for: "${userPrompt}"*\n_Searched: ${searchTerms.join(', ')}_`
        }
      }
    ];

    let totalFound = 0;

    // Add Salesforce results
    if (salesforce && salesforce.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Salesforce Cases (${salesforce.length}):*`
        }
      });

      salesforce.forEach(case_ => {
        const customerName = case_.Account?.Name || 'Unknown Customer';
        const contactName = case_.Contact?.Name || 'No Contact';
        
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `🔵 *${case_.CaseNumber}* - ${case_.Subject}\n` +
                  `Customer: ${customerName} (${contactName})\n` +
                  `Status: ${case_.Status} | Priority: ${case_.Priority}`
          }
        });
      });
      
      totalFound += results.salesforce.length;
    }

    // Add Jira results
    if (results.jira && results.jira.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Jira Issues (${results.jira.length}):*`
        }
      });

      const jiraBlocks = this.jiraService.formatResultsForSlack(results.jira);
      blocks.push(...jiraBlocks);
      
      totalFound += jira.length;
    }

    // Add connection prompts for disconnected systems
    if (!connectionStatus.salesforce.connected) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `💡 *Want more results?* Connect Salesforce to search support cases too!`
        },
        accessory: {
          type: "button",
          text: {
            type: "plain_text",
            text: "Connect Salesforce"
          },
          url: `${process.env.APP_URL}/setup/salesforce`
        }
      });
    }

    // If no results found
    if (totalFound === 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "No tickets found with those search terms."
        }
      });
    }

    return {
      blocks,
      response_type: "in_channel"
    };
  }
}

module.exports = MultiSourceService;