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
    // Step 1: AI Planning - Generate search terms
    const searchTerms = await this.generateSearchTerms(userPrompt);
    
    // Step 2: Check connections
    const connectionStatus = await this.checkConnections();
    
    const availableSources = [];
    if (connectionStatus.salesforce.connected) {
      availableSources.push('Salesforce');
    }
    if (connectionStatus.jira.connected) {
      availableSources.push('Jira');
    }
    
    // Step 3: Handle no connections case
    if (availableSources.length === 0) {
      return { salesforce: [], jira: [], searchTerms, connectionStatus };
    }
    
    // Step 4: Execute searches quietly
    const searchPromises = [];
    
    if (connectionStatus.salesforce.connected) {
      searchPromises.push(this.searchSalesforceWithProgress(searchTerms, respondCallback));
    }
    
    if (connectionStatus.jira.connected) {
      searchPromises.push(this.searchJiraWithProgress(searchTerms, respondCallback));
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
    
    // Step 5: AI Analysis of results (silent)
    if (finalResults.jira.length > 0 || finalResults.salesforce.length > 0) {
      finalResults.aiSummary = await this.analyzeResults(finalResults, userPrompt);
    }
    
    return finalResults;
  }

  async analyzeResults(results, userPrompt) {
    const ticketData = [];
    
    // Collect Jira ticket details
    results.jira.forEach(issue => {
      let ticketInfo = `JIRA ${issue.key}: ${issue.fields.summary}\nStatus: ${issue.fields.status.name}`;
      
      if (issue.fields.description) {
        ticketInfo += `\nDescription: ${issue.fields.description}`;
      }
      
      if (issue.fields.comment?.comments) {
        const comments = issue.fields.comment.comments
          .slice(-3) // Last 3 comments
          .map(comment => `${comment.author?.displayName || 'Unknown'}: ${comment.body}`)
          .join('\n');
        ticketInfo += `\nRecent Comments:\n${comments}`;
      }
      
      ticketData.push(ticketInfo);
    });
    
    // Collect Salesforce case details
    results.salesforce.forEach(case_ => {
      ticketData.push(`Salesforce ${case_.CaseNumber}: ${case_.Subject}\nStatus: ${case_.Status}\nDescription: ${case_.Description || 'No description'}`);
    });
    
    if (ticketData.length === 0) {
      return null;
    }
    
    const analysisPrompt = `
    User searched for: "${userPrompt}"
    
    Here are the tickets found:
    ${ticketData.join('\n\n---\n\n')}
    
    Please provide a concise 2-3 sentence summary of what these tickets are about, focusing on:
    1. Common themes or patterns
    2. Current status/progress
    3. Key issues or blockers mentioned
    
    Keep it brief and actionable for a business user.
    `;

    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          contents: [{
            parts: [{
              text: analysisPrompt
            }]
          }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 200
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
      console.error('AI analysis failed:', error.message);
      return null;
    }
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
      return [];
    }
    
    const allResults = [];
    for (const searchTerm of searchTerms) {
      try {
        const results = await this.salesforceService.searchSupportTickets(searchTerm);
        allResults.push(...results);
      } catch (error) {
        console.error(`Salesforce search failed for "${searchTerm}":`, error.message);
        if (error.message.includes('not connected') || error.message.includes('token')) {
          throw error;
        }
      }
    }
    return this.removeDuplicates(allResults, 'Id');
  }

  async searchJiraWithProgress(searchTerms, respondCallback) {
    const allResults = [];
    for (const searchTerm of searchTerms) {
      try {
        const results = await this.jiraService.searchIssues(searchTerm);
        allResults.push(...results);
      } catch (error) {
        console.error(`Jira search failed for "${searchTerm}":`, error.message);
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

  formatFinalResults(results, userPrompt, progressMessages = []) {
    const { salesforce, jira, searchTerms, connectionStatus, aiSummary } = results;
    
    const blocks = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `🔍 Search Results: "${userPrompt}"`
        }
      }
    ];

    // Add AI summary if available (most important info first)
    if (aiSummary) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*💡 Key Insights:*\n${aiSummary}`
        }
      });
      
      // Add divider for visual separation
      blocks.push({
        type: "divider"
      });
    }

    let totalFound = 0;

    // Add Salesforce results with better formatting
    if (salesforce && salesforce.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*🏢 Salesforce Cases (${salesforce.length} found)*`
        }
      });

      salesforce.forEach((case_, index) => {
        const customerName = case_.Account?.Name || 'Unknown Customer';
        const contactName = case_.Contact?.Name || 'No Contact';
        
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${case_.CaseNumber}* - ${case_.Subject}\n` +
                  `👤 ${customerName} (${contactName})\n` +
                  `📊 ${case_.Status} • ${case_.Priority} Priority`
          },
          accessory: {
            type: "button",
            text: {
              type: "plain_text",
              text: "View"
            },
            value: case_.Id
          }
        });
        
        // Add spacing between items
        if (index < salesforce.length - 1) {
          blocks.push({
            type: "context",
            elements: [{
              type: "plain_text",
              text: " "
            }]
          });
        }
      });
      
      totalFound += salesforce.length;
      
      // Add divider after Salesforce section
      blocks.push({
        type: "divider"
      });
    }

    // Add Jira results with improved formatting
    if (results.jira && results.jira.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*🎯 Jira Issues (${results.jira.length} found)*`
        }
      });

      // Format Jira results with better spacing
      results.jira.forEach((issue, index) => {
        let issueText = `*${issue.key}* - ${issue.fields.summary}\n` +
                       `📊 ${issue.fields.status.name} • ${issue.fields.priority?.name || 'No Priority'}\n` +
                       `👤 ${issue.fields.assignee?.displayName || 'Unassigned'}`;
        
        // Add description if available (truncated)
        if (issue.fields.description) {
          const desc = issue.fields.description.substring(0, 150);
          issueText += `\n📝 ${desc}${desc.length === 150 ? '...' : ''}`;
        }
        
        // Add most recent comment if available
        if (issue.fields.comment?.comments?.length > 0) {
          const lastComment = issue.fields.comment.comments.slice(-1)[0];
          const author = lastComment.author?.displayName || 'Unknown';
          const body = lastComment.body.substring(0, 100);
          issueText += `\n💬 ${author}: ${body}${body.length === 100 ? '...' : ''}`;
        }

        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: issueText
          },
          accessory: {
            type: "button",
            text: {
              type: "plain_text",
              text: "Open"
            },
            url: `${this.jiraService.baseUrl}/browse/${issue.key}`
          }
        });
        
        // Add spacing between issues
        if (index < results.jira.length - 1) {
          blocks.push({
            type: "context",
            elements: [{
              type: "plain_text",
              text: " "
            }]
          });
        }
      });
      
      totalFound += results.jira.length;
    }

    // Add connection prompts for disconnected systems
    if (!connectionStatus.salesforce.connected && totalFound > 0) {
      blocks.push({
        type: "divider"
      });
      
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `💡 *Want to search Salesforce too?*\nConnect your Salesforce org to search support cases alongside Jira issues.`
        },
        accessory: {
          type: "button",
          text: {
            type: "plain_text",
            text: "Connect Salesforce"
          },
          url: `${process.env.APP_URL}/setup/salesforce?team_id=${results.teamId || 'unknown'}`,
          style: "primary"
        }
      });
    }

    // If no results found
    if (totalFound === 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🔍 No tickets found matching "${userPrompt}"\n\nTry searching with different keywords or check your system connections.`
        }
      });
      
      // Show connection options when no results
      if (!connectionStatus.salesforce.connected || !connectionStatus.jira.connected) {
        blocks.push({
          type: "divider"
        });
        
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*🔧 Available Connections:*"
          }
        });
        
        if (!connectionStatus.salesforce.connected) {
          blocks.push({
            type: "section",
            text: {
              type: "mrkdwn",
              text: "🏢 Salesforce - Not connected"
            },
            accessory: {
              type: "button",
              text: {
                type: "plain_text",
                text: "Connect"
              },
              url: `${process.env.APP_URL}/setup/salesforce?team_id=${results.teamId || 'unknown'}`
            }
          });
        }
        
        if (!connectionStatus.jira.connected) {
          blocks.push({
            type: "section",
            text: {
              type: "mrkdwn",
              text: "🎯 Jira - Not properly configured"
            }
          });
        }
      }
    }

    // Add footer with search stats
    blocks.push({
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `Found ${totalFound} results • Searched: ${searchTerms.join(', ')}`
      }]
    });

    return {
      blocks,
      response_type: "in_channel"
    };
  }
}

module.exports = MultiSourceService;