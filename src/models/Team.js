const db = require('../database');
const { encrypt, decrypt } = require('../services/encryption');

class Team {
  static async create(teamData) {
    const encryptedData = {
      ...teamData,
      slack_access_token: encrypt(teamData.slack_access_token),
      slack_bot_token: encrypt(teamData.slack_bot_token),
      salesforce_access_token: teamData.salesforce_access_token ? encrypt(teamData.salesforce_access_token) : null,
      salesforce_refresh_token: teamData.salesforce_refresh_token ? encrypt(teamData.salesforce_refresh_token) : null,
      salesforce_client_secret: teamData.salesforce_client_secret ? encrypt(teamData.salesforce_client_secret) : null
    };

    const [team] = await db('teams').insert(encryptedData).returning('*');
    return this.decrypt(team);
  }

  static async findById(id) {
    const team = await db('teams').where({ id }).first();
    return team ? this.decrypt(team) : null;
  }

  static async updateSalesforceCredentials(teamId, credentials) {
    const encryptedCredentials = {
      salesforce_instance_url: credentials.instance_url,
      salesforce_access_token: encrypt(credentials.access_token),
      salesforce_refresh_token: encrypt(credentials.refresh_token),
      salesforce_client_id: credentials.client_id,
      salesforce_client_secret: encrypt(credentials.client_secret)
    };

    await db('teams').where({ id: teamId }).update(encryptedCredentials);
    return this.findById(teamId);
  }

  static decrypt(team) {
    if (!team) return null;
    
    return {
      ...team,
      slack_access_token: decrypt(team.slack_access_token),
      slack_bot_token: decrypt(team.slack_bot_token),
      salesforce_access_token: team.salesforce_access_token ? decrypt(team.salesforce_access_token) : null,
      salesforce_refresh_token: team.salesforce_refresh_token ? decrypt(team.salesforce_refresh_token) : null,
      salesforce_client_secret: team.salesforce_client_secret ? decrypt(team.salesforce_client_secret) : null
    };
  }
}

module.exports = Team;