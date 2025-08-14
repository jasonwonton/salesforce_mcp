require('dotenv').config();
const express = require('express');
const { App, ExpressReceiver } = require('@slack/bolt');
const Team = require('./models/Team');
const SalesforceService = require('./services/salesforce');
const MultiSourceService = require('./services/multiSourceService');
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
  installationStore: {
    storeInstallation: async (installation) => {
      const teamId = installation.team.id;
      console.log('Storing installation for team:', teamId);
      // For now, just store in memory (this will be lost on restart)
      global.installations = global.installations || {};
      global.installations[teamId] = installation;
      return true;
    },
    fetchInstallation: async (installQuery) => {
      console.log('Fetching installation for:', installQuery);
      global.installations = global.installations || {};
      const installation = global.installations[installQuery.teamId];
      console.log('Found installation:', !!installation);
      return installation || null;
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

// Station slash command handler - AI-powered multi-source search with intelligent planning
slackApp.command('/station', async ({ command, ack, respond, context }) => {
  await ack();
  
  const userPrompt = command.text.trim();
  if (!userPrompt) {
    await respond('Usage: `/station [describe what you\'re looking for]`\nExample: `/station customer billing issues from last week`\n\nOr ask follow-up questions: `/station ask what are the priority issues?`');
    return;
  }

  // Check if this is an "ask" command for follow-up questions
  if (userPrompt.toLowerCase().startsWith('ask ')) {
    const question = userPrompt.substring(4).trim();
    
    // Send immediate response to avoid timeout
    await respond({
      text: "🤖 AI is analyzing your question...",
      response_type: "ephemeral"
    });

    try {
      const teamId = context.teamId;
      let team = null;
      
      try {
        team = await Team.findById(teamId);
      } catch (error) {
        console.error('Database connection failed, continuing without team data:', error.message);
      }
      
      const multiSourceService = new MultiSourceService(team);
      
      // Get recent search context (this is simplified - in production you'd store this in a cache/database)
      const progressMessages = [];
      const results = await multiSourceService.searchWithIntelligentPlanning(
        "recent tickets", // Default search for context
        async (message) => progressMessages.push(message)
      );
      
      // Generate AI response to the follow-up question
      const aiResponse = await multiSourceService.answerFollowUpQuestion(question, results);
      
      await respond({
        text: `💬 **AI Answer:** ${aiResponse}`,
        response_type: "in_channel"
      });
      
    } catch (error) {
      console.error('Ask command error:', error);
      await respond(`❌ **AI question failed:** ${error.message}`);
    }
    return;
  }

  // Regular search mode
  // Send immediate response to avoid timeout
  await respond({
    text: "🤖 AI Agent is analyzing your request...",
    response_type: "ephemeral"
  });

  try {
    const teamId = context.teamId;
    let team = null;
    
    // Try to find team, but continue even if database fails
    try {
      team = await Team.findById(teamId);
    } catch (error) {
      console.error('Database connection failed, continuing without team data:', error.message);
    }
    
    const multiSourceService = new MultiSourceService(team);
    
    // Collect all progress messages instead of sending them individually
    const progressMessages = [];
    const results = await multiSourceService.searchWithIntelligentPlanning(
      userPrompt, 
      async (message) => progressMessages.push(message)
    );
    
    // Ensure teamId is available for UI links
    results.teamId = teamId;
    
    // Send combined final response with all progress and results
    const formattedResponse = multiSourceService.formatFinalResults(results, userPrompt, progressMessages);
    await respond(formattedResponse);
    
  } catch (error) {
    console.error('Station command error:', error);
    await respond(`❌ **AI search failed:** ${error.message}`);
  }
});

// Handle interactive button clicks for follow-up questions
slackApp.action('ask_summarize', async ({ body, ack, respond, context }) => {
  await ack();
  
  try {
    const teamId = context.teamId;
    let team = null;
    
    try {
      team = await Team.findById(teamId);
    } catch (error) {
      console.error('Database connection failed, continuing without team data:', error.message);
    }
    
    const multiSourceService = new MultiSourceService(team);
    
    // Get recent tickets for context
    const progressMessages = [];
    const results = await multiSourceService.searchWithIntelligentPlanning(
      "recent tickets",
      async (message) => progressMessages.push(message)
    );
    
    const aiResponse = await multiSourceService.answerFollowUpQuestion(
      "Please provide a summary of the current issues and their status", 
      results
    );
    
    await respond({
      text: `📋 **Issue Summary:**\n${aiResponse}`,
      response_type: "ephemeral"
    });
    
  } catch (error) {
    console.error('Summarize button error:', error);
    await respond({
      text: "❌ Failed to generate summary. Please try again.",
      response_type: "ephemeral"
    });
  }
});

slackApp.action('ask_priority', async ({ body, ack, respond, context }) => {
  await ack();
  
  try {
    const teamId = context.teamId;
    let team = null;
    
    try {
      team = await Team.findById(teamId);
    } catch (error) {
      console.error('Database connection failed, continuing without team data:', error.message);
    }
    
    const multiSourceService = new MultiSourceService(team);
    
    const progressMessages = [];
    const results = await multiSourceService.searchWithIntelligentPlanning(
      "recent tickets",
      async (message) => progressMessages.push(message)
    );
    
    const aiResponse = await multiSourceService.answerFollowUpQuestion(
      "What are the highest priority issues that need immediate attention?", 
      results
    );
    
    await respond({
      text: `🔥 **Priority Analysis:**\n${aiResponse}`,
      response_type: "ephemeral"
    });
    
  } catch (error) {
    console.error('Priority button error:', error);
    await respond({
      text: "❌ Failed to analyze priorities. Please try again.",
      response_type: "ephemeral"
    });
  }
});

slackApp.action('ask_nextsteps', async ({ body, ack, respond, context }) => {
  await ack();
  
  try {
    const teamId = context.teamId;
    let team = null;
    
    try {
      team = await Team.findById(teamId);
    } catch (error) {
      console.error('Database connection failed, continuing without team data:', error.message);
    }
    
    const multiSourceService = new MultiSourceService(team);
    
    const progressMessages = [];
    const results = await multiSourceService.searchWithIntelligentPlanning(
      "recent tickets",
      async (message) => progressMessages.push(message)
    );
    
    const aiResponse = await multiSourceService.answerFollowUpQuestion(
      "What are the recommended next steps to resolve these issues?", 
      results
    );
    
    await respond({
      text: `🎯 **Recommended Next Steps:**\n${aiResponse}`,
      response_type: "ephemeral"
    });
    
  } catch (error) {
    console.error('Next steps button error:', error);
    await respond({
      text: "❌ Failed to generate next steps. Please try again.",
      response_type: "ephemeral"
    });
  }
});

// Get the Express app from receiver
const app = receiver.app;

// Express routes
app.use(express.json());
app.use('/oauth', oauthRoutes);

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
  
  if (!team_id) {
    res.status(400).send('Team ID is required');
    return;
  }
  
  res.send(`
    <html>
      <head><title>Connect Salesforce</title></head>
      <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
        <h1>Connect Your Salesforce Org</h1>
        <p>To use the support ticket search, please connect your Salesforce organization.</p>
        <a href="/oauth/salesforce/connect/${team_id}" style="background: #0176D3; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">
          Connect Salesforce
        </a>
        <p style="margin-top: 20px; color: #666;">Team ID: ${team_id}</p>
      </body>
    </html>
  `);
});

// Start the server
(async () => {
  await slackApp.start(port);
  console.log(`⚡️ Salesforce Support Ticket Bot is running on port ${port}!`);
})();