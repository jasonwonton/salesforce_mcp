require('dotenv').config();
const ToolService = require('./src/services/toolService');

// Simple test of AI tool selection without database
async function testAISelection() {
  console.log('🧠 AI TOOL SELECTION TEST');
  console.log('==========================\n');

  const toolService = new ToolService(null); // No team needed for tool selection

  const testQueries = [
    "Get recent support cases related to United Oil & Gas, Singapore",
    "Get all opportunities with the word motor in it that are > 25k", 
    "Get all won opportunities with the word oil in it that are > 25k",
    "Get all red accounts with the word motor in it",
    "Get me a full research rundown of United Oil & Gas, Singapore",
    "Get all current in flight opportunities (last 30 days)",
    "Get all lost opportunities with the word motor in it"
  ];

  for (const [index, query] of testQueries.entries()) {
    console.log(`\n📋 Test ${index + 1}: ${query}`);
    console.log('─'.repeat(60));

    try {
      const startTime = Date.now();
      const result = await toolService.analyzeRequestAndSelectTools(query);
      const duration = Date.now() - startTime;

      console.log(`⚡ Duration: ${duration}ms`);
      console.log(`🎯 Selected Tool: ${result.selectedTools[0]?.toolName || 'None'}`);
      console.log(`🧠 AI Reasoning: ${result.reasoning}`);
      console.log(`🔧 Parameters:`);
      console.log(JSON.stringify(result.selectedTools[0]?.parameters || {}, null, 2));

      // Show what queries this would generate
      const tool = result.selectedTools[0];
      if (tool) {
        console.log(`\n📝 Expected Queries:`);
        
        if (tool.toolName === 'advanced_opportunity_search') {
          if (tool.parameters.keywords) {
            console.log(`   SOSL: FIND {${tool.parameters.keywords[0]}} RETURNING Opportunity(...)`);
          }
          
          const conditions = [];
          if (tool.parameters.minAmount) conditions.push(`Amount >= ${tool.parameters.minAmount}`);
          if (tool.parameters.stage === 'Won') conditions.push('IsWon = true');
          if (tool.parameters.stage === 'Lost') conditions.push('IsWon = false AND IsClosed = true');
          if (tool.parameters.timeframe === 'last_30_days') conditions.push('CreatedDate = LAST_N_DAYS:30');
          
          if (conditions.length > 0) {
            console.log(`   SOQL: SELECT ... FROM Opportunity WHERE ${conditions.join(' AND ')}`);
          }
        }
        
        if (tool.toolName === 'sosl_discovery_search') {
          if (tool.parameters.keywords) {
            console.log(`   SOSL: FIND {${tool.parameters.keywords[0]}} RETURNING Account(...), Case(...)`);
          }
          if (tool.parameters.timeFilter) {
            console.log(`   Filter: ${tool.parameters.timeFilter} (applied in memory)`);
          }
        }
        
        if (tool.toolName === 'advanced_account_search') {
          if (tool.parameters.keywords) {
            console.log(`   SOSL: FIND {${tool.parameters.keywords[0]}} RETURNING Account(...)`);
          }
          if (tool.parameters.includeContacts === 'true') {
            console.log(`   SOQL: SELECT ... FROM Contact WHERE AccountId IN (...)`);
          }
          if (tool.parameters.analysisDepth === 'full') {
            console.log(`   SOQL: SELECT ... FROM Case WHERE AccountId IN (...) GROUP BY AccountId`);
          }
        }
      }

    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  }
  
  console.log('\n✅ AI Tool Selection Test Complete!');
  console.log('\n📝 To test actual execution:');
  console.log('1. Set up a test team with Salesforce connection');
  console.log('2. Run: node run-test-suite.js');
  console.log('3. Or test individual queries in Slack with /station');
}

// Run the test
testAISelection().catch(console.error);