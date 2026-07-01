const express = require("express");
const db = require("./db");

const app = express();

app.get("/", (req, res) => {
  const guilds = db.prepare("SELECT * FROM guild_settings").all();

  res.send(`
    <h1>🎉 لوحة التحكم</h1>
    <p>عدد السيرفرات المسجلة: ${guilds.length}</p>
  `);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Dashboard running on port ${PORT}`);
});
