require('dotenv').config();
const ToolService = require('./src/services/toolService');
const Team = require('./src/models/Team');
const QueryTestSuite = require('./test-queries');

// Executable Test Runner
class TestRunner {
  constructor() {
    this.testSuite = new QueryTestSuite();
  }

  async runAllTests() {
    console.log('🚀 SALESFORCE QUERY TEST SUITE');
    console.log('================================\n');

    try {
      // Try to get a real team for testing
      let team = null;
      
      if (process.env.TEST_TEAM_ID) {
        try {
          team = await Team.findById(process.env.TEST_TEAM_ID);
          console.log('✅ Connected to test team:', team?.id || 'Not found');
        } catch (error) {
          console.log('⚠️  No test team found by ID, trying to find any team with Salesforce...');
        }
      }
      
      // If no TEST_TEAM_ID or team not found, try to find any team with Salesforce connection
      if (!team) {
        try {
          const db = require('./database');
          const teams = await db('teams').where('salesforce_access_token', '!=', null).limit(1);
          
          if (teams.length > 0) {
            const teamData = teams[0];
            team = {
              id: teamData.id,
              salesforce_access_token: teamData.salesforce_access_token,
              salesforce_instance_url: teamData.salesforce_instance_url,
              salesforce_refresh_token: teamData.salesforce_refresh_token
            };
            console.log('✅ Found team with Salesforce connection:', team.id);
          } else {
            console.log('⚠️  No teams with Salesforce connection found');
          }
        } catch (error) {
          console.log('⚠️  Database error, will run tool selection tests only:', error.message);
        }
      }

      const toolService = new ToolService(team);

      // Run AI tool selection tests
      await this.testAIToolSelection(toolService);

      // Run actual query execution if we have a team
      if (team && team.salesforce_access_token) {
        console.log('\n🎯 RUNNING REAL QUERY EXECUTION TESTS');
        console.log('=====================================\n');
        await this.testQueryExecution(toolService);
      } else {
        console.log('\n📝 To run actual query execution tests:');
        console.log('1. Connect Salesforce in your Slack app first');
        console.log('2. Or set TEST_TEAM_ID in your .env file\n');
      }

      // Show query documentation
      this.showQueryDocumentation();

    } catch (error) {
      console.error('❌ Test runner failed:', error.message);
    }
  }

  async testAIToolSelection(toolService) {
    console.log('🧠 AI TOOL SELECTION TESTS');
    console.log('===========================\n');

    for (const [index, test] of this.testSuite.tests.entries()) {
      console.log(`\n📋 Test ${index + 1}: ${test.name}`);
      console.log(`🔤 Query: "${test.query}"`);
      console.log('─'.repeat(60));
      
      // Wait for user input
      await this.waitForEnter();

      try {
        const startTime = Date.now();
        const result = await toolService.analyzeRequestAndSelectTools(test.query);
        const duration = Date.now() - startTime;

        const selectedTool = result.selectedTools[0];
        const isCorrectTool = selectedTool?.toolName === test.expectedTool;

        console.log(`⚡ Duration: ${duration}ms`);
        console.log(`🎯 Selected Tool: ${selectedTool?.toolName || 'None'} ${isCorrectTool ? '✅' : '❌'}`);
        
        if (!isCorrectTool) {
          console.log(`   Expected: ${test.expectedTool}`);
        }

        console.log(`🧠 AI Reasoning: ${result.reasoning}`);
        console.log(`🔧 Parameters:`);
        console.log(JSON.stringify(selectedTool?.parameters || {}, null, 4));

        // Show expected vs actual
        console.log(`📊 Expected Tool: ${test.expectedTool}`);
        console.log(`📊 Expected Params:`, JSON.stringify(test.expectedParams, null, 4));

      } catch (error) {
        console.log(`❌ Tool selection failed: ${error.message}`);
      }
    }
  }

  async testQueryExecution(toolService) {
    console.log('\n\n🎯 QUERY EXECUTION TESTS');
    console.log('=========================\n');

    // Test a subset to avoid rate limits
    const testsToRun = this.testSuite.tests.slice(0, 5);

    for (const [index, test] of testsToRun.entries()) {
      console.log(`\n🔍 Execution Test ${index + 1}: ${test.name}`);
      console.log(`🔤 Query: "${test.query}"`);
      console.log('─'.repeat(60));
      
      // Wait for user input
      await this.waitForEnter();

      try {
        // Get AI tool selection
        const aiResult = await toolService.analyzeRequestAndSelectTools(test.query);
        const selectedTool = aiResult.selectedTools[0];

        if (!selectedTool) {
          console.log('❌ No tool selected');
          continue;
        }

        console.log(`🎯 Executing: ${selectedTool.toolName}`);
        console.log(`📝 Parameters:`, JSON.stringify(selectedTool.parameters, null, 2));

        // Execute the tool
        const startTime = Date.now();
        const executionResult = await toolService.executeTool(selectedTool.toolName, selectedTool.parameters);
        const duration = Date.now() - startTime;

        console.log(`⚡ Execution Duration: ${duration}ms`);
        console.log(`📊 Success: ${executionResult.success ? '✅' : '❌'}`);

        if (executionResult.success) {
          console.log(`📈 Records Found: ${executionResult.count || 0}`);
          
          // Show executed queries
          if (executionResult.executedQueries) {
            console.log(`\n📝 Executed Queries:`);
            executionResult.executedQueries.forEach((query, index) => {
              console.log(`${index + 1}. ${query}`);
            });
          }

          // Show search strategy
          if (executionResult.searchStrategy) {
            console.log(`🎯 Search Strategy: ${executionResult.searchStrategy}`);
          }

          // Show generated queries
          if (executionResult.query) {
            console.log(`📝 Generated Query:`);
            console.log(executionResult.query);
          }

          // Show data structure
          if (executionResult.data) {
            if (Array.isArray(executionResult.data)) {
              console.log(`🗂️  Data: Array with ${executionResult.data.length} items`);
              if (executionResult.data.length > 0) {
                console.log(`📋 Sample Record:`, JSON.stringify(executionResult.data[0], null, 2));
              }
            } else {
              console.log(`🗂️  Data Structure:`, Object.keys(executionResult.data));
              
              // Show breakdown if available
              if (executionResult.breakdown) {
                console.log(`📊 Breakdown:`, executionResult.breakdown);
              }

              // Show sample data
              if (executionResult.data.cases && executionResult.data.cases.length > 0) {
                console.log(`📋 Sample Case:`, JSON.stringify(executionResult.data.cases[0], null, 2));
              }
              if (executionResult.data.accounts && executionResult.data.accounts.length > 0) {
                console.log(`🏢 Sample Account:`, JSON.stringify(executionResult.data.accounts[0], null, 2));
              }
            }
          }

          // Show AI analysis if available
          if (executionResult.data?.deepAnalysis) {
            console.log(`🧠 AI Analysis: ${executionResult.data.deepAnalysis.substring(0, 200)}...`);
          }

          // Check expectations
          if (test.shouldFindRecords && executionResult.count === 0) {
            console.log(`⚠️  Expected to find records but got 0 results`);
          } else if (executionResult.count > 0) {
            console.log(`✅ Found records as expected`);
          }

        } else {
          console.log(`❌ Execution Error: ${executionResult.error}`);
        }

      } catch (error) {
        console.log(`❌ Test execution failed: ${error.message}`);
        console.log(error.stack);
      }
    }
  }

  showQueryDocumentation() {
    console.log('\n\n📚 QUERY DOCUMENTATION');
    console.log('=======================\n');

    this.testSuite.generateQueryDocumentation();

    console.log('\n🎯 EXAMPLE SOQL/SOSL QUERIES TO TEST IN SALESFORCE:\n');

    console.log('1. SOSL Discovery Query:');
    console.log('   FIND {motor} RETURNING Opportunity(Id, Name, StageName, Amount, Account.Name)');
    
    console.log('\n2. SOQL Filtering Query:');
    console.log('   SELECT Id, Name, StageName, Amount, Account.Name FROM Opportunity WHERE Amount >= 25000');
    
    console.log('\n3. Combined SOSL + SOQL:');
    console.log('   Step 1: FIND {motor} RETURNING Opportunity(Id)');
    console.log('   Step 2: SELECT Id, Name, Amount FROM Opportunity WHERE Id IN (results_from_step_1) AND Amount >= 25000');
    
    console.log('\n4. Account Health Query:');
    console.log('   SELECT AccountId, Account.Name, COUNT(Id) as CaseCount FROM Case WHERE Priority = \'High\' GROUP BY AccountId, Account.Name');
    
    console.log('\n5. Contact Lookup:');
    console.log('   SELECT Id, Name, Email, Phone, Title FROM Contact WHERE AccountId IN (\'account_ids_from_sosl\')');

    console.log('\n📝 TEST THESE DIRECTLY IN SALESFORCE TO VERIFY DATA EXISTS!\n');
  }

  // Helper method to wait for user input
  async waitForEnter() {
    process.stdout.write('Press Enter to continue...');
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
}

// Run if called directly
if (require.main === module) {
  const runner = new TestRunner();
  runner.runAllTests().catch(console.error);
}

module.exports = TestRunner;