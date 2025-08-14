const SalesforceService = require('./salesforce');
const JiraService = require('./jiraService');
const axios = require('axios');

class MultiSourceService {
  constructor(team) {
    this.salesforceService = team ? new SalesforceService(team) : null;
    this.jiraService = new JiraService();
    this.team = team;
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
    // Step 1: AI Planning - Be specific about what we plan to do
    await respondCallback(`🤖 **AI Planning:** Understanding "${userPrompt}"...`);
    
    const searchTerms = await this.generateSearchTerms(userPrompt);
    await respondCallback(`🧠 **AI Strategy:** I'll look for tickets containing: ${searchTerms.map(term => `"${term}"`).join(', ')}`);
    
    // Step 2: Check connections and plan search strategy
    await respondCallback('🔍 **Checking what systems I can search...**');
    
    const connectionStatus = await this.checkConnections();
    
    // Create detailed search plan
    let searchPlan = '📋 **My Search Plan:**\n';
    const availableSources = [];
    
    if (connectionStatus.salesforce.connected) {
      searchPlan += `✅ Search Salesforce support cases for ${searchTerms.join(', ')}\n`;
      availableSources.push('Salesforce');
    } else {
      searchPlan += `❌ Can't search Salesforce: ${connectionStatus.salesforce.reason} (database needed for OAuth tokens)\n`;
    }
    
    if (connectionStatus.jira.connected) {
      searchPlan += `✅ Search Jira issues for ${searchTerms.join(', ')}`;
      availableSources.push('Jira');
    } else {
      searchPlan += `❌ Can't search Jira: ${connectionStatus.jira.reason}`;
    }
    
    await respondCallback(searchPlan);
    
    // Step 3: Handle no connections case
    if (availableSources.length === 0) {
      await respondCallback('🚫 **Problem:** No systems are connected! You need to connect at least one system to search.');
      return { salesforce: [], jira: [], searchTerms, connectionStatus };
    }
    
    // Step 4: Execute searches with progress updates
    const searchPromises = [];
    
    if (connectionStatus.salesforce.connected) {
      await respondCallback(`🔍 **Searching Salesforce** for support cases with: ${searchTerms.join(', ')}...`);
      searchPromises.push(this.searchSalesforceWithProgress(searchTerms, respondCallback));
    } else {
      await respondCallback(`⏭️ **Skipping Salesforce** (need to connect first)`);
    }
    
    if (connectionStatus.jira.connected) {
      await respondCallback(`🔍 **Searching Jira** for issues with: ${searchTerms.join(', ')}...`);
      await respondCallback(`⏳ **Please wait** - Jira searches can take up to 2 minutes to complete...`);
      searchPromises.push(this.searchJiraWithProgress(searchTerms, respondCallback));
    } else {
      await respondCallback(`⏭️ **Skipping Jira** (not configured)`);
    }
    
    // Execute searches
    const results = await Promise.all(searchPromises);
    
    const finalResults = {
      salesforce: connectionStatus.salesforce.connected ? results[connectionStatus.jira.connected ? 0 : 0] || [] : [],
      jira: connectionStatus.jira.connected ? results[connectionStatus.salesforce.connected ? 1 : 0] || [] : [],
      searchTerms,
      connectionStatus,
      teamId: this.team?.id
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
      if (!this.salesforceService || !this.salesforceService.accessToken) {
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

  async searchSalesforceWithProgress(searchTerms, respondCallback) {
    if (!this.salesforceService) {
      await respondCallback(`❌ **Salesforce:** Not available (database connection required)`);
      return [];
    }
    
    const allResults = [];
    for (const searchTerm of searchTerms) {
      try {
        const results = await this.salesforceService.searchSupportTickets(searchTerm);
        allResults.push(...results);
        if (results.length > 0) {
          await respondCallback(`✅ **Salesforce:** Found ${results.length} cases matching "${searchTerm}"`);
        }
      } catch (error) {
        console.error(`Salesforce search failed for "${searchTerm}":`, error.message);
        if (error.message.includes('not connected') || error.message.includes('token')) {
          await respondCallback(`❌ **Salesforce Login Required:** Please connect your Salesforce account to search cases`);
          throw error;
        }
        await respondCallback(`⚠️ **Salesforce:** Error searching for "${searchTerm}" - ${error.message}`);
      }
    }
    const deduplicated = this.removeDuplicates(allResults, 'Id');
    if (deduplicated.length === 0) {
      await respondCallback(`📭 **Salesforce:** No support cases found with those terms`);
    }
    return deduplicated;
  }

  async searchJiraWithProgress(searchTerms, respondCallback) {
    const allResults = [];
    for (let i = 0; i < searchTerms.length; i++) {
      const searchTerm = searchTerms[i];
      try {
        await respondCallback(`🔍 **Jira:** Searching for "${searchTerm}" (${i + 1}/${searchTerms.length})...`);
        const results = await this.jiraService.searchIssues(searchTerm);
        allResults.push(...results);
        if (results.length > 0) {
          await respondCallback(`✅ **Jira:** Found ${results.length} issues matching "${searchTerm}"`);
        } else {
          await respondCallback(`📭 **Jira:** No issues found for "${searchTerm}"`);
        }
      } catch (error) {
        console.error(`Jira search failed for "${searchTerm}":`, error.message);
        if (error.message.includes('ENOTFOUND') || error.message.includes('authentication')) {
          await respondCallback(`❌ **Jira Connection Error:** Check your Jira credentials - ${error.message}`);
          throw error;
        }
        if (error.message.includes('timeout')) {
          await respondCallback(`⏱️ **Jira:** Search for "${searchTerm}" timed out after 2 minutes`);
        } else {
          await respondCallback(`⚠️ **Jira:** Error searching for "${searchTerm}" - ${error.message}`);
        }
      }
    }
    const deduplicated = this.removeDuplicates(allResults, 'key');
    await respondCallback(`🏁 **Jira Search Complete:** Found ${deduplicated.length} unique issues total`);
    return deduplicated;
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
          text: `💡 *Want to search Salesforce too?* Click below to authorize your Salesforce account!`
        },
        accessory: {
          type: "button",
          text: {
            type: "plain_text",
            text: "🔗 Connect Salesforce"
          },
          url: `${process.env.APP_URL}/setup/salesforce?team_id=${results.teamId || 'unknown'}`
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