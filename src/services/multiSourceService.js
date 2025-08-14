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

  async searchBothSources(userPrompt) {
    // Generate intelligent search terms
    const searchTerms = await this.generateSearchTerms(userPrompt);
    console.log(`Generated search terms for "${userPrompt}":`, searchTerms);
    
    const allResults = {
      salesforce: [],
      jira: []
    };
    
    // Search with each term and combine results
    for (const searchTerm of searchTerms) {
      const promises = [];
      
      // Search Salesforce (if connected)
      promises.push(
        this.salesforceService.searchSupportTickets(searchTerm)
          .catch(error => {
            console.error(`Salesforce search failed for "${searchTerm}":`, error.message);
            return [];
          })
      );
      
      // Search Jira
      promises.push(
        this.jiraService.searchIssues(searchTerm)
          .catch(error => {
            console.error(`Jira search failed for "${searchTerm}":`, error.message);
            return [];
          })
      );

      const [salesforceResults, jiraResults] = await Promise.all(promises);
      
      // Combine results (avoid duplicates)
      allResults.salesforce = [...allResults.salesforce, ...salesforceResults];
      allResults.jira = [...allResults.jira, ...jiraResults];
    }
    
    // Remove duplicates
    allResults.salesforce = this.removeDuplicates(allResults.salesforce, 'Id');
    allResults.jira = this.removeDuplicates(allResults.jira, 'key');
    
    return allResults;
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

  formatCombinedResults(results, userPrompt) {
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*🤖 AI Search results for: "${userPrompt}"*`
        }
      }
    ];

    let totalFound = 0;

    // Add Salesforce results
    if (results.salesforce && results.salesforce.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Salesforce Cases (${results.salesforce.length}):*`
        }
      });

      results.salesforce.forEach(case_ => {
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
      
      totalFound += results.jira.length;
    }

    // If no results found
    if (totalFound === 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "No tickets found in either Salesforce or Jira."
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