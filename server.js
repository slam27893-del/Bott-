٨const express = require("express");
const path = require("path");
const db = require("./db");

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.get("/", (req, res) => {
  const guilds = db.prepare("SELECT * FROM guild_settings").all();

  let html = `
    <h1>🎉 لوحة تحكم Boredom Bot</h1>
    <p>عدد السيرفرات: ${guilds.length}</p>
    <hr>
    <h2>السيرفرات</h2>
    <ul>
  `;

  guilds.forEach(guild => {
    html += `<li>🖥️ ${guild.guild_id}</li>`;
  });

  html += `
    </ul>
  `;

  res.send(html);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Dashboard running on port ${PORT}`);
});
