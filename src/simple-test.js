const express = require('express');
const app = express();
const port = parseInt(process.env.PORT) || 3000;

console.log('Environment PORT:', process.env.PORT);
console.log('Using port:', port);

app.get('/', (req, res) => {
  res.send('Hello Railway! App is working!');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', port: port, env: process.env.PORT });
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Test app running on port ${port} and listening on all interfaces`);
});

server.on('error', (err) => {
  console.error('Server error:', err);
});