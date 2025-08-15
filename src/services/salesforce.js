const axios = require('axios');

class SalesforceService {
  constructor(team) {
    this.team = team;
    this.instanceUrl = team.salesforce_instance_url;
    this.accessToken = team.salesforce_access_token;
  }

  async executeSOQLQuery(query) {
    if (!this.accessToken || !this.instanceUrl) {
      throw new Error('Salesforce not connected for this team');
    }

    try {
      const response = await axios.get(
        `${this.instanceUrl}/services/data/v58.0/query`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          },
          params: {
            q: query
          }
        }
      );

      return response.data;
    } catch (error) {
      console.error('SOQL query failed:', error.response?.data || error.message);
      
      // Try to refresh token if session expired
      if (error.response?.data?.[0]?.errorCode === 'INVALID_SESSION_ID') {
        console.log('Attempting to refresh Salesforce token...');
        const refreshed = await this.refreshAccessToken();
        if (refreshed) {
          // Retry the query with new token
          return this.executeSOQLQuery(query);
        }
      }
      
      throw new Error(`SOQL query failed: ${error.response?.data?.message || error.message}`);
    }
  }

  async executeSOSLQuery(soslQuery) {
    if (!this.accessToken || !this.instanceUrl) {
      throw new Error('Salesforce not connected for this team');
    }

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
      console.log('SOSL Results:', response.data.searchRecords?.length || 0);

      return response.data;
    } catch (error) {
      console.error('SOSL query failed:', error.response?.data || error.message);
      
      // Try to refresh token if session expired
      if (error.response?.data?.[0]?.errorCode === 'INVALID_SESSION_ID') {
        console.log('Attempting to refresh Salesforce token...');
        const refreshed = await this.refreshAccessToken();
        if (refreshed) {
          // Retry the query with new token
          return this.executeSOSLQuery(soslQuery);
        }
      }
      
      throw new Error(`SOSL query failed: ${error.response?.data?.message || error.message}`);
    }
  }

  // Removed duplicate searchSupportTickets() and searchWithSOQL() methods
  // Use executeSOQLQuery() and executeSOSLQuery() instead

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

  async refreshAccessToken() {
    if (!this.team.salesforce_refresh_token) {
      console.error('No refresh token available');
      return false;
    }

    try {
      const response = await axios.post('https://login.salesforce.com/services/oauth2/token', null, {
        params: {
          grant_type: 'refresh_token',
          refresh_token: this.team.salesforce_refresh_token,
          client_id: process.env.SALESFORCE_CLIENT_ID,
          client_secret: process.env.SALESFORCE_CLIENT_SECRET
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      if (response.data.access_token) {
        // Update the access token
        this.accessToken = response.data.access_token;
        this.team.salesforce_access_token = response.data.access_token;
        
        // Update in database
        const db = require('../database');
        await db('teams').where('id', this.team.id).update({
          salesforce_access_token: response.data.access_token
        });

        console.log('✅ Salesforce token refreshed successfully');
        return true;
      }
    } catch (error) {
      console.error('Failed to refresh Salesforce token:', error.response?.data || error.message);
      return false;
    }

    return false;
  }
}

module.exports = SalesforceService;