require('dotenv').config();
const ToolService = require('./src/services/toolService');

// Show what actual queries would be generated
async function showQueries() {
  console.log('🎯 ACTUAL QUERY GENERATION TEST');
  console.log('================================\n');

  // Create tool service without team (just for query generation)
  const toolService = new ToolService(null);

  const testQueries = [
    "Get recent support cases related to United Oil & Gas, Singapore",
    "Get all opportunities with the word motor in it that are > 25k",
    "Get all won opportunities with the word oil in it that are > 25k",
    "Get all red accounts with the word motor in it",
    "Get all current in flight opportunities (last 30 days)"
  ];

  for (const query of testQueries) {
    console.log(`\n📋 Query: "${query}"`);
    console.log('─'.repeat(60));
    
    await waitForEnter();

    try {
      // Get AI tool selection
      const result = await toolService.analyzeRequestAndSelectTools(query);
      const tool = result.selectedTools[0];
      
      console.log(`🎯 Selected Tool: ${tool.toolName}`);
      console.log(`🔧 Parameters:`, JSON.stringify(tool.parameters, null, 2));
      
      // Generate the actual queries this would create
      console.log('\n📝 Generated Queries:');
      
      if (tool.toolName === 'sosl_discovery_search') {
        if (tool.parameters.keywords) {
          tool.parameters.keywords.forEach((keyword, i) => {
            console.log(`${i + 1}. SOSL: FIND {${keyword}} RETURNING Account(Id, Name, Industry), Case(Id, CaseNumber, Subject, Status, Priority, CreatedDate, Account.Name), Contact(Id, Name, Email, AccountId), Opportunity(Id, Name, StageName, Amount, Account.Name)`);
          });
        }
        
        if (tool.parameters.timeFilter) {
          console.log(`\n   Time Filter: ${tool.parameters.timeFilter} (applied in memory after SOSL)`);
        }
        
        if (tool.parameters.deepAnalysis === true || tool.parameters.deepAnalysis === 'true') {
          console.log(`\n   🧠 AI Analysis: Would analyze all found records for patterns and insights`);
        }
      }
      
      if (tool.toolName === 'advanced_opportunity_search') {
        // Show SOSL query first
        if (tool.parameters.keywords) {
          console.log(`1. SOSL Discovery: FIND {${tool.parameters.keywords[0]}} RETURNING Opportunity(Id, Name, StageName, Amount, CloseDate, Account.Name)`);
        }
        
        // Show SOQL filtering
        const conditions = [];
        if (tool.parameters.minAmount) conditions.push(`Amount >= ${tool.parameters.minAmount}`);
        if (tool.parameters.maxAmount) conditions.push(`Amount <= ${tool.parameters.maxAmount}`);
        if (tool.parameters.stage === 'Won') conditions.push('IsWon = true');
        if (tool.parameters.stage === 'Lost') conditions.push('IsWon = false AND IsClosed = true');
        if (tool.parameters.stage === 'Open') conditions.push('IsClosed = false');
        if (tool.parameters.timeframe === 'last_30_days') conditions.push('CreatedDate = LAST_N_DAYS:30');
        
        if (conditions.length > 0) {
          console.log(`2. SOQL Filter: SELECT Id, Name, StageName, Amount, CloseDate, Account.Name FROM Opportunity WHERE ${conditions.join(' AND ')}`);
        }
        
        if (tool.parameters.searchMethod) {
          console.log(`\n   🎯 Search Strategy: ${tool.parameters.searchMethod}`);
        }
      }
      
      if (tool.toolName === 'advanced_account_search') {
        if (tool.parameters.keywords) {
          console.log(`1. SOSL Discovery: FIND {${tool.parameters.keywords[0]}} RETURNING Account(Id, Name, Industry, Phone, Type)`);
        }
        
        if (tool.parameters.includeContacts === 'true') {
          console.log(`2. Contact Query: SELECT Id, Name, Email, Phone, Title FROM Contact WHERE AccountId IN (account_ids_from_sosl)`);
        }
        
        if (tool.parameters.healthFilter) {
          console.log(`3. Health Analysis: SELECT AccountId, Account.Name, COUNT(Id) as CaseCount FROM Case WHERE Priority = 'High' AND AccountId IN (account_ids) GROUP BY AccountId, Account.Name`);
        }
      }
      
    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  }
  
  console.log('\n✅ Query Generation Test Complete!');
}

// Helper to wait for user input
async function waitForEnter() {
  process.stdout.write('Press Enter to see queries...');
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', (data) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      console.log(); // New line after key press
      resolve();
    });
  });
}

// Run the test
showQueries().catch(console.error);