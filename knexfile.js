require('dotenv').config();

module.exports = {
  development: {
    client: 'postgresql',
    connection: process.env.DATABASE_URL || {
      host: 'localhost',
      database: 'salesforce_slack_saas',
      user: 'postgres',
      password: 'password'
    },
    migrations: {
      directory: './migrations'
    }
  },
  production: {
    client: 'postgresql',
    connection: process.env.DATABASE_URL,
    migrations: {
      directory: './migrations'
    }
  }
};