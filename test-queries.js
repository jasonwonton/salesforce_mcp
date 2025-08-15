const ToolService = require('./src/services/toolService');

// Test Suite for Salesforce Query Requirements
class QueryTestSuite {
  constructor() {
    this.tests = [];
    this.setupTests();
  }

  setupTests() {
    // Test cases based on your requirements
    this.tests = [
      {
        name: "Recent support cases - United Oil & Gas, Singapore",
        query: "Get recent support cases related to United Oil & Gas, Singapore",
        expectedTool: "sosl_discovery_search",
        expectedParams: {
          keywords: ["United", "Oil", "Gas", "Singapore"],
          timeFilter: "last_30_days",
          deepAnalysis: "true"
        },
        expectedSOSL: "FIND {United} RETURNING Account(...), Case(...)",
        shouldFindRecords: true
      },
      
      {
        name: "All support cases - United Oil & Gas, Singapore", 
        query: "Get all support cases with United Oil & Gas, Singapore",
        expectedTool: "sosl_discovery_search",
        expectedParams: {
          keywords: ["United", "Oil", "Gas", "Singapore"],
          timeFilter: "all_time",
          deepAnalysis: "true"
        },
        expectedSOSL: "FIND {United} RETURNING Account(...), Case(...)",
        shouldFindRecords: true
      },

      {
        name: "Opportunities > 25k with motor keyword",
        query: "Get all opportunities with the word motor in it that are > 25k",
        expectedTool: "advanced_opportunity_search", 
        expectedParams: {
          keywords: ["motor"],
          minAmount: 25000,
          searchMethod: "sosl_then_filter"
        },
        expectedSOSL: "FIND {motor} RETURNING Opportunity(...)",
        expectedSOQL: "SELECT ... FROM Opportunity WHERE Id IN (...) AND Amount >= 25000",
        shouldFindRecords: true
      },

      {
        name: "Opportunities with motor AND rotor > 25k",
        query: "Get all opportunities with the words motor and rotor in it that are > 25k",
        expectedTool: "advanced_opportunity_search",
        expectedParams: {
          keywords: ["motor", "rotor"],
          minAmount: 25000,
          searchMethod: "sosl_then_filter"
        },
        expectedSOSL: ["FIND {motor} RETURNING Opportunity(...)", "FIND {rotor} RETURNING Opportunity(...)"],
        expectedSOQL: "SELECT ... FROM Opportunity WHERE Id IN (...) AND Amount >= 25000",
        shouldFindRecords: true
      },

      {
        name: "Closed opportunities with keyword",
        query: "Get all closed opportunities with keyword motor",
        expectedTool: "advanced_opportunity_search",
        expectedParams: {
          keywords: ["motor"],
          stage: "Closed",
          searchMethod: "sosl_then_filter"
        },
        expectedSOSL: "FIND {motor} RETURNING Opportunity(...)",
        expectedSOQL: "SELECT ... FROM Opportunity WHERE Id IN (...) AND IsClosed = true",
        shouldFindRecords: true
      },

      {
        name: "Won opportunities with keyword",
        query: "Get all won opportunities with keyword oil",
        expectedTool: "advanced_opportunity_search",
        expectedParams: {
          keywords: ["oil"],
          stage: "Won",
          searchMethod: "sosl_then_filter"
        },
        expectedSOSL: "FIND {oil} RETURNING Opportunity(...)",
        expectedSOQL: "SELECT ... FROM Opportunity WHERE Id IN (...) AND IsWon = true",
        shouldFindRecords: true
      },

      {
        name: "All opportunities with motor keyword",
        query: "Get all opportunities with the words motor in it",
        expectedTool: "advanced_opportunity_search",
        expectedParams: {
          keywords: ["motor"],
          searchMethod: "sosl_then_filter"
        },
        expectedSOSL: "FIND {motor} RETURNING Opportunity(...)",
        shouldFindRecords: true
      },

      {
        name: "All opportunities > 25k",
        query: "Get all opportunities that are > 25k", 
        expectedTool: "advanced_opportunity_search",
        expectedParams: {
          minAmount: 25000,
          searchMethod: "soql_only"
        },
        expectedSOQL: "SELECT ... FROM Opportunity WHERE Amount >= 25000",
        shouldFindRecords: true
      },

      {
        name: "Current in-flight opportunities (last 30 days)",
        query: "Get all current in flight opportunities (last 30 days)",
        expectedTool: "advanced_opportunity_search",
        expectedParams: {
          stage: "Open",
          timeframe: "last_30_days",
          searchMethod: "soql_only"
        },
        expectedSOQL: "SELECT ... FROM Opportunity WHERE IsClosed = false AND CreatedDate = LAST_N_DAYS:30",
        shouldFindRecords: true
      },

      {
        name: "Lost opportunities with motor keyword",
        query: "Get all lost opportunities with the word motor in it",
        expectedTool: "advanced_opportunity_search",
        expectedParams: {
          keywords: ["motor"],
          stage: "Lost",
          searchMethod: "sosl_then_filter"
        },
        expectedSOSL: "FIND {motor} RETURNING Opportunity(...)",
        expectedSOQL: "SELECT ... FROM Opportunity WHERE Id IN (...) AND IsWon = false AND IsClosed = true",
        shouldFindRecords: true
      },

      {
        name: "Won opportunities with oil > 25k",
        query: "Get all won opportunities with the word oil in it that are > 25k",
        expectedTool: "advanced_opportunity_search",
        expectedParams: {
          keywords: ["oil"],
          stage: "Won", 
          minAmount: 25000,
          searchMethod: "sosl_then_filter"
        },
        expectedSOSL: "FIND {oil} RETURNING Opportunity(...)",
        expectedSOQL: "SELECT ... FROM Opportunity WHERE Id IN (...) AND IsWon = true AND Amount >= 25000",
        shouldFindRecords: true
      },

      {
        name: "Red accounts with motor keyword",
        query: "Get all red accounts with the word motor in it",
        expectedTool: "advanced_account_search",
        expectedParams: {
          keywords: ["motor"],
          healthFilter: "red",
          analysisDepth: "full"
        },
        expectedSOSL: "FIND {motor} RETURNING Account(...)",
        expectedSOQL: "SELECT ... FROM Account WHERE Id IN (...) + health analysis query",
        shouldFindRecords: true
      },

      {
        name: "Contacts for United Oil & Gas, Singapore",
        query: "Get all internal contacts and account representatives for United Oil & Gas, Singapore",
        expectedTool: "advanced_account_search",
        expectedParams: {
          keywords: ["United", "Oil", "Gas", "Singapore"],
          includeContacts: "true",
          analysisDepth: "basic"
        },
        expectedSOSL: "FIND {United} RETURNING Account(...)",
        expectedSOQL: "SELECT ... FROM Contact WHERE AccountId IN (...)",
        shouldFindRecords: true
      },

      {
        name: "Full research rundown - United Oil & Gas",
        query: "Get me a full research rundown of United Oil & Gas, Singapore",
        expectedTool: "advanced_account_search",
        expectedParams: {
          keywords: ["United", "Oil", "Gas", "Singapore"],
          includeContacts: "true",
          analysisDepth: "full"
        },
        expectedSOSL: "FIND {United} RETURNING Account(...)",
        expectedSOQL: ["Account query", "Contact query", "Case health query"],
        shouldFindRecords: true
      }
    ];
  }

  // Method to test AI tool selection
  async testAIToolSelection(toolService) {
    console.log('\n🧪 TESTING AI TOOL SELECTION\n');
    
    for (const test of this.tests) {
      console.log(`\n📋 Test: ${test.name}`);
      console.log(`Query: "${test.query}"`);
      
      try {
        const result = await toolService.analyzeRequestAndSelectTools(test.query);
        
        // Check if correct tool was selected
        const selectedTool = result.selectedTools[0];
        const isCorrectTool = selectedTool.toolName === test.expectedTool;
        
        console.log(`✅ Selected Tool: ${selectedTool.toolName} ${isCorrectTool ? '✓' : '✗'}`);
        console.log(`📝 AI Reasoning: ${result.reasoning}`);
        console.log(`🔧 Parameters:`, JSON.stringify(selectedTool.parameters, null, 2));
        
        if (!isCorrectTool) {
          console.log(`❌ Expected: ${test.expectedTool}, Got: ${selectedTool.toolName}`);
        }
        
      } catch (error) {
        console.log(`❌ Tool selection failed: ${error.message}`);
      }
    }
  }

  // Method to test actual query execution (requires real Salesforce connection)
  async testQueryExecution(toolService) {
    console.log('\n🎯 TESTING QUERY EXECUTION\n');
    
    for (const test of this.tests.slice(0, 3)) { // Test first 3 to avoid rate limits
      console.log(`\n📋 Test: ${test.name}`);
      
      try {
        // First get the AI tool selection
        const aiResult = await toolService.analyzeRequestAndSelectTools(test.query);
        const selectedTool = aiResult.selectedTools[0];
        
        // Execute the tool
        const executionResult = await toolService.executeTool(selectedTool.toolName, selectedTool.parameters);
        
        console.log(`🔍 Tool: ${selectedTool.toolName}`);
        console.log(`📊 Results: ${executionResult.success ? `Found ${executionResult.count} records` : 'Failed'}`);
        
        if (executionResult.success) {
          console.log(`🗂️ Data Structure:`, Object.keys(executionResult.data || {}));
          
          if (executionResult.query) {
            console.log(`📝 Generated Query:`, executionResult.query);
          }
          
          if (executionResult.searchStrategy) {
            console.log(`🎯 Search Strategy:`, executionResult.searchStrategy);
          }
          
          // Check if we found records when expected
          if (test.shouldFindRecords && executionResult.count === 0) {
            console.log(`⚠️  Expected to find records but got 0 results`);
          }
        } else {
          console.log(`❌ Execution failed: ${executionResult.error}`);
        }
        
      } catch (error) {
        console.log(`❌ Test failed: ${error.message}`);
      }
    }
  }

  // Method to generate expected queries for documentation
  generateQueryDocumentation() {
    console.log('\n📚 EXPECTED QUERY DOCUMENTATION\n');
    
    this.tests.forEach((test, index) => {
      console.log(`${index + 1}. ${test.name}`);
      console.log(`   Query: "${test.query}"`);
      console.log(`   Tool: ${test.expectedTool}`);
      
      if (test.expectedSOSL) {
        if (Array.isArray(test.expectedSOSL)) {
          test.expectedSOSL.forEach((sosl, i) => {
            console.log(`   SOSL ${i + 1}: ${sosl}`);
          });
        } else {
          console.log(`   SOSL: ${test.expectedSOSL}`);
        }
      }
      
      if (test.expectedSOQL) {
        if (Array.isArray(test.expectedSOQL)) {
          test.expectedSOQL.forEach((soql, i) => {
            console.log(`   SOQL ${i + 1}: ${soql}`);
          });
        } else {
          console.log(`   SOQL: ${test.expectedSOQL}`);
        }
      }
      
      console.log(`   Expected Records: ${test.shouldFindRecords ? 'Yes' : 'No'}`);
      console.log('');
    });
  }
}

// Export for use
module.exports = QueryTestSuite;

// Run tests if called directly
if (require.main === module) {
  const testSuite = new QueryTestSuite();
  
  // Generate documentation
  testSuite.generateQueryDocumentation();
  
  // If you want to test with a real ToolService:
  // const toolService = new ToolService(null); // You'd need a real team object
  // testSuite.testAIToolSelection(toolService);
}