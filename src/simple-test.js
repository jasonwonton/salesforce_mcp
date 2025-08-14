const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Hello Railway! App is working!');
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Test app running on port ${port}`);
});