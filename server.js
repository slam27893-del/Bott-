const express = require("express");

const app = express();

app.get("/", (req, res) => {
  res.send("لوحة التحكم تعمل ✅");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Dashboard running on port ${PORT}`);
});
