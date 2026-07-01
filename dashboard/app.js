const express = require("express");

const app = express();

app.get("/", (req, res) => {
  res.send("<h1>🚀 Boredom Dashboard</h1><p>Dashboard is running successfully!</p>");
});

module.exports = app;
