"use strict";

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionOverwrites,
  Events,
} = require("discord.js");
const path = require("path");
const db = require("./db");
const { norm, xpFor } = require("./utils");

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("[BOT] ❌ DISCORD_TOKEN غير موجود");
  process.exit(1);
}

const URL_RE = /https?:\/\/\S+|discord\.gg\/\S+|(?<!\w)www\.\S+\.\w{2,}/i;
const XP_MIN = 15,
  XP_MAX = 25,
  XP_COOLDOWN = 60_000;
const SPAM_ACTION_COOLDOWN = 30_000;

const cooldowns = new Map(); // `${guildId}:${userId}` → timestamp
const spamTracker = new Map(); // key → number[]
const spamActioned = new Map(); // key → timestamp

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Channel],
});

// ═══════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════

async function getPrefix(guildId) {
  const row = db
    .prepare("SELECT prefix FROM guild_settings WHERE guild_id=?")
    .get(BigInt(guildId));
  return row ? row.prefix : "!";
}

async function sendLog(guildId, embed) {
  try {
    const s = db
      .prepare("SELECT log_channel FROM guild_settings WHERE guild_id=?")
      .get(BigInt(guildId));
    if (!s?.log_channel) return;
    const guild = client.guilds.cache.get(String(guildId));
    if (!guild) return;
    const ch = guild.channels.cache.get(String(s.log_channel));
    if (!ch) return;
    embed.setTimestamp().setFooter({ text: "نظام اللوق" });
    await ch.send({ embeds: [embed] });
  } catch {
    /* silent */
  }
}

function getSettings(guildId) {
  return (
    db
      .prepare("SELECT * FROM guild_settings WHERE guild_id=?")
      .get(BigInt(guildId)) || {}
  );
}

function addWarn(guildId, userId, modId, reason) {
  db.prepare(
    "INSERT INTO warn_logs (guild_id,user_id,moderator_id,reason) VALUES (?,?,?,?)",
  ).run(BigInt(guildId), BigInt(userId), BigInt(modId), reason);
  return db
    .prepare(
      "SELECT COUNT(*) as c FROM warn_logs WHERE guild_id=? AND user_id=?",
    )
    .get(BigInt(guildId), BigInt(userId)).c;
}

function getLevelRoles(guildId) {
  return db
    .prepare("SELECT level, role_id FROM level_roles WHERE guild_id=?")
    .all(BigInt(guildId));
}

async function assignLevelRoles(member, newLevel, levelRoles) {
  if (!levelRoles.length) return;
  const earned = levelRoles.filter((r) => Number(r.level) <= newLevel);
  if (!earned.length) return;
  const highest = earned.reduce((a, b) =>
    Number(a.level) > Number(b.level) ? a : b,
  );
  for (const lr of levelRoles) {
    const role = member.guild.roles.cache.get(String(lr.role_id));
    if (!role) continue;
    if (Number(lr.level) === Number(highest.level)) {
      if (!member.roles.cache.has(role.id))
        await member.roles
          .add(role, `Reached Level ${newLevel}`)
          .catch(() => {});
    } else {
      if (member.roles.cache.has(role.id))
        await member.roles.remove(role, "Level role update").catch(() => {});
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  AUTO-RESPONSE
// ═══════════════════════════════════════════════════════════

async function runAutoResponses(message) {
  const rows = db
    .prepare(
      "SELECT trigger, response, match_type FROM auto_responses WHERE guild_id=?",
    )
    .all(BigInt(message.guild.id));
  if (!rows.length) return false;
  const content = norm(message.content || "");
  if (!content) return false;
  for (const row of rows) {
    const t = norm(row.trigger);
    const hit =
      (row.match_type === "exact" && content === t) ||
      (row.match_type === "contains" && content.includes(t)) ||
      (row.match_type === "starts" && content.startsWith(t));
    if (hit) {
      await message.channel.send(row.response).catch(() => {});
      return true;
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════
//  ANTI-SPAM
// ═══════════════════════════════════════════════════════════

async function runAntispam(message) {
  const s = getSettings(message.guild.id);
  if (!s.antispam_enabled) return false;
  if (message.member?.permissions.has(PermissionFlagsBits.Administrator))
    return false;

  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  const win = (s.antispam_window || 5) * 1000;
  const thrs = s.antispam_threshold || 5;

  if (!spamTracker.has(key)) spamTracker.set(key, []);
  const times = spamTracker.get(key);
  times.push(now);
  // prune old
  const cutoff = now - win;
  while (times.length && times[0] < cutoff) times.shift();

  if (times.length <= thrs) return false;
  if (now - (spamActioned.get(key) || 0) < SPAM_ACTION_COOLDOWN) return true;

  spamActioned.set(key, now);
  times.length = 0;

  const action = s.antispam_action || "warn";
  const m = message.member;

  try {
    if (action === "timeout") {
      await m.timeout(5 * 60 * 1000, "سبام تلقائي");
      await message.channel
        .send({
          embeds: [
            new EmbedBuilder()
              .setDescription(
                `⏱️ ${m} تم إسكاتك لـ **5 دقائق** بسبب الإرسال المتكرر.`,
              )
              .setColor(0xf57731),
          ],
        })
        .then((msg) => setTimeout(() => msg.delete().catch(() => {}), 12000));
    } else if (action === "kick") {
      await m.kick("سبام تلقائي");
      await message.channel
        .send({
          embeds: [
            new EmbedBuilder()
              .setDescription(`👢 ${m} تم طرده بسبب السبام.`)
              .setColor(0xed4245),
          ],
        })
        .then((msg) => setTimeout(() => msg.delete().catch(() => {}), 12000));
    } else {
      const count = addWarn(
        message.guild.id,
        message.author.id,
        client.user.id,
        "سبام تلقائي",
      );
      await message.channel
        .send({
          embeds: [
            new EmbedBuilder()
              .setDescription(
                `⚠️ ${m} تحذير تلقائي بسبب الإرسال السريع.\nإجمالي تحذيراتك: **${count}**`,
              )
              .setColor(0xfaa61a),
          ],
        })
        .then((msg) => setTimeout(() => msg.delete().catch(() => {}), 12000));
    }
  } catch {
    /* silent */
  }
  return true;
}

// ═══════════════════════════════════════════════════════════
//  WORD FILTER
// ═══════════════════════════════════════════════════════════

async function runWordFilter(message) {
  if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages))
    return false;
  const words = db
    .prepare("SELECT word FROM banned_words WHERE guild_id=?")
    .all(BigInt(message.guild.id));
  if (!words.length) return false;
  const content = norm(message.content || "");
  const matched = words.find((w) => content.includes(norm(w.word)));
  if (!matched) return false;

  await message.delete().catch(() => {});
  const s = getSettings(message.guild.id);
  const action = s.automod_action || "delete";
  const m = message.member;

  try {
    if (action === "timeout") {
      await m.timeout(5 * 60 * 1000, `كلمة ممنوعة: ${matched.word}`);
      await message.channel
        .send({
          embeds: [
            new EmbedBuilder()
              .setDescription(`🔇 ${m} تم إسكاتك **5 دقائق** بسبب كلمة ممنوعة.`)
              .setColor(0xf57731),
          ],
        })
        .then((msg) => setTimeout(() => msg.delete().catch(() => {}), 10000));
    } else if (action === "warn") {
      const count = addWarn(
        message.guild.id,
        message.author.id,
        client.user.id,
        `كلمة ممنوعة: ${matched.word}`,
      );
      await message.channel
        .send({
          embeds: [
            new EmbedBuilder()
              .setDescription(
                `⚠️ ${m} تحذير: رسالتك تحتوي كلمة ممنوعة. (إجمالي: ${count})`,
              )
              .setColor(0xfaa61a),
          ],
        })
        .then((msg) => setTimeout(() => msg.delete().catch(() => {}), 10000));
    } else {
      await message.channel
        .send({
          embeds: [
            new EmbedBuilder()
              .setDescription(
                `🗑️ ${m} تم حذف رسالتك لاحتوائها محتوى غير مسموح به.`,
              )
              .setColor(0xed4245),
          ],
        })
        .then((msg) => setTimeout(() => msg.delete().catch(() => {}), 8000));
    }
  } catch {
    /* silent */
  }
  return true;
}

// ═══════════════════════════════════════════════════════════
//  ANTI-LINKS
// ═══════════════════════════════════════════════════════════

async function runAntilink(message) {
  const s = getSettings(message.guild.id);
  if (!s.antilink_enabled) return false;
  if (message.member?.permissions.has(PermissionFlagsBits.Administrator))
    return false;
  const exempt = (s.antilink_exempt_roles || "").split(",").filter(Boolean);
  if (exempt.some((id) => message.member?.roles.cache.has(id))) return false;
  if (!message.content || !URL_RE.test(message.content)) return false;

  await message.delete().catch(() => {});
  try {
    await message.member.timeout(5 * 60 * 1000, "رابط ممنوع");
    await message.channel
      .send({
        embeds: [
          new EmbedBuilder()
            .setDescription(
              `🔗 ${message.member} ممنوع إرسال روابط. تم إسكاتك **5 دقائق**.`,
            )
            .setColor(0xf57731),
        ],
      })
      .then((msg) => setTimeout(() => msg.delete().catch(() => {}), 12000));
  } catch {
    await message.channel
      .send({
        embeds: [
          new EmbedBuilder()
            .setDescription(`🔗 ${message.member} ممنوع إرسال روابط هنا.`)
            .setColor(0xf57731),
        ],
      })
      .then((msg) => setTimeout(() => msg.delete().catch(() => {}), 12000));
  }
  return true;
}

// ═══════════════════════════════════════════════════════════
//  TICKET SYSTEM
// ═══════════════════════════════════════════════════════════

function buildCreateTicketRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("create_ticket_btn")
      .setLabel("إنشاء تكت 🎫")
      .setStyle(ButtonStyle.Primary),
  );
}
function buildCloseTicketRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("close_ticket_btn")
      .setLabel("إغلاق التكت 🔒")
      .setStyle(ButtonStyle.Danger),
  );
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  try {
    if (interaction.customId === "create_ticket_btn") {
      const guild = interaction.guild;
      const member = interaction.member;
      const safeName = `ticket-${
        member.user.username
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .slice(0, 20) || member.user.id.slice(-8)
      }`;
      const existing = guild.channels.cache.find((c) => c.name === safeName);
      if (existing)
        return interaction.reply({
          content: `لديك تكت مفتوح بالفعل: ${existing}`,
          ephemeral: true,
        });

      const s = getSettings(guild.id);
      const category = s.ticket_category
        ? guild.channels.cache.get(String(s.ticket_category))
        : null;
      const overwrites = [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: member.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
          ],
        },
      ];
      if (s.ticket_support_role) {
        overwrites.push({
          id: String(s.ticket_support_role),
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        });
      }

      const ch = await guild.channels.create({
        name: safeName,
        type: ChannelType.GuildText,
        parent: category?.id,
        permissionOverwrites: overwrites,
        reason: `Ticket for ${member.user.tag}`,
      });

      const embed = new EmbedBuilder()
        .setTitle(s.ticket_title || "🎫 الدعم الفني")
        .setDescription(
          `مرحباً ${member}!\nصف مشكلتك وسيساعدك الفريق قريباً.\n\nلإغلاق التكت اضغط الزر أدناه.`,
        )
        .setColor(0x5865f2)
        .setThumbnail(member.user.displayAvatarURL());

      await ch.send({ embeds: [embed], components: [buildCloseTicketRow()] });
      await interaction.reply({
        content: `✅ تم إنشاء تكتك: ${ch}`,
        ephemeral: true,
      });

      await sendLog(
        guild.id,
        new EmbedBuilder()
          .setTitle("🎫 تكت جديد")
          .setDescription(`${member} فتح تكتاً جديداً\n**الروم:** ${ch}`)
          .setColor(0x5865f2),
      );
    } else if (interaction.customId === "close_ticket_btn") {
      if (!interaction.channel.name.startsWith("ticket-"))
        return interaction.reply({
          content: "هذا ليس روم تكت.",
          ephemeral: true,
        });
      await interaction.reply({ content: "⏳ جاري إغلاق التكت..." });
      setTimeout(
        () => interaction.channel.delete("Ticket closed").catch(() => {}),
        3000,
      );
    }
  } catch (e) {
    console.error("[ticket error]", e.message);
    if (!interaction.replied)
      interaction
        .reply({ content: "❌ حدث خطأ.", ephemeral: true })
        .catch(() => {});
  }
});

// ═══════════════════════════════════════════════════════════
//  EVENTS
// ═══════════════════════════════════════════════════════════

client.once(Events.ClientReady, () => {
  console.log(
    `[BOT] ✅ ${client.user.tag} connected — ${client.guilds.cache.size} guild(s)`,
  );
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const prefix = await getPrefix(message.guild.id);
  const isCmd =
    message.content.startsWith(prefix) ||
    message.content.startsWith("<@" + client.user.id + ">");

  // ── Word filter ────────────────────────────────────────
  try {
    if (await runWordFilter(message)) return;
  } catch (e) {
    console.error("[word_filter]", e.message);
  }

  // ── Anti-link ─────────────────────────────────────────
  try {
    if (await runAntilink(message)) return;
  } catch (e) {
    console.error("[antilink]", e.message);
  }

  // ── Anti-spam ─────────────────────────────────────────
  try {
    if (await runAntispam(message)) {
      if (isCmd) await handleCommand(message, prefix);
      return;
    }
  } catch (e) {
    console.error("[antispam]", e.message);
  }

  // ── Auto-response ─────────────────────────────────────
  try {
    await runAutoResponses(message);
  } catch (e) {
    console.error("[auto_response]", e.message);
  }

  // ── XP / Leveling ─────────────────────────────────────
  try {
    const s = getSettings(message.guild.id);
    const key = `${message.guild.id}:${message.author.id}`;
    const now = Date.now();

    if (
      s.levels_enabled !== 0 &&
      now - (cooldowns.get(key) || 0) >= XP_COOLDOWN
    ) {
      cooldowns.set(key, now);
      const gid = BigInt(message.guild.id);
      const uid = BigInt(message.author.id);
      let row = db
        .prepare("SELECT xp, level FROM users WHERE guild_id=? AND user_id=?")
        .get(gid, uid);
      if (!row) {
        db.prepare(
          "INSERT OR IGNORE INTO users (guild_id,user_id) VALUES (?,?)",
        ).run(gid, uid);
        row = { xp: 0, level: 0 };
      }
      let { xp, level } = row;
      xp += Math.floor(Math.random() * (XP_MAX - XP_MIN + 1)) + XP_MIN;
      let leveled = false;
      while (xp >= xpFor(level)) {
        xp -= xpFor(level);
        level++;
        leveled = true;
      }
      db.prepare(
        "INSERT INTO users (guild_id,user_id,xp,level) VALUES (?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET xp=excluded.xp,level=excluded.level",
      ).run(gid, uid, xp, level);

      if (leveled && s.levelup_enabled !== 0) {
        const embed = new EmbedBuilder()
          .setTitle("Level Up! 🎉")
          .setDescription(
            `تهانينا ${message.author}! وصلت للمستوى **${level}**!`,
          )
          .setColor(0xfaa61a)
          .setThumbnail(message.author.displayAvatarURL())
          .setFooter({ text: `التالي: ${xpFor(level).toLocaleString()} XP` });
        let target = message.channel;
        if (s.levelup_channel) {
          const lch = message.guild.channels.cache.get(
            String(s.levelup_channel),
          );
          if (lch) target = lch;
        }
        await target.send({ embeds: [embed] }).catch(() => {});
        const lroles = getLevelRoles(message.guild.id);
        if (lroles.length)
          await assignLevelRoles(message.member, level, lroles);
      }
    }
  } catch (e) {
    console.error("[xp_leveling]", e.message);
  }

  // ── Commands ──────────────────────────────────────────
  if (isCmd) await handleCommand(message, prefix);
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const s = getSettings(member.guild.id);
    if (s.welcome_channel && s.welcome_message) {
      const ch = member.guild.channels.cache.get(String(s.welcome_channel));
      if (ch) {
        const text = s.welcome_message
          .replace(/{user}/g, member.toString())
          .replace(/{guild}/g, member.guild.name)
          .replace(/{count}/g, String(member.guild.memberCount));
        await ch
          .send({
            embeds: [
              new EmbedBuilder()
                .setDescription(text)
                .setColor(0x3ba55d)
                .setThumbnail(member.user.displayAvatarURL())
                .setAuthor({
                  name: member.guild.name,
                  iconURL: member.guild.iconURL() || undefined,
                }),
            ],
          })
          .catch(() => {});
      }
    }
    if (s.auto_role_id) {
      const role = member.guild.roles.cache.get(String(s.auto_role_id));
      if (role) await member.roles.add(role, "Auto-Role").catch(() => {});
    }
    await sendLog(
      member.guild.id,
      new EmbedBuilder()
        .setTitle("✅ عضو انضم")
        .setColor(0x57f287)
        .setDescription(
          `${member} انضم إلى السيرفر\n**ID:** ${member.id}\n**الحساب:** <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`,
        )
        .setThumbnail(member.user.displayAvatarURL()),
    );
  } catch (e) {
    console.error("[on_member_join]", e.message);
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  try {
    const s = getSettings(member.guild.id);
    if (s.leave_channel && s.leave_message) {
      const ch = member.guild.channels.cache.get(String(s.leave_channel));
      if (ch) {
        const text = s.leave_message
          .replace(/{user}/g, member.user.tag)
          .replace(/{guild}/g, member.guild.name)
          .replace(/{count}/g, String(member.guild.memberCount));
        await ch
          .send({
            embeds: [
              new EmbedBuilder()
                .setDescription(text)
                .setColor(0xed4245)
                .setThumbnail(member.user.displayAvatarURL()),
            ],
          })
          .catch(() => {});
      }
    }
    await sendLog(
      member.guild.id,
      new EmbedBuilder()
        .setTitle("❌ عضو غادر")
        .setColor(0xed4245)
        .setDescription(
          `**${member.user.tag}** غادر السيرفر\n**ID:** ${member.id}`,
        )
        .setThumbnail(member.user.displayAvatarURL()),
    );
  } catch (e) {
    console.error("[on_member_remove]", e.message);
  }
});

client.on(Events.GuildBanAdd, async (ban) => {
  try {
    await sendLog(
      ban.guild.id,
      new EmbedBuilder()
        .setTitle("🔨 حظر")
        .setColor(0xed4245)
        .setDescription(`**${ban.user.tag}** تم حظره\n**ID:** ${ban.user.id}`)
        .setThumbnail(ban.user.displayAvatarURL()),
    );
  } catch {}
});

client.on(Events.GuildBanRemove, async (ban) => {
  try {
    await sendLog(
      ban.guild.id,
      new EmbedBuilder()
        .setTitle("✅ رفع حظر")
        .setColor(0x57f287)
        .setDescription(
          `**${ban.user.tag}** تم رفع حظره\n**ID:** ${ban.user.id}`,
        ),
    );
  } catch {}
});

client.on(Events.ChannelCreate, async (channel) => {
  if (!channel.guild) return;
  try {
    await sendLog(
      channel.guild.id,
      new EmbedBuilder()
        .setTitle("📁 روم جديد أُنشئ")
        .setColor(0x5865f2)
        .setDescription(`**${channel.name}** — النوع: ${channel.type}`),
    );
  } catch {}
});

client.on(Events.ChannelDelete, async (channel) => {
  if (!channel.guild) return;
  try {
    await sendLog(
      channel.guild.id,
      new EmbedBuilder()
        .setTitle("🗑️ روم حُذف")
        .setColor(0xfee75c)
        .setDescription(`**${channel.name}** — النوع: ${channel.type}`),
    );
  } catch {}
});

client.on(Events.GuildRoleCreate, async (role) => {
  try {
    await sendLog(
      role.guild.id,
      new EmbedBuilder()
        .setTitle("🎭 رتبة جديدة أُنشئت")
        .setColor(role.color || 0x5865f2)
        .setDescription(`**${role.name}**`),
    );
  } catch {}
});

client.on(Events.GuildRoleDelete, async (role) => {
  try {
    await sendLog(
      role.guild.id,
      new EmbedBuilder()
        .setTitle("🗑️ رتبة حُذفت")
        .setColor(0xfee75c)
        .setDescription(`**${role.name}**`),
    );
  } catch {}
});

client.on(Events.GuildMemberUpdate, async (before, after) => {
  try {
    const wasTimeout = before.communicationDisabledUntilTimestamp;
    const isTimeout = after.communicationDisabledUntilTimestamp;
    if (!wasTimeout && isTimeout && isTimeout > Date.now()) {
      await sendLog(
        after.guild.id,
        new EmbedBuilder()
          .setTitle("⏱️ Timeout مُطبَّق")
          .setColor(0xf57731)
          .setDescription(
            `${after} — حتى <t:${Math.floor(isTimeout / 1000)}:f>`,
          ),
      );
    } else if (wasTimeout && (!isTimeout || isTimeout <= Date.now())) {
      await sendLog(
        after.guild.id,
        new EmbedBuilder()
          .setTitle("✅ رُفع Timeout")
          .setColor(0x57f287)
          .setDescription(`${after} رُفع عنه الـ Timeout.`),
      );
    }
  } catch {}
});

// ═══════════════════════════════════════════════════════════
//  COMMAND HANDLER
// ═══════════════════════════════════════════════════════════

const CMDS = {
  // Mod commands
  warn: { aliases: ["ت", "تحذير"], perm: "KickMembers" },
  warnings: { aliases: ["تحذيرات", "warns"], perm: null },
  clearwarns: { aliases: ["مسح_تحذيرات", "محو_تحذيرات"], perm: "ManageGuild" },
  timeout: { aliases: ["س", "إسكات", "mute"], perm: "ModerateMembers" },
  untimeout: { aliases: ["رفع", "unmute"], perm: "ModerateMembers" },
  kick: { aliases: ["ط", "طرد"], perm: "KickMembers" },
  ban: { aliases: ["ح", "حظر"], perm: "BanMembers" },
  unban: { aliases: ["رفع_حظر"], perm: "BanMembers" },
  clear: {
    aliases: ["مسح", "محو", "purge", "c", "cls"],
    perm: "ManageMessages",
  },
  // Level commands
  rank: { aliases: ["ر", "رتبة"], perm: null },
  leaderboard: { aliases: ["lb", "قائمة"], perm: null },
  // Debug
  ar: { aliases: ["autoresponse_debug"], perm: "ManageGuild" },
};

// Reverse map alias→name
const aliasMap = new Map();
for (const [name, cfg] of Object.entries(CMDS)) {
  aliasMap.set(name, name);
  for (const a of cfg.aliases) aliasMap.set(a, name);
}

async function handleCommand(message, prefix) {
  let content = message.content;
  if (content.startsWith(`<@${client.user.id}>`))
    content = content.slice(`<@${client.user.id}>`.length).trim();
  else if (content.startsWith(prefix))
    content = content.slice(prefix.length).trim();
  else return;

  const args = content.split(/\s+/);
  const cmdName = aliasMap.get(args[0]);
  if (!cmdName) return;

  const cfg = CMDS[cmdName];
  if (
    cfg.perm &&
    !message.member.permissions.has(PermissionFlagsBits[cfg.perm])
  ) {
    return message.reply("❌ ليس لديك الصلاحية.").catch(() => {});
  }

  try {
    await HANDLERS[cmdName](message, args.slice(1));
  } catch (e) {
    console.error(`[cmd:${cmdName}]`, e.message);
    message.reply("❌ حدث خطأ أثناء تنفيذ الأمر.").catch(() => {});
  }
}

// Helper: resolve member from mention or ID
async function resolveMember(guild, str) {
  if (!str) return null;
  const id = str.replace(/[<@!>]/g, "");
  return guild.members.fetch(id).catch(() => null);
}

const HANDLERS = {
  async warn(message, args) {
    const member = await resolveMember(message.guild, args[0]);
    if (!member) return message.reply("❌ لم يُعثر على العضو.");
    const reason = args.slice(1).join(" ") || "لم يُحدد";
    const count = addWarn(
      message.guild.id,
      member.id,
      message.author.id,
      reason,
    );
    const embed = new EmbedBuilder()
      .setTitle("⚠️ تحذير")
      .setColor(0xfaa61a)
      .addFields(
        { name: "العضو", value: member.toString(), inline: true },
        { name: "المشرف", value: message.author.toString(), inline: true },
        { name: "السبب", value: reason, inline: false },
        { name: "الإجمالي", value: `**${count}**`, inline: true },
      )
      .setThumbnail(member.user.displayAvatarURL());
    await message.channel.send({ embeds: [embed] });
    await sendLog(
      message.guild.id,
      new EmbedBuilder()
        .setTitle("⚠️ تحذير")
        .setColor(0xfaa61a)
        .setDescription(
          `${member} حُذِّر من ${message.author}\n**السبب:** ${reason}\n**الإجمالي:** ${count}`,
        ),
    );
  },

  async warnings(message, args) {
    const target = args[0]
      ? await resolveMember(message.guild, args[0])
      : message.member;
    if (!target) return message.reply("❌ لم يُعثر على العضو.");
    const rows = db
      .prepare(
        "SELECT reason, created_at FROM warn_logs WHERE guild_id=? AND user_id=? ORDER BY id DESC LIMIT 10",
      )
      .all(BigInt(message.guild.id), BigInt(target.id));
    const embed = new EmbedBuilder()
      .setTitle(`📋 تحذيرات ${target.user.username}`)
      .setColor(0xf57731)
      .setThumbnail(target.user.displayAvatarURL())
      .setDescription(
        rows.length
          ? rows
              .map(
                (r, i) =>
                  `\`${i + 1}.\` ${r.reason} — *${r.created_at.slice(0, 10)}*`,
              )
              .join("\n")
          : "لا توجد تحذيرات.",
      )
      .setFooter({ text: `إجمالي: ${rows.length}` });
    await message.channel.send({ embeds: [embed] });
  },

  async clearwarns(message, args) {
    const member = await resolveMember(message.guild, args[0]);
    if (!member) return message.reply("❌ لم يُعثر على العضو.");
    db.prepare("DELETE FROM warn_logs WHERE guild_id=? AND user_id=?").run(
      BigInt(message.guild.id),
      BigInt(member.id),
    );
    await message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setDescription(`✅ تم مسح تحذيرات ${member}.`)
          .setColor(0x3ba55d),
      ],
    });
  },

  async timeout(message, args) {
    const member = await resolveMember(message.guild, args[0]);
    if (!member) return message.reply("❌ لم يُعثر على العضو.");
    if (member.permissions.has(PermissionFlagsBits.Administrator))
      return message.reply("❌ لا يمكن تطبيق Timeout على مشرف.");
    const minutes = parseInt(args[1]) || 5;
    const reason = args.slice(2).join(" ") || "لم يُحدد";
    await member.timeout(minutes * 60 * 1000, reason);
    const embed = new EmbedBuilder()
      .setTitle("⏱️ Timeout")
      .setColor(0xf57731)
      .addFields(
        { name: "العضو", value: member.toString(), inline: true },
        { name: "المدة", value: `${minutes} دقيقة`, inline: true },
        { name: "السبب", value: reason, inline: false },
      );
    await message.channel.send({ embeds: [embed] });
    await sendLog(
      message.guild.id,
      new EmbedBuilder()
        .setTitle("⏱️ Timeout")
        .setColor(0xf57731)
        .setDescription(
          `${member} أُسكت لـ ${minutes} دقيقة\n**السبب:** ${reason}`,
        ),
    );
  },

  async untimeout(message, args) {
    const member = await resolveMember(message.guild, args[0]);
    if (!member) return message.reply("❌ لم يُعثر على العضو.");
    await member.timeout(null);
    await message.reply(`✅ رُفع Timeout عن ${member}.`);
  },

  async kick(message, args) {
    const member = await resolveMember(message.guild, args[0]);
    if (!member) return message.reply("❌ لم يُعثر على العضو.");
    if (member.permissions.has(PermissionFlagsBits.Administrator))
      return message.reply("❌ لا يمكن طرد مشرف.");
    const reason = args.slice(1).join(" ") || "لم يُحدد";
    await member.kick(reason);
    await message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("👢 طرد")
          .setColor(0xed4245)
          .setDescription(`تم طرد ${member.user.tag}\n**السبب:** ${reason}`),
      ],
    });
    await sendLog(
      message.guild.id,
      new EmbedBuilder()
        .setTitle("👢 طرد")
        .setColor(0xed4245)
        .setDescription(
          `${member} طُرد من ${message.author}\n**السبب:** ${reason}`,
        ),
    );
  },

  async ban(message, args) {
    const member = await resolveMember(message.guild, args[0]);
    if (!member) return message.reply("❌ لم يُعثر على العضو.");
    if (member.permissions.has(PermissionFlagsBits.Administrator))
      return message.reply("❌ لا يمكن حظر مشرف.");
    const reason = args.slice(1).join(" ") || "لم يُحدد";
    await member.ban({ reason, deleteMessageSeconds: 0 });
    await message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("🔨 حظر")
          .setColor(0xc62e2e)
          .setDescription(`تم حظر ${member.user.tag}\n**السبب:** ${reason}`),
      ],
    });
    await sendLog(
      message.guild.id,
      new EmbedBuilder()
        .setTitle("🔨 حظر")
        .setColor(0xc62e2e)
        .setDescription(
          `${member} حُظر من ${message.author}\n**السبب:** ${reason}`,
        ),
    );
  },

  async unban(message, args) {
    const userId = args[0];
    if (!userId) return message.reply("❌ أدخل User ID.");
    try {
      const user = await client.users.fetch(userId);
      await message.guild.members.unban(user);
      await message.reply(`✅ رُفع الحظر عن ${user.tag}.`);
    } catch {
      message.reply("❌ لم يُعثر عليه في المحظورين.");
    }
  },

  async clear(message, args) {
    const amount = parseInt(args[0]) || 10;
    if (amount < 1 || amount > 500)
      return message.reply({
        content: "❌ العدد يجب بين **1** و **500**.",
        allowedMentions: { repliedUser: false },
      });
    const deleted = await message.channel
      .bulkDelete(amount + 1, true)
      .catch(() => null);
    const n = deleted ? Math.max(0, deleted.size - 1) : 0;
    const msg = await message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setDescription(`🗑️ تم مسح **${n}** رسالة بنجاح.`)
          .setColor(0x3ba55d),
      ],
    });
    setTimeout(() => msg.delete().catch(() => {}), 4000);
  },

  async rank(message, args) {
    const target = args[0]
      ? await resolveMember(message.guild, args[0])
      : message.member;
    if (!target) return message.reply("❌ لم يُعثر على العضو.");
    const row = db
      .prepare("SELECT xp, level FROM users WHERE guild_id=? AND user_id=?")
      .get(BigInt(message.guild.id), BigInt(target.id)) || { xp: 0, level: 0 };
    const needed = xpFor(row.level);
    const prog = needed ? Math.min(Math.floor((row.xp / needed) * 20), 20) : 0;
    const bar = "█".repeat(prog) + "░".repeat(20 - prog);
    const embed = new EmbedBuilder()
      .setTitle(`رتبة ${target.user.username}`)
      .setColor(0x5865f2)
      .setThumbnail(target.user.displayAvatarURL())
      .addFields(
        { name: "المستوى", value: String(row.level), inline: true },
        {
          name: "XP",
          value: `${row.xp.toLocaleString()} / ${needed.toLocaleString()}`,
          inline: true,
        },
        {
          name: "التقدم",
          value: `\`${bar}\` ${needed ? Math.floor((row.xp * 100) / needed) : 0}%`,
          inline: false,
        },
      );
    await message.channel.send({ embeds: [embed] });
  },

  async leaderboard(message) {
    const rows = db
      .prepare(
        "SELECT user_id, xp, level FROM users WHERE guild_id=? ORDER BY level DESC, xp DESC LIMIT 10",
      )
      .all(BigInt(message.guild.id));
    if (!rows.length) return message.reply("لا أحد كسب XP بعد!");
    const medals = { 1: "🥇", 2: "🥈", 3: "🥉" };
    const embed = new EmbedBuilder()
      .setTitle(`🏆 أفضل 10 — ${message.guild.name}`)
      .setColor(0xfaa61a);
    const lines = await Promise.all(
      rows.map(async (r, i) => {
        const m = await message.guild.members
          .fetch(String(r.user_id))
          .catch(() => null);
        const name = m ? m.displayName : `User ${r.user_id}`;
        return `${medals[i + 1] || `\`#${i + 1}\``} **${name}** — Lv ${r.level} (${r.xp.toLocaleString()} XP)`;
      }),
    );
    embed.setDescription(lines.join("\n"));
    await message.channel.send({ embeds: [embed] });
  },

  async ar(message) {
    const rows = db
      .prepare(
        "SELECT id, guild_id, trigger, response, match_type FROM auto_responses WHERE guild_id=?",
      )
      .all(BigInt(message.guild.id));
    const total = db
      .prepare("SELECT COUNT(*) as c FROM auto_responses")
      .get().c;
    const embed = new EmbedBuilder()
      .setTitle("🔍 تشخيص الردود التلقائية")
      .setColor(0x5865f2)
      .addFields(
        { name: "🆔 Guild ID", value: `\`${message.guild.id}\``, inline: true },
        { name: "📊 إجمالي الصفوف", value: `\`${total}\``, inline: true },
      );
    if (rows.length) {
      embed.addFields({
        name: `✅ الردود المحفوظة (${rows.length})`,
        value: rows
          .map(
            (r) =>
              `\`#${r.id}\` | \`${r.match_type}\` | **${r.trigger}** → ${String(r.response).slice(0, 40)}`,
          )
          .join("\n"),
        inline: false,
      });
    } else {
      embed.addFields({
        name: "❌ لا يوجد ردود",
        value: "افتح الداشبورد → الردود التلقائية → أضف رداً → احفظ.",
        inline: false,
      });
    }
    await message.channel.send({ embeds: [embed] });
  },
};

// ═══════════════════════════════════════════════════════════
//  LAUNCH
// ═══════════════════════════════════════════════════════════

client.on("error", (e) => console.error("[client error]", e.message));
process.on("unhandledRejection", (e) =>
  console.error("[unhandledRejection]", e),
);

client.login(TOKEN);

module.exports = client;
