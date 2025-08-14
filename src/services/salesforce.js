const axios = require('axios');

class SalesforceService {
  constructor(team) {
    this.team = team;
    this.instanceUrl = team.salesforce_instance_url;
    this.accessToken = team.salesforce_access_token;
  }

  async searchSupportTickets(searchTerm) {
    if (!this.accessToken || !this.instanceUrl) {
      throw new Error('Salesforce not connected for this team');
    }

    // First try SOSL for full-text search including Description field
    console.log('Attempting SOSL search for:', searchTerm);
    const soslQuery = `FIND {${searchTerm}} IN ALL FIELDS RETURNING Case(Id, CaseNumber, Subject, Status, CreatedDate, Account.Name, Contact.Name, Priority, Description WHERE Status != 'Closed') LIMIT 20`;

    try {
      const response = await axios.get(
        `${this.instanceUrl}/services/data/v58.0/search`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          },
          params: {
            q: soslQuery
          }
        }
      );

      console.log('SOSL Query:', soslQuery);
      console.log('SOSL URL:', `${this.instanceUrl}/services/data/v58.0/search?q=${encodeURIComponent(soslQuery)}`);
      console.log('SOSL response:', {
        status: response.status,
        searchRecords: response.data.searchRecords?.length || 0,
        fullResponse: response.data
      });

      // SOSL returns searchRecords array with nested records
      const cases = response.data.searchRecords || [];
      
      // If SOSL returns no results, try fallback SOQL query
      if (cases.length === 0) {
        console.log('SOSL returned no results, trying SOQL fallback');
        return await this.searchWithSOQL(searchTerm);
      }
      
      return cases;
    } catch (error) {
      console.error('Salesforce SOSL error details:', {
        status: error.response?.status,
        data: error.response?.data,
        query: soslQuery,
        url: `${this.instanceUrl}/services/data/v58.0/search`
      });
      
      // If SOSL fails, try SOQL as fallback
      console.log('SOSL failed, trying SOQL fallback');
      return await this.searchWithSOQL(searchTerm);
    }
  }

  async searchWithSOQL(searchTerm) {
    console.log('Using SOQL fallback for:', searchTerm);
    const soqlQuery = `
      SELECT Id, CaseNumber, Subject, Status, CreatedDate, 
             Account.Name, Contact.Name, Priority, Description
      FROM Case 
      LIMIT 20
    `;

    try {
      const response = await axios.get(
        `${this.instanceUrl}/services/data/v58.0/query`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          },
          params: {
            q: soqlQuery
          }
        }
      );

      console.log('SOQL response:', {
        status: response.status,
        records: response.data.records?.length || 0
      });

      return response.data.records || [];
    } catch (error) {
      console.error('Salesforce SOQL error details:', {
        status: error.response?.status,
        data: error.response?.data,
        query: soqlQuery,
        url: `${this.instanceUrl}/services/data/v58.0/query`
      });
      
      if (error.response?.status === 401) {
        // Token expired, need to refresh
        throw new Error('Salesforce token expired. Please reconnect.');
      }
      throw error;
    }
  }

  formatResultsForSlack(cases) {
    if (!cases || cases.length === 0) {
      return {
        text: "No support tickets found matching your search criteria.",
        response_type: "in_channel"
      };
    }

    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Found ${cases.length} support tickets:*`
        }
      }
    ];

    cases.forEach(case_ => {
      const customerName = case_.Account?.Name || 'Unknown Customer';
      const contactName = case_.Contact?.Name || 'No Contact';
      const daysWaiting = case_.DaysWaiting || 0;
      
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${case_.CaseNumber}* - ${case_.Subject}\n` +
                `Customer: ${customerName} (${contactName})\n` +
                `Status: ${case_.Status} | Priority: ${case_.Priority}\n` +
                `Waiting: ${daysWaiting} days`
        }
      });
    });

    return {
      blocks,
      response_type: "in_channel"
    };
  }
}

module.exports = SalesforceService;