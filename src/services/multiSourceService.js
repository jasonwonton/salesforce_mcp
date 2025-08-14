const SalesforceService = require('./salesforce');
const JiraService = require('./jiraService');

class MultiSourceService {
  constructor(team) {
    this.salesforceService = new SalesforceService(team);
    this.jiraService = new JiraService();
  }

  async searchBothSources(searchTerm) {
    const promises = [];
    
    // Search Salesforce (if connected)
    promises.push(
      this.salesforceService.searchSupportTickets(searchTerm)
        .catch(error => {
          console.error('Salesforce search failed:', error.message);
          return [];
        })
    );
    
    // Search Jira
    promises.push(
      this.jiraService.searchIssues(searchTerm)
        .catch(error => {
          console.error('Jira search failed:', error.message);
          return [];
        })
    );

    const [salesforceResults, jiraResults] = await Promise.all(promises);
    
    return {
      salesforce: salesforceResults,
      jira: jiraResults
    };
  }

  formatCombinedResults(results, searchTerm) {
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Search results for "${searchTerm}":*`
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