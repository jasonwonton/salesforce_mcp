const SalesforceService = require('./salesforce');
const JiraService = require('./jiraService');
const axios = require('axios');

class MultiSourceService {
  constructor(team) {
    this.salesforceService = team ? new SalesforceService(team) : null;
    this.jiraService = new JiraService();
    this.team = team;
  }

  async analyzeUserIntent(userPrompt) {
    const prompt = `
    Analyze this user request: "${userPrompt}"
    
    Determine if this requires searching data or is a conversational request.
    
    Return JSON with this structure:
    {
      "needsSearch": true/false,
      "response": "conversational response if no search needed",
      "searchTerms": ["term1", "term2"] if search needed,
      "searchType": "cases|accounts|opportunities|general" if search needed
    }
    
    Examples:
    - "help me" → {"needsSearch": false, "response": "I can help you search Salesforce cases, accounts, or opportunities. What would you like to find?"}
    - "billing issues today" → {"needsSearch": true, "searchTerms": ["billing", "invoice", "payment"], "searchType": "cases"}
    - "what are you" → {"needsSearch": false, "response": "I'm your AI assistant that can search Salesforce and Jira data. Try asking about cases, accounts, or recent issues."}
    - "red accounts" → {"needsSearch": true, "searchTerms": ["health", "risk", "issues"], "searchType": "accounts"}
    `;

    try {
      console.log('🧠 Analyzing user intent with LLM...');
      const response = await this.callLLM(prompt);
      
      // Clean up markdown wrapping if present
      const cleanText = response.replace(/```json\n|\n```|```/g, '').trim();
      const intentAnalysis = JSON.parse(cleanText);
      
      console.log('✅ Intent analysis successful:', intentAnalysis);
      return intentAnalysis;
      
    } catch (error) {
      console.error('❌ Intent analysis failed:', error.message);
      console.log('🔄 Using fallback intent analysis');
      return this.fallbackIntentAnalysis(userPrompt);
    }
  }

  fallbackIntentAnalysis(userPrompt) {
    const lowerPrompt = userPrompt.toLowerCase();
    
    // Conversational patterns
    const conversationalPatterns = [
      'help', 'hi', 'hello', 'what', 'who', 'how are you', 'thanks', 'thank you'
    ];
    
    if (conversationalPatterns.some(pattern => lowerPrompt.includes(pattern) && lowerPrompt.length < 20)) {
      return {
        needsSearch: false,
        response: "I can help you search Salesforce cases, accounts, opportunities, or Jira issues. What would you like to find?"
      };
    }
    
    // Extract meaningful search terms
    const words = lowerPrompt
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 3)
      .filter(word => !['this', 'that', 'with', 'have', 'will', 'from', 'they', 'been', 'would', 'could'].includes(word));
    
    return {
      needsSearch: true,
      searchTerms: words.slice(0, 3),
      searchType: 'general'
    };
  }

  async searchWithIntelligentPlanning(userPrompt, respondCallback) {
    // Step 1: AI Planning - Analyze intent and generate search terms  
    const intentAnalysis = await this.analyzeUserIntent(userPrompt);
    
    if (!intentAnalysis.needsSearch) {
      // This shouldn't happen since we check intent earlier, but handle gracefully
      return {
        conversationalResponse: intentAnalysis.response,
        searchPerformed: false
      };
    }
    
    const searchTerms = intentAnalysis.searchTerms;
    
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
      console.log('🧠 Performing AI analysis of results...');
      const response = await this.callLLM(analysisPrompt);
      return response;
    } catch (error) {
      console.error('❌ AI analysis failed:', error.message);
      return null;
    }
  }

  async answerFollowUpQuestion(question, searchResults) {
    const ticketData = [];
    
    // Collect ticket details
    searchResults.jira.forEach(issue => {
      let ticketInfo = `JIRA ${issue.key}: ${issue.fields.summary}\nStatus: ${issue.fields.status.name}`;
      
      if (issue.fields.description) {
        ticketInfo += `\nDescription: ${issue.fields.description}`;
      }
      
      if (issue.fields.comment?.comments) {
        const comments = issue.fields.comment.comments
          .slice(-2)
          .map(comment => `${comment.author?.displayName || 'Unknown'}: ${comment.body}`)
          .join('\n');
        ticketInfo += `\nRecent Comments:\n${comments}`;
      }
      
      ticketData.push(ticketInfo);
    });
    
    searchResults.salesforce.forEach(case_ => {
      ticketData.push(`Salesforce ${case_.CaseNumber}: ${case_.Subject}\nStatus: ${case_.Status}\nDescription: ${case_.Description || 'No description'}`);
    });
    
    const followUpPrompt = `
    User question: "${question}"
    
    Context - Here are the current tickets in the system:
    ${ticketData.join('\n\n---\n\n')}
    
    Please provide a helpful answer to the user's question based on the ticket information above. 
    Be specific and reference ticket numbers when relevant. Keep the answer concise but informative.
    `;

    try {
      console.log('🧠 Generating follow-up response...');
      const response = await this.callLLM(followUpPrompt);
      return response;
    } catch (error) {
      console.error('❌ Follow-up AI response failed:', error.message);
      return "Sorry, I couldn't process your question right now. Please try again.";
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
        // Use basic SOSL search for simple case lookup
        const soslQuery = `FIND {${searchTerm}} RETURNING Case(Id, CaseNumber, Subject, Status, CreatedDate, Account.Name, Contact.Name, Priority, Description WHERE Status != 'Closed') LIMIT 20`;
        const soslResult = await this.salesforceService.executeSOSLQuery(soslQuery);
        const results = soslResult.searchRecords || [];
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
          url: `${process.env.APP_URL}/setup/salesforce?team_id=${results.teamId}`,
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
              url: `${process.env.APP_URL}/setup/salesforce?team_id=${results.teamId}`
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

    // Add interactive follow-up section
    if (totalFound > 0) {
      blocks.push({
        type: "divider"
      });
      
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "💬 *Want to ask me more about these results?*\nType `/station ask [your question]` to get AI insights!"
        }
      });
      
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Summarize Issues"
            },
            value: `ask_summarize_${Date.now()}`,
            action_id: "ask_summarize"
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Priority Analysis"
            },
            value: `ask_priority_${Date.now()}`,
            action_id: "ask_priority"
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Next Steps"
            },
            value: `ask_nextsteps_${Date.now()}`,
            action_id: "ask_nextsteps"
          }
        ]
      });
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

  // LLM fallback methods - same pattern as toolService.js
  async callLLM(prompt) {
    // Try Anthropic first
    try {
      console.log('🧠 Attempting Anthropic API...');
      return await this.callAnthropicAPI(prompt);
    } catch (anthropicError) {
      console.warn('⚠️ Anthropic API failed, falling back to Gemini:', anthropicError.message);
      try {
        return await this.callGeminiAPI(prompt);
      } catch (geminiError) {
        console.error('❌ Both Anthropic and Gemini APIs failed');
        throw new Error(`All LLM APIs failed - Anthropic: ${anthropicError.message}, Gemini: ${geminiError.message}`);
      }
    }
  }

  async callAnthropicAPI(prompt) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await axios.post(
          'https://api.anthropic.com/v1/messages',
          {
            model: 'claude-3-haiku-20240307',
            max_tokens: 2048,
            temperature: 0.1,
            messages: [
              {
                role: 'user',
                content: prompt
              }
            ]
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': process.env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01'
            },
            timeout: 10000
          }
        );

        return response.data.content[0].text;
      } catch (error) {
        console.error(`Anthropic API attempt ${attempt} failed:`, error.response?.data || error.message);
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, attempt * 1000));
          continue;
        }
        throw error;
      }
    }
  }

  async callGeminiAPI(prompt) {
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
}

module.exports = MultiSourceService;