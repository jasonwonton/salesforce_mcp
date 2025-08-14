# Salesforce MCP Server

An intelligent Model Context Protocol (MCP) server that provides smart Salesforce data access with natural language query processing.

## Features

### 🧠 Smart Query Generation
- Converts natural language requests into optimized SOQL/SOSL queries
- Context-aware time filtering (today, this week, etc.)
- Intelligent field selection based on request type

### 🔍 Core Search Tools
- **salesforce_sosl_search**: Full-text search across multiple Salesforce objects
- **salesforce_soql_query**: Execute custom SOQL queries
- **salesforce_query_builder**: AI-powered query generation from natural language

### 📊 Record Detail Tools
- **salesforce_get_case**: Detailed case information with related records
- **salesforce_get_account**: Account details with contacts and opportunities
- **salesforce_get_opportunity**: Opportunity details with history

### 🎯 Contextual Search Tools
- **salesforce_recent_cases**: Time-aware case searches with filtering
- **salesforce_red_accounts**: Health-based account risk analysis
- **salesforce_competitor_analysis**: Competitor mention detection in deals

## Setup

1. **Environment Configuration**
   ```bash
   cp .env.example .env
   # Edit .env with your Salesforce credentials
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Configure MCP Client**
   Update your MCP client configuration (e.g., Claude Desktop) to include:
   ```json
   {
     "mcpServers": {
       "salesforce": {
         "command": "node",
         "args": ["path/to/mcp-server.js"],
         "env": {
           "SALESFORCE_INSTANCE_URL": "https://your-instance.salesforce.com",
           "SALESFORCE_ACCESS_TOKEN": "your_access_token_here"
         }
       }
     }
   }
   ```

4. **Run the MCP Server**
   ```bash
   npm run mcp-server
   ```

## Authentication

The server supports multiple authentication methods:

### Access Token (Recommended)
```env
SALESFORCE_INSTANCE_URL=https://your-instance.salesforce.com
SALESFORCE_ACCESS_TOKEN=your_session_id_or_oauth_token
```

### OAuth Flow (Future Enhancement)
```env
SALESFORCE_CLIENT_ID=your_connected_app_client_id
SALESFORCE_CLIENT_SECRET=your_connected_app_secret
```

## Example Usage

### Natural Language Queries
- "What support cases were opened today related to billing?"
- "Show me red accounts for our main product"
- "Find deals where Microsoft was a competitor this quarter"

### Direct SOQL Queries
```json
{
  "tool": "salesforce_soql_query",
  "query": "SELECT Id, Name, Amount FROM Opportunity WHERE CloseDate = THIS_MONTH AND IsWon = true"
}
```

### Smart Search
```json
{
  "tool": "salesforce_query_builder",
  "request": "urgent billing cases from enterprise customers this week"
}
```

## Query Intelligence

The MCP server automatically:
- Detects time references and converts to proper date filters
- Identifies object types and selects relevant fields
- Applies contextual filtering based on keywords
- Optimizes queries for performance

### Time Detection
- "today" → `CreatedDate = TODAY`
- "this week" → `CreatedDate = THIS_WEEK`
- "last month" → `CreatedDate = LAST_MONTH`

### Context Detection
- "billing" → Subject/Description filters
- "urgent/high" → Priority filters
- "red accounts" → Health score filters
- "won/lost deals" → Opportunity stage filters

## Advanced Features

### Progressive Data Retrieval
1. Start with summary queries
2. Use detail tools for specific records
3. Follow relationships between objects

### Multi-Object Search
Search across Accounts, Contacts, Cases, and Opportunities simultaneously with relevance scoring.

### Error Handling
- Automatic query validation
- Fallback mechanisms for failed searches
- Detailed error messages for debugging

## Security

- Environment-based credential management
- No credential logging or storage
- Secure API communication with Salesforce

## Development

### Testing
```bash
# Test SOSL search
echo '{"tool":"salesforce_sosl_search","searchTerm":"billing"}' | npm run mcp-server

# Test query builder
echo '{"tool":"salesforce_query_builder","request":"cases opened today"}' | npm run mcp-server
```

### Custom Fields
Modify the field selections in `mcp-server.js` to match your Salesforce org's custom fields:

```javascript
// Add custom fields to queries
Case(Id, CaseNumber, Subject, Your_Custom_Field__c)
Account(Id, Name, Health_Score__c, Custom_Industry__c)
```

## Troubleshooting

### Common Issues

1. **Authentication Errors**
   - Verify SALESFORCE_ACCESS_TOKEN is valid
   - Check SALESFORCE_INSTANCE_URL format
   - Ensure API user has proper permissions

2. **Query Failures**
   - Review field names match your Salesforce org
   - Check for custom field API names
   - Validate SOQL syntax for complex queries

3. **No Results**
   - Verify data exists for time ranges
   - Check field permissions for API user
   - Review filtering logic for edge cases

### Debug Mode
Set `DEBUG=true` in environment for detailed query logging.

## Integration Examples

### Claude Desktop
```json
{
  "salesforce": {
    "command": "node",
    "args": ["/path/to/mcp-server.js"]
  }
}
```

### Continue.dev
```json
{
  "mcp": {
    "salesforce": "./mcp-server.js"
  }
}
```

## Roadmap

- [ ] Real-time data updates
- [ ] Bulk data operations
- [ ] Advanced analytics queries
- [ ] Custom dashboards integration
- [ ] Slack/Teams notification hooks