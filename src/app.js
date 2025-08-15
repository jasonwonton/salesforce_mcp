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

// Store for pending plans (in production, use Redis or database)
global.pendingPlans = global.pendingPlans || {};

// Station slash command handler - AI-powered multi-source search with Claude Code-like planning
slackApp.command('/station', async ({ command, ack, respond, context }) => {
  await ack();
  
  const userPrompt = command.text.trim();
  if (!userPrompt) {
    await respond('Usage: `/station [describe what you\'re looking for]`\nExample: `/station customer billing issues from last week`\n\nOr approve a plan: `/station approve` to execute the proposed plan.\nOr ask follow-up questions: `/station ask [your question]`');
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
    await respond({
      text: "✅ **Plan approved!** Executing tools...",
      response_type: "ephemeral"
    });

    try {
      const toolService = new ToolService(pendingPlan.team);
      
      // Execute each tool and show progress
      const toolResults = [];
      let progressText = "🚀 **Executing Plan:**\n\n";
      
      for (let i = 0; i < pendingPlan.toolPlan.selectedTools.length; i++) {
        const toolCall = pendingPlan.toolPlan.selectedTools[i];
        
        // Show current tool execution
        progressText += `⏳ **Step ${i + 1}:** Running ${toolCall.toolName}...\n`;
        await respond({
          text: progressText,
          response_type: "in_channel"
        });
        
        const result = await toolService.executeTool(toolCall.toolName, toolCall.parameters);
        toolResults.push(result);
        
        // Update progress
        const status = result.success ? "✅" : "❌";
        progressText = progressText.replace(`⏳ **Step ${i + 1}:**`, `${status} **Step ${i + 1}:**`);
      }
      
      // Format final results
      let finalResponse = progressText + "\n📋 **Results:**\n\n";
      finalResponse += formatToolResults(toolResults);
      
      // Add conversation continuation
      finalResponse += "\n💬 **Continue the conversation:** Type `/station ask [question]` to analyze these results further.";
      
      await respond({
        text: finalResponse,
        response_type: "in_channel"
      });
      
      // Clear the pending plan
      delete global.pendingPlans[planKey];
      
    } catch (error) {
      console.error('Plan execution error:', error);
      await respond(`❌ **Plan execution failed:** ${error.message}`);
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
    'search_recent_cases': 'Search recent Salesforce cases',
    'search_cases_by_keywords': 'Search cases by specific keywords',
    'sosl_discovery_search': 'SOSL discovery with time filtering and deep AI analysis',
    'deep_record_analysis': 'Deep analysis of specific records with full context',
    'search_all_objects': 'Search across all Salesforce objects',
    'search_accounts': 'Search for Salesforce accounts',
    'get_account_health': 'Find accounts with health issues',
    'search_opportunities': 'Search deals/opportunities',
    'search_jira_issues': 'Search Jira tickets and issues',
    'analyze_case_details': 'Deep analysis of specific case',
    'analyze_account_health': 'Deep dive into account health',
    'analyze_pattern_trends': 'AI analysis of patterns and trends',
    'thinking_update': 'Show AI thinking process',
    'conversational_response': 'Provide helpful guidance'
  };
  return descriptions[toolName] || 'Execute tool';
}

// Helper function to format tool results
function formatToolResults(toolResults) {
  let responseText = '';
  
  for (const result of toolResults) {
    if (result.toolName === 'conversational_response') {
      responseText = `💬 ${result.message}`;
      break;
    } else if (result.success) {
      responseText += `🔍 **${result.toolName}**: Found ${result.count} results\n`;
      
      // Show executed queries for any tool that has them
      if (result.executedQueries && result.executedQueries.length > 0) {
        responseText += `📝 **Executed Queries:**\n`;
        result.executedQueries.forEach((query, index) => {
          responseText += `${index + 1}. \`${query}\`\n`;
        });
        responseText += '\n';
      }
      
      // Handle SOSL Discovery search results
      if (result.toolName === 'sosl_discovery_search' && result.data) {
        
        // Show thinking process
        if (result.thinkingProcess) {
          responseText += `🧠 **AI Thinking Process:**\n`;
          result.thinkingProcess.forEach(step => {
            responseText += `${step}\n`;
          });
          responseText += '\n';
        }
        
        if (result.breakdown) {
          responseText += `📊 **Discovery Results:** ${result.breakdown.accounts} accounts, ${result.breakdown.contacts} contacts, ${result.breakdown.cases} cases, ${result.breakdown.opportunities} opportunities\n\n`;
        }
        
        // Show cases with Salesforce links
        if (result.data.cases && result.data.cases.length > 0) {
          responseText += `📋 **Cases Found:**\n`;
          result.data.cases.slice(0, 5).forEach((case_, index) => {
            // Construct Salesforce URL (you'll need to update with your org's URL)
            const sfUrl = `https://orgfarm-9be6ff69a6-dev-ed.develop.my.salesforce.com/${case_.Id}`;
            responseText += `${index + 1}. <${sfUrl}|${case_.CaseNumber}>: ${case_.Subject} (${case_.Status})\n`;
            if (case_.CreatedDate) {
              responseText += `   📅 Created: ${new Date(case_.CreatedDate).toLocaleDateString()}\n`;
            }
            if (case_.Priority) {
              responseText += `   🔥 Priority: ${case_.Priority}\n`;
            }
          });
          responseText += '\n';
        }
        
        // Show accounts with links
        if (result.data.accounts && result.data.accounts.length > 0) {
          responseText += `🏢 **Accounts Found:**\n`;
          result.data.accounts.slice(0, 3).forEach((account, index) => {
            const sfUrl = `https://orgfarm-9be6ff69a6-dev-ed.develop.my.salesforce.com/${account.Id}`;
            responseText += `${index + 1}. <${sfUrl}|${account.Name}> (${account.Industry || 'Unknown Industry'})\n`;
          });
          responseText += '\n';
        }
        
        // Show deep analysis if performed
        if (result.data.deepAnalysis) {
          responseText += `🧠 **AI Deep Analysis:**\n${result.data.deepAnalysis}\n\n`;
        }
        
        // Add research prompt
        if (result.data.cases && result.data.cases.length > 0) {
          const firstCase = result.data.cases[0];
          responseText += `🔍 **Want to research specific cases?**\n`;
          responseText += `Type: \`/station analyze case ${firstCase.CaseNumber || firstCase.Id}\`\n\n`;
        }
      }
      // Handle multi-object search results (legacy)
      else if (result.toolName === 'search_all_objects' && result.data) {
        if (result.breakdown) {
          responseText += `📊 **Breakdown:** ${result.breakdown.accounts} accounts, ${result.breakdown.contacts} contacts, ${result.breakdown.cases} cases, ${result.breakdown.opportunities} opportunities\n\n`;
        }
        
        // Show cases first
        if (result.data.cases && result.data.cases.length > 0) {
          responseText += `📋 **Cases:**\n`;
          result.data.cases.slice(0, 3).forEach((case_, index) => {
            responseText += `${index + 1}. ${case_.CaseNumber}: ${case_.Subject}\n`;
          });
        }
        
        // Show accounts
        if (result.data.accounts && result.data.accounts.length > 0) {
          responseText += `🏢 **Accounts:**\n`;
          result.data.accounts.slice(0, 3).forEach((account, index) => {
            responseText += `${index + 1}. ${account.Name}\n`;
          });
        }
        
        // Show opportunities
        if (result.data.opportunities && result.data.opportunities.length > 0) {
          responseText += `💰 **Opportunities:**\n`;
          result.data.opportunities.slice(0, 2).forEach((opp, index) => {
            responseText += `${index + 1}. ${opp.Name} (${opp.StageName})\n`;
          });
        }
      } 
      // Handle deep record analysis results
      else if (result.toolName === 'deep_record_analysis') {
        responseText += `🕵️ **Deep Analysis of ${result.recordType}:**\n\n`;
        
        if (result.recordType === 'Case' && result.record) {
          const sfUrl = `https://orgfarm-9be6ff69a6-dev-ed.develop.my.salesforce.com/${result.record.Id}`;
          responseText += `📋 **Case:** <${sfUrl}|${result.record.CaseNumber}> - ${result.record.Subject}\n`;
          responseText += `🏢 **Account:** ${result.record.Account?.Name}\n`;
          responseText += `📊 **Status:** ${result.record.Status} | **Priority:** ${result.record.Priority}\n`;
          responseText += `📅 **Created:** ${new Date(result.record.CreatedDate).toLocaleDateString()}\n`;
          responseText += `📊 **Related Cases:** ${result.relatedRecords}\n\n`;
        }
        
        if (result.aiAnalysis) {
          responseText += `🧠 **AI ${result.analysisType} Analysis:**\n${result.aiAnalysis}\n\n`;
        }
        
        responseText += `🔍 **Want to research more?** Try:\n`;
        responseText += `• \`/station billing issues last 30 days\` - Find similar cases\n`;
        responseText += `• \`/station analyze account ${result.record?.Account?.Name || 'ACCOUNT_NAME'}\` - Account health\n`;
      }
      // Handle deep analysis results (legacy)
      else if (result.analysis === 'deep') {
        if (result.toolName === 'analyze_case_details') {
          responseText += `📋 **Case:** ${result.caseData.CaseNumber} - ${result.caseData.Subject}\n`;
          responseText += `🏢 **Account:** ${result.caseData.Account?.Name}\n`;
          responseText += `📊 **Related Cases:** ${result.relatedCases}\n\n`;
          responseText += `🤖 **AI Analysis:**\n${result.aiAnalysis}\n`;
        } else if (result.toolName === 'analyze_account_health') {
          responseText += `🏢 **Account:** ${result.account.Name} (${result.account.Industry})\n`;
          responseText += `📊 **Support History:** ${result.caseCount} cases, ${result.opportunityCount} opportunities\n\n`;
          responseText += `🤖 **Health Analysis:**\n${result.aiAnalysis}\n`;
        }
      }
      // Handle trend analysis
      else if (result.analysis === 'trends') {
        responseText += `📈 **Analysis Type:** ${result.analysisType}\n`;
        responseText += `📅 **Period:** ${result.timeframe}\n`;
        responseText += `📊 **Data Points:** ${result.dataPoints}\n\n`;
        responseText += `🤖 **Trend Analysis:**\n${result.aiAnalysis}\n`;
      }
      // Handle advanced opportunity search results
      else if (result.toolName === 'advanced_opportunity_search' && result.data && result.data.length > 0) {
        responseText += `💰 **Opportunities Found:**\n`;
        result.data.slice(0, 5).forEach((opp, index) => {
          const sfUrl = `https://orgfarm-9be6ff69a6-dev-ed.develop.my.salesforce.com/${opp.Id}`;
          const amount = opp.Amount ? `$${Number(opp.Amount).toLocaleString()}` : 'No amount';
          responseText += `${index + 1}. <${sfUrl}|${opp.Name}> - ${amount} (${opp.StageName})\n`;
          if (opp.Account && opp.Account.Name) {
            responseText += `   🏢 Account: ${opp.Account.Name}\n`;
          }
          if (opp.CloseDate) {
            responseText += `   📅 Close Date: ${new Date(opp.CloseDate).toLocaleDateString()}\n`;
          }
        });
        responseText += '\n';
      }
      // Handle single-object results
      else if (result.data && result.data.length > 0) {
        result.data.slice(0, 5).forEach((item, index) => {
          if (item.CaseNumber) {
            responseText += `${index + 1}. ${item.CaseNumber}: ${item.Subject}\n`;
          } else if (item.Name) {
            responseText += `${index + 1}. ${item.Name}\n`;
          }
        });
      }
      responseText += '\n';
    } else {
      responseText += `❌ **${result.toolName}**: ${result.error}\n\n`;
    }
  }
  
  return responseText;
}

// Handle plan approval button
slackApp.action('approve_plan', async ({ body, ack, respond, context }) => {
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
    text: "✅ **Plan approved!** Executing tools...",
    response_type: "ephemeral"
  });

  try {
    const toolService = new ToolService(pendingPlan.team);
    
    // Execute each tool and show progress
    const toolResults = [];
    let progressText = "🚀 **Executing Plan:**\n\n";
    
    for (let i = 0; i < pendingPlan.toolPlan.selectedTools.length; i++) {
      const toolCall = pendingPlan.toolPlan.selectedTools[i];
      
      // Show current tool execution
      progressText += `⏳ **Step ${i + 1}:** Running ${toolCall.toolName}...\n`;
      await respond({
        text: progressText,
        response_type: "in_channel"
      });
      
      const result = await toolService.executeTool(toolCall.toolName, toolCall.parameters);
      toolResults.push(result);
      
      // Update progress
      const status = result.success ? "✅" : "❌";
      progressText = progressText.replace(`⏳ **Step ${i + 1}:**`, `${status} **Step ${i + 1}:**`);
    }
    
    // Format final results
    let finalResponse = progressText + "\n📋 **Results:**\n\n";
    finalResponse += formatToolResults(toolResults);
    
    // Add conversation continuation buttons
    await respond({
      text: finalResponse,
      response_type: "in_channel",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: finalResponse
          }
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "💬 Ask AI Question"
              },
              value: "ask_question",
              action_id: "prompt_question"
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "🔍 New Search"
              },
              value: "new_search",
              action_id: "prompt_new_search"
            }
          ]
        }
      ]
    });
    
    // Clear the pending plan
    delete global.pendingPlans[planKey];
    
  } catch (error) {
    console.error('Plan execution error:', error);
    await respond(`❌ **Plan execution failed:** ${error.message}`);
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

// Handle question prompting button
slackApp.action('prompt_question', async ({ body, ack, respond, context }) => {
  await ack();
  
  await respond({
    text: "💬 **What would you like to ask about the results?**\n\nExample questions:\n• What are the main issues?\n• Which cases need immediate attention?\n• What patterns do you see?\n\nType: `/station ask [your question]`",
    response_type: "ephemeral"
  });
});

// Handle new search prompting button  
slackApp.action('prompt_new_search', async ({ body, ack, respond, context }) => {
  await ack();
  
  await respond({
    text: "🔍 **Ready for a new search!**\n\nDescribe what you're looking for:\n• Recent billing issues\n• Account health for [company]\n• Open opportunities this month\n• Support trends\n\nType: `/station [your request]`",
    response_type: "ephemeral"
  });
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