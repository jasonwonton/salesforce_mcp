const express = require('express');
const axios = require('axios');
const Team = require('../models/Team');

const router = express.Router();

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
  const salesforceAuthUrl = `https://login.salesforce.com/services/oauth2/authorize?response_type=code&client_id=YOUR_SF_CLIENT_ID&redirect_uri=${process.env.APP_URL}/oauth/salesforce/callback&state=${teamId}`;
  res.redirect(salesforceAuthUrl);
});

router.get('/salesforce/callback', async (req, res) => {
  const { code, state: teamId } = req.query;
  
  try {
    // Exchange code for Salesforce tokens
    const response = await axios.post('https://login.salesforce.com/services/oauth2/token', {
      grant_type: 'authorization_code',
      client_id: 'YOUR_SF_CLIENT_ID',
      client_secret: 'YOUR_SF_CLIENT_SECRET',
      redirect_uri: `${process.env.APP_URL}/oauth/salesforce/callback`,
      code: code
    });

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