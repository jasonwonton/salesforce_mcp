const axios = require('axios');

class JiraService {
  constructor() {
    this.baseUrl = process.env.JIRA_URL;
    this.username = process.env.JIRA_USERNAME;
    this.apiToken = process.env.JIRA_API_TOKEN;
  }

  async searchIssues(searchTerm) {
    if (!this.baseUrl || !this.username || !this.apiToken || 
        this.baseUrl === 'https://example.atlassian.net' || 
        this.username === 'placeholder' || 
        this.apiToken === 'placeholder') {
      console.log('Jira not configured, skipping Jira search');
      return [];
    }

    const jql = `text ~ "${searchTerm}" AND status != "Done" ORDER BY created DESC`;
    
    try {
      const response = await axios.get(
        `${this.baseUrl}/rest/api/2/search`,
        {
          headers: {
            'Authorization': `Basic ${Buffer.from(`${this.username}:${this.apiToken}`).toString('base64')}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          params: {
            jql: jql,
            maxResults: 5,
            fields: 'key,summary,status,assignee,created,priority'
          },
          timeout: 120000 // 2 minute timeout
        }
      );

      return response.data.issues || [];
    } catch (error) {
      if (error.response?.status === 401) {
        throw new Error('Jira authentication failed. Please check your credentials.');
      }
      console.error('Jira API error:', error.response?.data || error.message);
      throw new Error(`Jira search failed: ${error.message}`);
    }
  }

  formatResultsForSlack(issues) {
    if (!issues || issues.length === 0) {
      return [];
    }

    const blocks = [];

    issues.forEach(issue => {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🟠 *${issue.key}* - ${issue.fields.summary}\n` +
                `Status: ${issue.fields.status.name}\n` +
                `Assignee: ${issue.fields.assignee?.displayName || 'Unassigned'}\n` +
                `Priority: ${issue.fields.priority?.name || 'None'}`
        }
      });
    });

    return blocks;
  }
}

module.exports = JiraService;