require('dotenv').config();
const express = require('express');
const { App, ExpressReceiver } = require('@slack/bolt');
const Team = require('./models/Team');
const SalesforceService = require('./services/salesforce');
const MultiSourceService = require('./services/multiSourceService');
const ToolService = require('./services/toolService');
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



// Store for pending plans (in production, use Redis or database)
global.pendingPlans = global.pendingPlans || {};

// Station slash command handler - AI-powered multi-source search with Claude Code-like planning
slackApp.command('/station', async ({ command, ack, respond, context, client }) => {
  await ack();
  
  const userPrompt = command.text.trim();
  if (!userPrompt) {
    await respond('Usage: `/station [describe what you\'re looking for]`\nExample: `/station customer billing issues from last week`\n\nOr approve a plan: `/station approve` to execute the proposed plan.\nOr ask follow-up questions: `/station ask [your question]`\n\n💬 **Tip:** You can also DM me directly for follow-up questions after a search!');
    return;
  }

  const teamId = context.teamId;
  const userId = command.user_id;
  const planKey = `${teamId}_${userId}`;

  // Check if user is approving a plan
  if (userPrompt.toLowerCase() === 'approve') {
    const pendingPlan = global.pendingPlans[planKey];
    if (!pendingPlan) {
      await respond({
        text: "❌ No pending plan to approve. Create a plan first by asking me to search for something.",
        response_type: "ephemeral"
      });
      return;
    }

    // Execute the approved plan
    await client.chat.postMessage({
      channel: command.channel_id,
      text: "✅ **Plan approved!** Executing tools...",
      thread_ts: command.ts
    });

    try {
      const toolService = new ToolService(pendingPlan.team);
      
      // Execute each tool and show progress
      const toolResults = [];
      
      for (let i = 0; i < pendingPlan.toolPlan.selectedTools.length; i++) {
        const toolCall = pendingPlan.toolPlan.selectedTools[i];
        
        // Show current tool execution
        await client.chat.postMessage({
          channel: command.channel_id,
          text: `⏳ **Step ${i + 1}:** Running ${toolCall.toolName}...`,
          thread_ts: command.ts
        });
        
        const result = await toolService.executeTool(toolCall.toolName, toolCall.parameters);
        toolResults.push(result);
        
        // Show completion
        const status = result.success ? "✅" : "❌";
        await client.chat.postMessage({
          channel: command.channel_id,
          text: `${status} **Step ${i + 1}:** ${toolCall.toolName} complete`,
          thread_ts: command.ts
        });
      }
      
      // Format final results
      let finalResponse = "📋 **Results:**\n\n";
      finalResponse += formatToolResults(toolResults);
      
      // Add conversation continuation
      finalResponse += "\n💬 **Continue the conversation:** Type `/station ask [question]` to analyze these results further.";
      
      await client.chat.postMessage({
        channel: command.channel_id,
        text: finalResponse,
        thread_ts: command.ts
      });
      
      // Clear the pending plan
      delete global.pendingPlans[planKey];
      
    } catch (error) {
      console.error('Plan execution error:', error);
      await client.chat.postMessage({
        channel: command.channel_id,
        text: `❌ **Plan execution failed:** ${error.message}`,
        thread_ts: command.ts
      });
    }
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
        text: `💬 **AI Answer:** ${aiResponse}\n\n🔄 **Continue:** Ask another question with \`/station ask [question]\``,
        response_type: "in_channel"
      });
      
    } catch (error) {
      console.error('Ask command error:', error);
      await respond(`❌ **AI question failed:** ${error.message}`);
    }
    return;
  }

  // Planning phase - like Claude Code
  await respond({
    text: "🧠 **AI is analyzing your request and creating a plan...**",
    response_type: "ephemeral"
  });

  try {
    let team = null;
    try {
      team = await Team.findById(teamId);
      console.log('Team found:', !!team, team?.salesforce_access_token ? 'with SF token' : 'no SF token');
    } catch (error) {
      console.error('Database connection failed:', error.message);
    }
    
    const toolService = new ToolService(team);
    
    // Check if there's an existing plan to refine
    const existingPlan = global.pendingPlans[planKey];
    let contextPrompt = userPrompt;
    
    if (existingPlan) {
      // This is a plan refinement
      contextPrompt = `Original request: "${existingPlan.userPrompt}"\n\nPrevious plan: ${existingPlan.toolPlan.reasoning}\n\nRefinement request: "${userPrompt}"\n\nPlease create a new plan incorporating this feedback.`;
      console.log('Refining existing plan for:', existingPlan.userPrompt);
    } else {
      console.log('Creating new plan for:', userPrompt);
    }
    
    // Step 1: AI creates a plan with timeout protection
    console.log('Calling AI for plan generation...');
    const planStartTime = Date.now();
    
    const toolPlan = await Promise.race([
      toolService.analyzeRequestAndSelectTools(contextPrompt),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Plan generation timeout')), 25000)
      )
    ]);
    
    console.log('Plan generated in', Date.now() - planStartTime, 'ms:', toolPlan);
    
    // Store the plan for approval
    global.pendingPlans[planKey] = {
      userPrompt: existingPlan ? existingPlan.userPrompt : userPrompt,
      refinementRequest: existingPlan ? userPrompt : null,
      toolPlan,
      team,
      channelId: command.channel_id,
      timestamp: Date.now()
    };
    
    // Present the plan for approval (like Claude Code)
    const displayPrompt = existingPlan ? existingPlan.userPrompt : userPrompt;
    let planText = `📋 **${existingPlan ? 'Refined Plan' : 'Plan'} for:** "${displayPrompt}"\n\n`;
    
    if (existingPlan) {
      planText += `💭 **Your refinement:** "${userPrompt}"\n\n`;
    }
    
    planText += `🧠 **AI Reasoning:** ${toolPlan.reasoning}\n\n`;
    planText += `🔧 **Proposed Tools:**\n`;
    
    toolPlan.selectedTools.forEach((tool, index) => {
      planText += `${index + 1}. **${tool.toolName}** - ${getToolDescription(tool.toolName)}\n`;
      if (tool.parameters && Object.keys(tool.parameters).length > 0) {
        planText += `   Parameters: ${JSON.stringify(tool.parameters)}\n`;
      }
    });
    
    planText += `\n✅ **Ready to proceed?**\n\n`;
    planText += `💡 **Note:** If buttons don't work, type \`/station approve\` to execute this plan.`;
    
    console.log('Sending plan with buttons for planKey:', planKey);
    
    try {
      await respond({
        text: planText,
        response_type: "in_channel",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: planText
            }
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "✅ Execute Plan"
                },
                value: planKey,
                action_id: "approve_plan",
                style: "primary"
              },
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "💭 Refine Plan"
                },
                value: planKey,
                action_id: "refine_plan"
              },
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "❌ Cancel"
                },
                value: planKey,
                action_id: "cancel_plan",
                style: "danger"
              }
            ]
          }
        ]
      });
    } catch (blockError) {
      console.error('Failed to send blocks, falling back to text:', blockError);
      // Fallback without blocks if interactive components not configured
      await respond({
        text: planText + `\n\n**Interactive buttons not available.** Type \`/station approve\` to execute this plan.`,
        response_type: "in_channel"
      });
    }
    
  } catch (error) {
    console.error('Planning error:', error);
    await respond(`❌ **Planning failed:** ${error.message}`);
  }
});

// Helper function to get tool descriptions
function getToolDescription(toolName) {
  const descriptions = {
    'search_records': 'Search Salesforce objects with keywords and filters',
    'analyze_record': 'Deep analysis of specific records with AI insights',
    'cross_object_search': 'Search across multiple Salesforce objects',
    'conversational_response': 'Provide helpful guidance'
  };
  return descriptions[toolName] || 'Execute tool';
}

// Helper function to format tool results
function formatToolResults(toolResults) {
  let responseText = '';
  
  for (const result of toolResults) {
    if (result.toolName === 'direct_response') {
      responseText = `💬 ${result.data}`;
      break;
    } else if (result.toolName === 'ask_clarification') {
      responseText = `❓ **Need more info:** ${result.data}`;
      break;
    } else if (result.success && result.toolName === 'search_salesforce') {
      // Show the original query
      responseText += `🔍 **Searched for:** "${result.query}"\n`;
      if (result.keywords && result.keywords.length > 0) {
        responseText += `📝 **Keywords:** ${result.keywords.join(', ')}\n\n`;
      }
      
      const data = result.data;
      let totalResults = 0;
      
      // Count total results
      Object.keys(data).forEach(key => {
        if (data[key] && data[key].length > 0) {
          totalResults += data[key].length;
        }
      });
      
      if (totalResults === 0) {
        responseText += `❌ No results found. Try different keywords or broader search terms.\n\n`;
        continue;
      }
      
      responseText += `📊 **Found ${totalResults} results**\n\n`;
      
      // Show cases with Salesforce links
      if (data.cases && data.cases.length > 0) {
        responseText += `📋 **Cases (${data.cases.length}):**\n`;
        data.cases.forEach((case_, index) => {
          const sfUrl = `https://orgfarm-9be6ff69a6-dev-ed.develop.my.salesforce.com/${case_.Id}`;
          responseText += `${index + 1}. <${sfUrl}|${case_.CaseNumber || case_.Id}>: ${case_.Subject || 'No Subject'} (${case_.Status || 'Unknown'})\n`;
          
          // Show days ago instead of created date
          if (case_.CreatedDate) {
            const daysAgo = Math.floor((Date.now() - new Date(case_.CreatedDate)) / (1000 * 60 * 60 * 24));
            responseText += `   📅 Created: ${daysAgo} days ago\n`;
          }
          
          // Show account value instead of priority
          if (case_.Account && case_.Account.AnnualRevenue) {
            const revenue = Number(case_.Account.AnnualRevenue).toLocaleString();
            responseText += `   💰 Account Value: $${revenue}\n`;
          }
          
          // Show account name
          if (case_.Account && case_.Account.Name) {
            responseText += `   🏢 Account: ${case_.Account.Name}\n`;
          }
        });
        responseText += '\n';
      }
      
      // Show opportunities
      if (data.opportunities && data.opportunities.length > 0) {
        responseText += `💰 **Opportunities (${data.opportunities.length}):**\n`;
        data.opportunities.slice(0, 5).forEach((opp, index) => {
          const sfUrl = `https://orgfarm-9be6ff69a6-dev-ed.develop.my.salesforce.com/${opp.Id}`;
          const amount = opp.Amount ? `$${Number(opp.Amount).toLocaleString()}` : 'No amount';
          responseText += `${index + 1}. <${sfUrl}|${opp.Name}>: ${amount} (${opp.StageName || 'Unknown Stage'})\n`;
        });
        responseText += '\n';
      }
      
      // Show accounts
      if (data.accounts && data.accounts.length > 0) {
        responseText += `🏢 **Accounts (${data.accounts.length}):**\n`;
        data.accounts.slice(0, 5).forEach((account, index) => {
          const sfUrl = `https://orgfarm-9be6ff69a6-dev-ed.develop.my.salesforce.com/${account.Id}`;
          responseText += `${index + 1}. <${sfUrl}|${account.Name}> (${account.Industry || 'Unknown Industry'})\n`;
        });
        responseText += '\n';
      }
      
      // Show contacts
      if (data.contacts && data.contacts.length > 0) {
        responseText += `👤 **Contacts (${data.contacts.length}):**\n`;
        data.contacts.slice(0, 5).forEach((contact, index) => {
          const sfUrl = `https://orgfarm-9be6ff69a6-dev-ed.develop.my.salesforce.com/${contact.Id}`;
          responseText += `${index + 1}. <${sfUrl}|${contact.Name}> (${contact.Email || 'No email'})\n`;
        });
        responseText += '\n';
      }
      
      // Show AI analysis if present
      if (result.deepAnalysis) {
        responseText += `🧠 **AI Analysis:**\n${result.deepAnalysis}\n\n`;
      }
    } else {
      responseText += `❌ **${result.toolName}**: ${result.error}\n\n`;
    }
  }
  
  return responseText;
}
// Handle plan approval button
slackApp.action('approve_plan', async ({ body, ack, respond, context, client }) => {
  await ack();
  
  const planKey = body.actions[0].value;
  const pendingPlan = global.pendingPlans[planKey];
  
  if (!pendingPlan) {
    await respond({
      text: "❌ Plan expired or not found. Please create a new plan.",
      response_type: "ephemeral"
    });
    return;
  }

  // Execute the approved plan
  await respond({
    text: `✅ **Plan approved!** Executing tools...\n\n🔍 **Original Request:** "${pendingPlan.userPrompt}"`,
    response_type: "ephemeral"
  });

  try {
    const toolService = new ToolService(pendingPlan.team);
    
    // Create a thread for the execution
    const threadMessage = await client.chat.postMessage({
      channel: pendingPlan.channelId,
      text: "🚀 **Executing Plan in Thread**\n\nI'll show you the progress and results here.",
      thread_ts: body.message.ts
    });
    
    // Execute each tool and show progress in the thread
    const toolResults = [];
    
    for (let i = 0; i < pendingPlan.toolPlan.selectedTools.length; i++) {
      const toolCall = pendingPlan.toolPlan.selectedTools[i];
      
      // Show current tool execution in thread with query details
      let progressMessage = `⏳ **Step ${i + 1}:** Running ${toolCall.toolName}...`;
      
      // Add query details if it's search_salesforce
      if (toolCall.toolName === 'search_salesforce') {
        const query = toolCall.parameters.query || 'No query specified';
        progressMessage += `\n\n🔍 **Query:** ${query}`;
        
        // Add parsed parameters if available
        if (toolCall.parameters.objectTypes) {
          progressMessage += `\n📊 **Objects:** ${toolCall.parameters.objectTypes.join(', ')}`;
        }
        if (toolCall.parameters.timeRange) {
          progressMessage += `\n⏰ **Time Range:** ${toolCall.parameters.timeRange}`;
        }
        if (toolCall.parameters.keywords && toolCall.parameters.keywords.length > 0) {
          progressMessage += `\n🔑 **Keywords:** ${toolCall.parameters.keywords.join(', ')}`;
        }
        
        // Add actual query details
        if (toolCall.parameters.objectTypes && toolCall.parameters.objectTypes.includes('Case')) {
          progressMessage += `\n\n📝 **SOQL Query:** \`SELECT Id, CaseNumber, Subject, Status, CreatedDate, Account.Name, Account.AnnualRevenue FROM Case WHERE Status = 'Closed' AND CreatedDate = LAST_N_DAYS:30 ORDER BY CreatedDate DESC\``;
        }
      }
      
      await client.chat.postMessage({
        channel: pendingPlan.channelId,
        text: progressMessage,
        thread_ts: body.message.ts
      });
      
      const result = await toolService.executeTool(toolCall.toolName, toolCall.parameters);
      toolResults.push(result);
      
      // Show completion in thread with result summary
      const status = result.success ? "✅" : "❌";
      let completionMessage = `${status} **Step ${i + 1}:** ${toolCall.toolName} complete`;
      
      // Add result summary for search_salesforce
      if (toolCall.toolName === 'search_salesforce' && result.success && result.data) {
        let totalResults = 0;
        Object.values(result.data).forEach(arr => {
          if (Array.isArray(arr)) {
            totalResults += arr.length;
          }
        });
        completionMessage += `\n📊 **Found:** ${totalResults} total records`;
        
        // Show breakdown by object type
        Object.entries(result.data).forEach(([type, records]) => {
          if (Array.isArray(records) && records.length > 0) {
            completionMessage += `\n  • ${type}: ${records.length} records`;
          }
        });
      }
      
      await client.chat.postMessage({
        channel: pendingPlan.channelId,
        text: completionMessage,
        thread_ts: body.message.ts
      });
    }
    
    // Format final results
    let finalResponse = "📋 **Results:**\n\n";
    finalResponse += formatToolResults(toolResults);
    
    // Send final results in thread
    await client.chat.postMessage({
      channel: pendingPlan.channelId,
      text: finalResponse,
      thread_ts: body.message.ts
    });
    
    // Send AI analysis placeholder
    setTimeout(async () => {
      await client.chat.postMessage({
        channel: pendingPlan.channelId,
        text: "🧠 **AI Analysis Available:** Reply to this thread with questions like:\n• 'What patterns do you see in these cases?'\n• 'Which accounts have the most issues?'\n• 'What are the main problem categories?'\n• 'Analyze the trends in these results'",
        thread_ts: body.message.ts
      });
    }, 1000);
    
    // Send follow-up guidance in thread
    setTimeout(async () => {
      await client.chat.postMessage({
        channel: pendingPlan.channelId,
        text: "💬 **Ask me anything about these results!** I'll remember the context for follow-up questions.",
        thread_ts: body.message.ts
      });
    }, 2000);
    
    setTimeout(async () => {
      await client.chat.postMessage({
        channel: pendingPlan.channelId,
        text: "🔍 **Ready for a new search?** Use `/station [your request]` to start fresh!",
        thread_ts: body.message.ts
      });
    }, 3000);
    
    // Clear the pending plan
    delete global.pendingPlans[planKey];
    
  } catch (error) {
    console.error('Plan execution error:', error);
    await client.chat.postMessage({
      channel: pendingPlan.channelId,
      text: `❌ **Plan execution failed:** ${error.message}`,
      thread_ts: body.message.ts
    });
  }
});

// Handle plan refinement button
slackApp.action('refine_plan', async ({ body, ack, respond, context }) => {
  await ack();
  
  const planKey = body.actions[0].value;
  const pendingPlan = global.pendingPlans[planKey];
  
  if (!pendingPlan) {
    await respond({
      text: "❌ Plan expired or not found. Please create a new plan.",
      response_type: "ephemeral"
    });
    return;
  }
  
  await respond({
    text: `💭 **Refine the plan for:** "${pendingPlan.userPrompt}"\n\n**Current plan:**\n${pendingPlan.toolPlan.reasoning}\n\n**What changes would you like?**\n\nExamples:\n• "Also search for opportunities"\n• "Focus only on high priority cases"\n• "Include account health analysis"\n• "Search last 30 days instead of today"\n\n**Type:** \`/station [your refinement request]\` to update the plan`,
    response_type: "ephemeral"
  });
});

// Handle plan cancellation button
slackApp.action('cancel_plan', async ({ body, ack, respond, context }) => {
  await ack();
  
  const planKey = body.actions[0].value;
  delete global.pendingPlans[planKey];
  
  await respond({
    text: "❌ **Plan cancelled.** You can create a new plan by describing what you're looking for with `/station [your request]`.",
    response_type: "ephemeral"
  });
});

// Action handlers for prompt_question and prompt_new_search removed
// These buttons have been replaced with successive messages to avoid 404 errors

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

// Handle direct messages and threaded responses
slackApp.message(async ({ message, say, context, client }) => {
  // Skip bot messages and messages in channels
  if (message.bot_id || message.channel_type === 'C') return;
  
  // Handle direct messages (DM with bot)
  if (message.channel_type === 'IM') {
    await handleDirectMessage(message, say, context, client);
    return;
  }
  
  // Handle threaded messages (replies in channels)
  if (message.thread_ts) {
    await handleThreadedMessage(message, say, context, client);
    return;
  }
});

// Handle direct messages with the bot
async function handleDirectMessage(message, say, context, client) {
  try {
    const teamId = context.teamId;
    let team = null;
    
    try {
      team = await Team.findById(teamId);
    } catch (error) {
      console.error('Database connection failed:', error.message);
      await say('❌ Sorry, I\'m having trouble connecting to your workspace. Please try again later.');
      return;
    }
    
    if (!team || !team.salesforce_access_token) {
      await say('❌ **Salesforce not connected.** Please connect your Salesforce org first using the `/station` command in a channel, then come back here for follow-up questions.');
      return;
    }
    
    const userMessage = message.text.trim();
    
    // Show thinking
    await say('🤔 **Analyzing your message...**');
    
    // Check if this is a follow-up question or new request
    const isFollowUp = await isFollowUpQuestion(userMessage);
    
    if (isFollowUp) {
      await handleFollowUpQuestion(userMessage, team, say, client);
    } else {
      await handleNewRequest(userMessage, team, say, client);
    }
    
  } catch (error) {
    console.error('Direct message error:', error);
    await say(`❌ **Error:** Sorry, I encountered an error: ${error.message}`);
  }
}

// Handle threaded messages in channels
async function handleThreadedMessage(message, say, context, client) {
  // Check if this is a thread we're tracking
  global.activeThreads = global.activeThreads || {};
  const threadContext = global.activeThreads[message.thread_ts];
  
  if (!threadContext) return;
  
  // Clean up old threads (older than 1 hour)
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  Object.keys(global.activeThreads).forEach(threadId => {
    if (global.activeThreads[threadId].timestamp < oneHourAgo) {
      delete global.activeThreads[threadId];
    }
  });
  
  try {
    const team = await Team.findById(threadContext.teamId);
    if (!team) return;
    
    const userQuestion = message.text;
    
    // Show thinking
    await say({
      text: `🤔 Analyzing your follow-up question: "${userQuestion}"`,
      thread_ts: message.thread_ts
    });
    
    const toolService = new ToolService(team);
    
    // Decide if we need new data or can answer from context
    const needsNewSearch = await shouldSearchForNewData(userQuestion, threadContext.userRequest);
    
    if (needsNewSearch) {
      // Perform new search
      await say({
        text: `🔍 This question requires new data. Searching...`,
        thread_ts: message.thread_ts
      });
      
      let toolPlan;
      try {
        toolPlan = await toolService.analyzeRequestAndSelectTools(userQuestion);
      } catch (error) {
        await say({
          text: `❌ Sorry, I had trouble understanding your question: ${error.message}`,
          thread_ts: message.thread_ts
        });
        return;
      }
      
      // Execute tools
      const toolResults = [];
      for (const toolCall of toolPlan.selectedTools) {
        const result = await toolService.executeTool(toolCall.toolName, toolCall.parameters);
        toolResults.push(result);
      }
      
      let response = "📋 **New Results:**\n\n";
      response += formatToolResults(toolResults);
      
      await say({
        text: response,
        thread_ts: message.thread_ts
      });
      
      // Update thread context
      threadContext.toolResults = toolResults;
      threadContext.timestamp = Date.now();
      
    } else {
      // Answer from existing context
      await say({
        text: `💭 Let me analyze the existing data to answer your question...`,
        thread_ts: message.thread_ts
      });
      
      const contextualAnswer = await generateContextualAnswer(userQuestion, threadContext.toolResults);
      
      await say({
        text: `💬 **Answer:**\n\n${contextualAnswer}`,
        thread_ts: message.thread_ts
      });
    }
    
  } catch (error) {
    console.error('Thread message error:', error);
    await say({
      text: `❌ Sorry, I encountered an error: ${error.message}`,
      thread_ts: message.thread_ts
    });
  }
}

// Handle new requests in DM
async function handleNewRequest(userMessage, team, say, client) {
  try {
    const toolService = new ToolService(team);
    
    // Analyze request and create plan
    let toolPlan;
    try {
      toolPlan = await toolService.analyzeRequestAndSelectTools(userMessage);
    } catch (error) {
      await say(`❌ **Analysis Failed:** Sorry, I had trouble understanding your request. Please try rephrasing it.\n\nError: ${error.message}`);
      return;
    }
    
    // Show plan
    await say(`🎯 **Plan:** ${toolPlan.reasoning}\n\n🚀 **Executing...**`);
    
    // Execute tools with status updates
    const toolResults = [];
    for (let i = 0; i < toolPlan.selectedTools.length; i++) {
      const toolCall = toolPlan.selectedTools[i];
      
      // Show what we're doing
      await say(`⏳ **Step ${i + 1}:** Running ${toolCall.toolName}...`);
      
      const result = await toolService.executeTool(toolCall.toolName, toolCall.parameters);
      toolResults.push(result);
      
      // Show completion
      const status = result.success ? "✅" : "❌";
      await say(`${status} **Step ${i + 1}:** ${toolCall.toolName} complete`);
    }
    
    // Format and send final results
    let finalResponse = "📋 **Results:**\n\n";
    finalResponse += formatToolResults(toolResults);
    
    await say(finalResponse);
    
    // Store context for follow-up questions
    global.dmContexts = global.dmContexts || {};
    global.dmContexts[team.id] = {
      userRequest: userMessage,
      toolResults,
      timestamp: Date.now()
    };
    
    // Provide guidance for follow-up
    await say("💬 **Ask me anything about these results!** I'll remember the context for follow-up questions.");
    
  } catch (error) {
    console.error('New request error:', error);
    await say(`❌ **Error:** Sorry, there was an error processing your request: ${error.message}`);
  }
}

// Handle follow-up questions in DM
async function handleFollowUpQuestion(userMessage, team, say, client) {
  try {
    global.dmContexts = global.dmContexts || {};
    const context = global.dmContexts[team.id];
    
    if (!context || !context.toolResults) {
      await say("❌ **No context found.** Please start a new conversation by describing what you're looking for.");
      return;
    }
    
    // Check if context is still fresh (within 1 hour)
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    if (context.timestamp < oneHourAgo) {
      await say("⏰ **Context expired.** Please start a new conversation by describing what you're looking for.");
      delete global.dmContexts[team.id];
      return;
    }
    
    await say("💭 **Analyzing your follow-up question...**");
    
    // Generate contextual answer
    const answer = await generateContextualAnswer(userMessage, context.toolResults);
    
    await say(`💬 **Answer:**\n\n${answer}`);
    
    // Update context timestamp
    context.timestamp = Date.now();
    
  } catch (error) {
    console.error('Follow-up question error:', error);
    await say(`❌ **Error:** Sorry, I encountered an error: ${error.message}`);
  }
}

// Helper: Determine if a message is a follow-up question
async function isFollowUpQuestion(message) {
  const followUpKeywords = [
    'what about', 'how about', 'can you', 'could you', 'would you',
    'what is', 'how is', 'why is', 'when is', 'where is',
    'analyze', 'explain', 'describe', 'summarize', 'compare',
    'trend', 'pattern', 'insight', 'recommendation', 'suggestion'
  ];
  
  const lowerMessage = message.toLowerCase();
  return followUpKeywords.some(keyword => lowerMessage.includes(keyword));
}

// Helper function to determine if new search is needed
async function shouldSearchForNewData(question, originalRequest) {
  const contextualKeywords = ['what', 'which', 'how many', 'explain', 'analyze', 'summarize', 'why', 'when'];
  const searchKeywords = ['find', 'search', 'get', 'show', 'recent', 'new', 'different', 'other'];
  
  const lowerQuestion = question.toLowerCase();
  
  // Simple heuristic: if question contains search terms, do new search
  return searchKeywords.some(keyword => lowerQuestion.includes(keyword));
}

// Helper function to generate contextual answers
async function generateContextualAnswer(question, toolResults) {
  // Simple contextual analysis
  let context = "Based on the previous search results:\n\n";
  
  toolResults.forEach((result, index) => {
    if (result.success && result.data) {
      if (Array.isArray(result.data)) {
        context += `- Found ${result.data.length} ${result.toolName.replace('_', ' ')} results\n`;
      } else if (typeof result.data === 'object') {
        const keys = Object.keys(result.data);
        keys.forEach(key => {
          if (Array.isArray(result.data[key])) {
            context += `- Found ${result.data[key].length} ${key}\n`;
          }
        });
      }
    }
  });
  
  // Basic question answering
  const lowerQuestion = question.toLowerCase();
  
  if (lowerQuestion.includes('how many') || lowerQuestion.includes('count')) {
    return context + "\nUse the counts above to answer your question.";
  }
  
  if (lowerQuestion.includes('summarize') || lowerQuestion.includes('summary')) {
    return context + "\nThis summarizes what was found in the previous search.";
  }
  
  return context + "\nI can help analyze this data further. Try asking specific questions about the results above.";
}

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