const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

class MCPService {
  constructor() {
    this.salesforceClient = null;
    this.jiraClient = null;
  }

  async initializeSalesforce() {
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-salesforce'],
      env: {
        SALESFORCE_USERNAME: process.env.SALESFORCE_USERNAME,
        SALESFORCE_PASSWORD: process.env.SALESFORCE_PASSWORD,
        SALESFORCE_SECURITY_TOKEN: process.env.SALESFORCE_SECURITY_TOKEN,
        SALESFORCE_LOGIN_URL: process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com'
      }
    });

    this.salesforceClient = new Client({
      name: 'slack-bot-salesforce',
      version: '1.0.0'
    }, {
      capabilities: {}
    });

    await this.salesforceClient.connect(transport);
    return this.salesforceClient;
  }

  async initializeJira() {
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-jira'],
      env: {
        JIRA_URL: process.env.JIRA_URL,
        JIRA_USERNAME: process.env.JIRA_USERNAME,
        JIRA_API_TOKEN: process.env.JIRA_API_TOKEN
      }
    });

    this.jiraClient = new Client({
      name: 'slack-bot-jira', 
      version: '1.0.0'
    }, {
      capabilities: {}
    });

    await this.jiraClient.connect(transport);
    return this.jiraClient;
  }

  async searchBothSources(searchTerm) {
    try {
      // Search Salesforce
      const salesforceResults = await this.salesforceClient.callTool({
        name: 'query',
        arguments: {
          soql: `
            SELECT Id, CaseNumber, Subject, Status, CreatedDate, 
                   Account.Name, Contact.Name, Priority
            FROM Case 
            WHERE (Subject LIKE '%${searchTerm}%' OR Description LIKE '%${searchTerm}%')
              AND Status != 'Closed'
            ORDER BY CreatedDate ASC
            LIMIT 10
          `
        }
      });

      // Search Jira
      const jiraResults = await this.jiraClient.callTool({
        name: 'search',
        arguments: {
          jql: `text ~ "${searchTerm}" AND status != "Done" ORDER BY created DESC`,
          maxResults: 10
        }
      });

      return {
        salesforce: salesforceResults.content,
        jira: jiraResults.content
      };

    } catch (error) {
      console.error('MCP search error:', error);
      throw error;
    }
  }

  formatCombinedResults(results) {
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Found tickets across Salesforce & Jira:*`
        }
      }
    ];

    // Add Salesforce results
    if (results.salesforce?.records?.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Salesforce Cases (${results.salesforce.records.length}):*`
        }
      });

      results.salesforce.records.forEach(case_ => {
        blocks.push({
          type: "section", 
          text: {
            type: "mrkdwn",
            text: `🔵 *${case_.CaseNumber}* - ${case_.Subject}\n` +
                  `Customer: ${case_.Account?.Name || 'Unknown'}\n` +
                  `Status: ${case_.Status} | Priority: ${case_.Priority}`
          }
        });
      });
    }

    // Add Jira results  
    if (results.jira?.issues?.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn", 
          text: `*Jira Issues (${results.jira.issues.length}):*`
        }
      });

      results.jira.issues.forEach(issue => {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `🟠 *${issue.key}* - ${issue.fields.summary}\n` +
                  `Status: ${issue.fields.status.name}\n` +
                  `Assignee: ${issue.fields.assignee?.displayName || 'Unassigned'}`
          }
        });
      });
    }

    if (blocks.length === 1) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "No tickets found in either Salesforce or Jira."
        }
      });
    }

    return { blocks, response_type: "in_channel" };
  }
}

module.exports = MCPService;