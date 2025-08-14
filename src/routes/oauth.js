const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const Team = require('../models/Team');

const router = express.Router();

// PKCE helper functions
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(codeVerifier) {
  return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
}

// Store code verifiers temporarily (in production, use Redis or database)
const codeVerifiers = new Map();

// Slack OAuth installation flow
router.get('/slack/install', (req, res) => {
  const scopes = 'commands,chat:write,users:read';
  const slackAuthUrl = `https://slack.com/oauth/v2/authorize?client_id=${process.env.SLACK_CLIENT_ID}&scope=${scopes}&redirect_uri=${process.env.APP_URL}/oauth/slack/callback`;
  res.redirect(slackAuthUrl);
});

router.get('/slack/callback', async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    return res.status(400).send('Authorization code not provided');
  }

  try {
    // Exchange code for access token
    const response = await axios.post('https://slack.com/api/oauth.v2.access', {
      client_id: process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      code: code,
      redirect_uri: `${process.env.APP_URL}/oauth/slack/callback`
    });

    const { access_token, team, authed_user, bot_user_id } = response.data;

    if (!response.data.ok) {
      throw new Error(response.data.error);
    }

    // Store team data in database
    await Team.create({
      id: team.id,
      name: team.name,
      slack_access_token: access_token,
      slack_bot_token: response.data.access_token,
      slack_user_id: authed_user.id
    });

    // Redirect to setup Salesforce connection
    res.redirect(`/setup/salesforce?team_id=${team.id}`);
    
  } catch (error) {
    console.error('Slack OAuth error:', error);
    res.status(500).send('Installation failed');
  }
});

// Salesforce OAuth flow
router.get('/salesforce/connect/:teamId', (req, res) => {
  const { teamId } = req.params;
  
  if (teamId === 'unknown') {
    res.send(`
      <html>
        <head><title>Database Connection Required</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>🔧 Setup Required</h1>
          <p>To connect Salesforce, we need to set up the database first.</p>
          <p>Your Jira search is working great! Salesforce connection will be available once the database is configured.</p>
          <a href="/" style="background: #4A154B; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">
            Back to Home
          </a>
        </body>
      </html>
    `);
    return;
  }
  
  const redirectUri = `${process.env.APP_URL}/oauth/salesforce/callback`;
  
  // Generate PKCE parameters
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  
  // Store code verifier for later use
  codeVerifiers.set(teamId, codeVerifier);
  
  // Build auth URL with PKCE
  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SALESFORCE_CLIENT_ID,
    redirect_uri: redirectUri,
    state: teamId,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });
  
  const salesforceAuthUrl = `https://login.salesforce.com/services/oauth2/authorize?${authParams}`;
  
  console.log(`Salesforce Auth URL: ${salesforceAuthUrl}`);
  console.log(`Redirect URI: ${redirectUri}`);
  console.log(`Code Challenge: ${codeChallenge}`);
  
  res.redirect(salesforceAuthUrl);
});

router.get('/salesforce/callback', async (req, res) => {
  const { code, state: teamId, error } = req.query;
  
  // Handle OAuth errors
  if (error) {
    console.error('Salesforce OAuth error:', error, req.query.error_description);
    res.status(400).send(`Salesforce authorization failed: ${req.query.error_description || error}`);
    return;
  }
  
  if (!code || !teamId) {
    res.status(400).send('Missing authorization code or team ID');
    return;
  }
  
  try {
    // Get the stored code verifier
    const codeVerifier = codeVerifiers.get(teamId);
    if (!codeVerifier) {
      throw new Error('Code verifier not found - session may have expired');
    }
    
    // Clean up the stored code verifier
    codeVerifiers.delete(teamId);
    
    // Exchange code for Salesforce tokens with PKCE
    const tokenData = {
      grant_type: 'authorization_code',
      client_id: process.env.SALESFORCE_CLIENT_ID,
      redirect_uri: `${process.env.APP_URL}/oauth/salesforce/callback`,
      code: code,
      code_verifier: codeVerifier
    };
    
    console.log('Token exchange data:', { ...tokenData, code_verifier: '[REDACTED]' });
    
    const response = await axios.post('https://login.salesforce.com/services/oauth2/token', 
      new URLSearchParams(tokenData),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        }
      }
    );

    const { access_token, refresh_token, instance_url } = response.data;

    // Update team with Salesforce credentials
    await Team.updateSalesforceCredentials(teamId, {
      access_token,
      refresh_token,
      instance_url,
      client_id: 'YOUR_SF_CLIENT_ID',
      client_secret: 'YOUR_SF_CLIENT_SECRET'
    });

    res.send('Setup complete! You can now use /support in Slack.');
    
  } catch (error) {
    console.error('Salesforce OAuth error:', error);
    res.status(500).send('Salesforce connection failed');
  }
});

module.exports = router;