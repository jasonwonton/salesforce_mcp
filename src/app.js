require('dotenv').config();
const express = require('express');
const { App, ExpressReceiver } = require('@slack/bolt');
const Team = require('./models/Team');
const SalesforceService = require('./services/salesforce');
const oauthRoutes = require('./routes/oauth');
const db = require('./database');

const port = process.env.PORT || 3000;

// Create Express receiver for Slack Bolt
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret: 'my-state-secret',
  scopes: ['commands', 'chat:write', 'users:read'],
  redirectUri: `${process.env.APP_URL}/slack/oauth_redirect`,
  installationStore: {
    storeInstallation: async (installation) => {
      const teamId = installation.team.id;
      console.log('Storing installation for team:', teamId);
      return true;
    },
    fetchInstallation: async (installQuery) => {
      console.log('Fetching installation for:', installQuery);
      return null;
    }
  },
  processBeforeResponse: true
});

// Slack Bolt App
const slackApp = new App({
  receiver
});

// Slack slash command handler
slackApp.command('/support', async ({ command, ack, respond, context }) => {
  await ack();

  try {
    const teamId = context.teamId;
    const team = await Team.findById(teamId);
    
    if (!team) {
      await respond('Team not found. Please reinstall the app.');
      return;
    }

    if (!team.salesforce_access_token) {
      await respond({
        text: 'Salesforce not connected. Please connect your Salesforce org first.',
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "You need to connect your Salesforce org to use this command."
            },
            accessory: {
              type: "button",
              text: {
                type: "plain_text",
                text: "Connect Salesforce"
              },
              url: `${process.env.APP_URL}/oauth/salesforce/connect/${teamId}`
            }
          }
        ]
      });
      return;
    }

    // Parse the command text
    const commandText = command.text.trim();
    const searchMatch = commandText.match(/look through support tickets for customers with (.+)/i);
    
    if (!searchMatch) {
      await respond('Usage: `/support look through support tickets for customers with [search term]`');
      return;
    }

    const searchTerm = searchMatch[1];
    
    // Search Salesforce
    const salesforceService = new SalesforceService(team);
    const cases = await salesforceService.searchSupportTickets(searchTerm);
    
    // Log usage
    await db('usage_logs').insert({
      team_id: teamId,
      slack_user_id: command.user_id,
      command: '/support',
      query_text: searchTerm,
      results_count: cases.length
    });

    // Format and send response
    const formattedResponse = salesforceService.formatResultsForSlack(cases);
    await respond(formattedResponse);

  } catch (error) {
    console.error('Support command error:', error);
    await respond('Sorry, there was an error processing your request. Please try again.');
  }
});

// Get the Express app from receiver
const app = receiver.app;

// Express routes
app.use(express.json());
// app.use('/oauth', oauthRoutes);

// Handle OAuth callback at root
app.get('/', (req, res) => {
  if (req.query.code && req.query.state) {
    // This is an OAuth callback, redirect to the proper Slack endpoint
    res.redirect(`/slack/oauth_redirect?code=${req.query.code}&state=${req.query.state}`);
    return;
  }
  
  // Regular home page
  res.send(`
    <html>
      <head><title>Salesforce Support Ticket Bot</title></head>
      <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
        <h1>Salesforce Support Ticket Bot</h1>
        <p>Search your Salesforce support tickets directly from Slack!</p>
        <a href="/slack/install" style="background: #4A154B; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">
          Add to Slack
        </a>
      </body>
    </html>
  `);
});

// Setup page for Salesforce connection
app.get('/setup/salesforce', (req, res) => {
  const { team_id } = req.query;
  res.send(`
    <html>
      <head><title>Connect Salesforce</title></head>
      <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
        <h1>Connect Your Salesforce Org</h1>
        <p>To use the support ticket search, please connect your Salesforce organization.</p>
        <a href="/oauth/salesforce/connect/${team_id}" style="background: #0176D3; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">
          Connect Salesforce
        </a>
      </body>
    </html>
  `);
});

// Start the server
(async () => {
  await slackApp.start(port);
  console.log(`⚡️ Salesforce Support Ticket Bot is running on port ${port}!`);
})();