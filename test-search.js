const ToolService = require('./src/services/toolService');

async function testSearch() {
  const toolService = new ToolService();
  
  const testQueries = [
    'Get all won opportunities with the word oil in it that are > 25k',
    'Find recent support cases related to United Oil & Gas, Singapore',
    'Show me all accounts in the technology industry',
    'Get contacts with decision maker role',
    'Find opportunities in flight with amount between 50k and 200k'
  ];
  
  for (const query of testQueries) {
    console.log(`\n🔍 Testing Query: "${query}"`);
    console.log('='.repeat(60));
    
    try {
      // Step 1: AI Tool Selection
      console.log('📊 Step 1: AI Tool Selection');
      const toolSelection = await toolService.analyzeRequestAndSelectTools(query);
      console.log('Selected Tools:', toolSelection.selectedTools?.map(t => t.name) || 'None');
      
      if (toolSelection.selectedTools && toolSelection.selectedTools.length > 0) {
        const searchTool = toolSelection.selectedTools.find(t => t.name === 'search_salesforce');
        
        if (searchTool) {
          console.log('\n📋 Search Parameters:');
          console.log(JSON.stringify(searchTool.parameters, null, 2));
          
          // Step 2: Execute Search
          console.log('\n🚀 Step 2: Executing Search');
          const searchResult = await toolService.searchSalesforce(searchTool.parameters);
          
          console.log('\n🎯 Search Results:');
          console.log('Strategy Used:', searchResult.searchStrategy);
          console.log('Success:', searchResult.success);
          
          if (searchResult.success) {
            Object.entries(searchResult.data).forEach(([type, records]) => {
              if (records.length > 0) {
                console.log(`${type}: ${records.length} records found`);
                records.slice(0, 2).forEach(record => {
                  console.log(`  - ${record.Name || record.CaseNumber || record.Subject || 'N/A'}`);
                });
              }
            });
            
            if (searchResult.deepAnalysis) {
              console.log('\n🧠 Deep Analysis:');
              console.log(searchResult.deepAnalysis);
            }
          } else {
            console.log('❌ Search failed:', searchResult.error);
          }
        }
      }
      
    } catch (error) {
      console.error('❌ Error:', error.message);
    }
    
    console.log('\n' + '='.repeat(60));
  }
}

// Run the test
testSearch().catch(console.error);
