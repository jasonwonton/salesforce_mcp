const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Hello Railway! App is working!');
});

app.listen(port, () => {
  console.log(`Test app running on port ${port}`);
});