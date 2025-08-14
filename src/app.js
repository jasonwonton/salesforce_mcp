require('dotenv').config();
const express = require('express');
const { App, ExpressReceiver } = require('@slack/bolt');
const Team = require('./models/Team');
const SalesforceService = require('./services/salesforce');
const MultiSourceService = require('./services/multiSourceService');
const MCPClient = require('./services/mcpClient');
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

// Station slash command handler - Now uses MCP for Claude AI intelligence
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
      text: "🤖 Claude AI is analyzing your question via MCP...",
      response_type: "ephemeral"
    });

    try {
      const teamId = context.teamId;
      const mcpClient = new MCPClient();
      
      // Use MCP to ask AI question
      const result = await mcpClient.askAI(question, teamId);
      
      await respond({
        text: `💬 **Claude AI Answer:** ${result.content[0].text}`,
        response_type: "in_channel"
      });
      
    } catch (error) {
      console.error('MCP Ask command error:', error);
      
      // Fallback to original method if MCP fails
      try {
        const team = await Team.findById(context.teamId);
        const multiSourceService = new MultiSourceService(team);
        const results = await multiSourceService.searchWithIntelligentPlanning("recent tickets", () => {});
        const aiResponse = await multiSourceService.answerFollowUpQuestion(question, results);
        
        await respond({
          text: `💬 **Gemini AI Answer (fallback):** ${aiResponse}`,
          response_type: "in_channel"
        });
      } catch (fallbackError) {
        await respond(`❌ **AI question failed:** ${error.message}`);
      }
    }
    return;
  }

  // Regular search mode - Use MCP for Claude AI intelligence
  await respond({
    text: "🤖 Claude AI is analyzing your request via MCP...",
    response_type: "ephemeral"
  });

  try {
    const teamId = context.teamId;
    const userId = context.userId;
    const mcpClient = new MCPClient();
    
    // Use MCP station search (Claude AI intelligence)
    const mcpResult = await mcpClient.searchWithStation(userPrompt, teamId, userId);
    
    // Parse the MCP result
    const searchData = JSON.parse(mcpResult.content[0].text);
    
    // Format response similar to original
    let responseText = `🔍 **Claude AI Search Results:** "${userPrompt}"\n\n`;
    
    if (searchData.progress && searchData.progress.length > 0) {
      responseText += `📋 **AI Planning:**\n`;
      searchData.progress.forEach(step => {
        responseText += `• ${step.message}\n`;
      });
      responseText += '\n';
    }
    
    const totalResults = searchData.results?.totalFound || 0;
    
    if (totalResults > 0) {
      responseText += `📊 **Found ${totalResults} results**\n\n`;
      
      // Salesforce results
      if (searchData.results.salesforce?.cases?.length > 0) {
        responseText += `🏢 **Salesforce Cases:**\n`;
        searchData.results.salesforce.cases.slice(0, 5).forEach(case_ => {
          responseText += `• ${case_.CaseNumber}: ${case_.Subject}\n`;
        });
        responseText += '\n';
      }
      
      // Jira results
      if (searchData.results.jira?.issues?.length > 0) {
        responseText += `🎫 **Jira Issues:**\n`;
        searchData.results.jira.issues.slice(0, 5).forEach(issue => {
          responseText += `• ${issue.key}: ${issue.summary}\n`;
        });
        responseText += '\n';
      }
      
      // AI Summary
      if (searchData.results.summary) {
        responseText += `🧠 **Claude AI Summary:** ${searchData.results.summary}`;
      }
    } else {
      responseText += `❌ No results found for "${userPrompt}"`;
    }

    await respond({
      text: responseText,
      response_type: "in_channel"
    });

  } catch (error) {
    console.error('MCP Station command error:', error);
    
    // Fallback to original Gemini-based method
    try {
      const team = await Team.findById(context.teamId);
      const multiSourceService = new MultiSourceService(team);
      
      const progressMessages = [];
      const results = await multiSourceService.searchWithIntelligentPlanning(
        userPrompt, 
        async (message) => progressMessages.push(message)
      );
      
      // Ensure teamId is available for UI links
      results.teamId = context.teamId;
      
      // Send combined final response with all progress and results
      const formattedResponse = multiSourceService.formatFinalResults(results, userPrompt, progressMessages);
      await respond(formattedResponse);
      
    } catch (fallbackError) {
      console.error('Fallback method also failed:', fallbackError);
      await respond(`❌ **Search failed:** Both Claude AI and Gemini AI methods failed. ${error.message}`);
    }
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