const {
  Client, GatewayIntentBits, Collection, Events, REST, Routes,
  SlashCommandBuilder, MessageFlags, EmbedBuilder, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, RoleSelectMenuBuilder,
} = require('discord.js');
const { readFileSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');
require('dotenv').config();

const dataDir = join(__dirname, 'data');
if (!existsSync(dataDir)) require('fs').mkdirSync(dataDir, { recursive: true });

function loadJSON(file, def) {
  const p = join(dataDir, file);
  if (!existsSync(p)) return def;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return def; }
}
function saveJSON(file, data) {
  writeFileSync(join(dataDir, file), JSON.stringify(data, null, 2));
}

function loadSetup() { return loadJSON('setup.json', {}); }
function saveSetup(d) { saveJSON('setup.json', d); }
function hasPermission(interaction, name) {
  const s = loadSetup(); const g = interaction.guildId;
  if (!s[g] || !s[g][name]) return true;
  const r = s[g][name]; if (r.length === 0) return true;
  return interaction.member.roles.cache.some(x => r.includes(x.id));
}
function setCommandRoles(gid, name, roles) {
  const s = loadSetup(); if (!s[gid]) s[gid] = {}; s[gid][name] = roles; saveSetup(s);
}
function getGuildSetup(gid) { const s = loadSetup(); return s[gid] || {}; }

async function syncCommandPermissions(guildId, commands) {
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  const setup = loadSetup(); const gs = setup[guildId] || {};
  const payload = commands.map(cmd => {
    const j = cmd.data.toJSON(); const r = gs[j.name];
    if (r && r.length > 0) j.default_member_permissions = '0';
    else delete j.default_member_permissions;
    return j;
  });
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId), { body: payload });
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
  ],
});
client.commands = new Collection();

const waitingForImage = new Map();
const ulbImageWaiting = new Map();
const dmsallPending = new Map();
const giveawaySessions = new Map();
const embedSessions = new Map();
const updatelogSessions = new Map();
const setupSessions = new Map();
const scriptSessions = new Map();
const joinTracker = new Map();
const lockdownGuilds = new Set();

const BAN = {
  data: new SlashCommandBuilder().setName('ban').setDescription('Ban a member')
    .addUserOption(o => o.setName('user').setDescription('User to ban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason'))
    .addIntegerOption(o => o.setName('days').setDescription('Delete messages days (0-7)').setMinValue(0).setMaxValue(7)),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const days = interaction.options.getInteger('days') ?? 0;
    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    if (!member) return interaction.editReply({ content: '❌ User not found.' });
    if (!member.bannable) return interaction.editReply({ content: '❌ Cannot ban this user.' });
    await member.ban({ deleteMessageSeconds: days * 86400, reason });
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xff3232).setTitle('🔨 Member Banned')
      .addFields({ name: 'User', value: `${target.tag} (${target.id})`, inline: true }, { name: 'Moderator', value: interaction.user.tag, inline: true }, { name: 'Reason', value: reason })
      .setThumbnail(target.displayAvatarURL()).setTimestamp()] });
  },
};

const KICK = {
  data: new SlashCommandBuilder().setName('kick').setDescription('Kick a member')
    .addUserOption(o => o.setName('user').setDescription('User to kick').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    if (!member) return interaction.editReply({ content: '❌ User not found.' });
    if (!member.kickable) return interaction.editReply({ content: '❌ Cannot kick this user.' });
    await member.kick(reason);
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xff9900).setTitle('👢 Member Kicked')
      .addFields({ name: 'User', value: `${target.tag} (${target.id})`, inline: true }, { name: 'Moderator', value: interaction.user.tag, inline: true }, { name: 'Reason', value: reason })
      .setThumbnail(target.displayAvatarURL()).setTimestamp()] });
  },
};

const TIMEOUT = {
  data: new SlashCommandBuilder().setName('timeout').setDescription('Timeout a member')
    .addUserOption(o => o.setName('user').setDescription('User to timeout').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('Duration').setRequired(true)
      .addChoices({ name: '1 minute', value: '60' }, { name: '5 minutes', value: '300' }, { name: '10 minutes', value: '600' },
        { name: '30 minutes', value: '1800' }, { name: '1 hour', value: '3600' }, { name: '6 hours', value: '21600' },
        { name: '12 hours', value: '43200' }, { name: '1 day', value: '86400' }, { name: '3 days', value: '259200' }, { name: '1 week', value: '604800' }))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const target = interaction.options.getUser('user');
    const seconds = parseInt(interaction.options.getString('duration'));
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    if (!member) return interaction.editReply({ content: '❌ User not found.' });
    if (!member.moderatable) return interaction.editReply({ content: '❌ Cannot timeout this user.' });
    await member.timeout(seconds * 1000, reason);
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xffcc00).setTitle('⏱️ Member Timed Out')
      .addFields({ name: 'User', value: `${target.tag}`, inline: true }, { name: 'Moderator', value: interaction.user.tag, inline: true },
        { name: 'Until', value: `<t:${Math.floor(Date.now() / 1000 + seconds)}:R>`, inline: true }, { name: 'Reason', value: reason })
      .setThumbnail(target.displayAvatarURL()).setTimestamp()] });
  },
};

const WARN = {
  data: new SlashCommandBuilder().setName('warn').setDescription('Warn a member')
    .addUserOption(o => o.setName('user').setDescription('User to warn').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason');
    const warns = loadJSON('warnings.json', {}); const key = `${interaction.guildId}-${target.id}`;
    if (!warns[key]) warns[key] = [];
    warns[key].push({ reason, moderator: interaction.user.id, timestamp: Date.now() });
    saveJSON('warnings.json', warns);
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xffa500).setTitle('⚠️ Member Warned')
      .addFields({ name: 'User', value: `${target.tag}`, inline: true }, { name: 'Moderator', value: interaction.user.tag, inline: true },
        { name: 'Total Warnings', value: `${warns[key].length}`, inline: true }, { name: 'Reason', value: reason })
      .setThumbnail(target.displayAvatarURL()).setTimestamp()] });
  },
};

const WARNINGS = {
  data: new SlashCommandBuilder().setName('warnings').setDescription('View warnings for a member')
    .addUserOption(o => o.setName('user').setDescription('User to check').setRequired(true)),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const target = interaction.options.getUser('user');
    const warns = loadJSON('warnings.json', {}); const key = `${interaction.guildId}-${target.id}`;
    const uw = warns[key] || [];
    if (uw.length === 0) return interaction.editReply({ content: `✅ **${target.tag}** has no warnings.` });
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xffa500).setTitle(`⚠️ Warnings for ${target.tag}`)
      .setThumbnail(target.displayAvatarURL())
      .setDescription(uw.map((w, i) => `**#${i + 1}** — <t:${Math.floor(w.timestamp / 1000)}:d>\n> ${w.reason}\n> by <@${w.moderator}>`).join('\n\n'))
      .setFooter({ text: `Total: ${uw.length} warning(s)` }).setTimestamp()] });
  },
};

const UNBAN = {
  data: new SlashCommandBuilder().setName('unban').setDescription('Unban a user by ID')
    .addStringOption(o => o.setName('userid').setDescription('User ID to unban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const userId = interaction.options.getString('userid');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const ban = await interaction.guild.bans.fetch(userId).catch(() => null);
    if (!ban) return interaction.editReply({ content: '❌ This user is not banned.' });
    await interaction.guild.members.unban(userId, reason);
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('✅ Member Unbanned')
      .addFields({ name: 'User', value: `${ban.user.tag} (${userId})`, inline: true }, { name: 'Moderator', value: interaction.user.tag, inline: true }, { name: 'Reason', value: reason })
      .setTimestamp()] });
  },
};

const PURGE = {
  data: new SlashCommandBuilder().setName('purge').setDescription('Delete messages from channel')
    .addIntegerOption(o => o.setName('amount').setDescription('Messages to delete (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
    .addUserOption(o => o.setName('user').setDescription('Only delete messages from this user')),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const amount = interaction.options.getInteger('amount');
    const targetUser = interaction.options.getUser('user');
    let messages = await interaction.channel.messages.fetch({ limit: 100 });
    if (targetUser) messages = messages.filter(m => m.author.id === targetUser.id);
    const toDelete = [...messages.values()].slice(0, amount).filter(m => Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
    if (toDelete.length === 0) return interaction.editReply({ content: '❌ No deletable messages found.' });
    const deleted = await interaction.channel.bulkDelete(toDelete, true);
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🧹 Messages Purged')
      .addFields({ name: 'Deleted', value: `${deleted.size}`, inline: true }, { name: 'Channel', value: `${interaction.channel}`, inline: true }, { name: 'Moderator', value: interaction.user.tag, inline: true })
      .setTimestamp()] });
  },
};

const SLOWMODE = {
  data: new SlashCommandBuilder().setName('slowmode').setDescription('Set channel slowmode')
    .addIntegerOption(o => o.setName('seconds').setDescription('Seconds (0 to disable)').setRequired(true).setMinValue(0).setMaxValue(21600))
    .addChannelOption(o => o.setName('channel').setDescription('Target channel')),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const seconds = interaction.options.getInteger('seconds');
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    await channel.setRateLimitPerUser(seconds);
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🐌 Slowmode Updated')
      .addFields({ name: 'Channel', value: `${channel}`, inline: true }, { name: 'Slowmode', value: seconds === 0 ? 'Disabled' : `${seconds}s`, inline: true })
      .setTimestamp()] });
  },
};

const LOCK = {
  data: new SlashCommandBuilder().setName('lock').setDescription('Lock or unlock a channel')
    .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices({ name: 'Lock', value: 'lock' }, { name: 'Unlock', value: 'unlock' }))
    .addChannelOption(o => o.setName('channel').setDescription('Target channel')),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const action = interaction.options.getString('action');
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const isLocking = action === 'lock';
    await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: isLocking ? false : null });
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(isLocking ? 0xff3232 : 0x00cc66).setTitle(isLocking ? '🔒 Channel Locked' : '🔓 Channel Unlocked')
      .addFields({ name: 'Channel', value: `${channel}`, inline: true }, { name: 'Moderator', value: interaction.user.tag, inline: true })
      .setTimestamp()] });
  },
};

const USERINFO = {
  data: new SlashCommandBuilder().setName('userinfo').setDescription('Get info about a user')
    .addUserOption(o => o.setName('user').setDescription('User to inspect')),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const target = interaction.options.getUser('user') || interaction.user;
    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    const roles = member ? member.roles.cache.filter(r => r.id !== interaction.guildId).sort((a, b) => b.position - a.position).map(r => `${r}`).slice(0, 10) : [];
    const badgeMap = { Staff: '👨‍💼 Discord Staff', Partner: '🤝 Partner', BugHunterLevel1: '🐛 Bug Hunter', BugHunterLevel2: '🐛 Bug Hunter Gold', HypeSquadOnlineHouse1: '🏡 Bravery', HypeSquadOnlineHouse2: '🏡 Brilliance', HypeSquadOnlineHouse3: '🏡 Balance', PremiumEarlySupporter: '⭐ Early Supporter', VerifiedDeveloper: '🤖 Verified Dev', ActiveDeveloper: '👨‍💻 Active Dev' };
    const badges = (target.flags?.toArray() || []).map(f => badgeMap[f]).filter(Boolean);
    const embed = new EmbedBuilder().setColor(member?.displayHexColor || 0x5865f2).setTitle(`👤 ${target.username}`).setThumbnail(target.displayAvatarURL({ size: 512 }))
      .addFields({ name: '🆔 User ID', value: target.id, inline: true }, { name: '🤖 Bot', value: target.bot ? 'Yes' : 'No', inline: true },
        { name: '📅 Joined Discord', value: `<t:${Math.floor(target.createdTimestamp / 1000)}:D>`, inline: true },
        { name: '📥 Joined Server', value: member ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>` : 'N/A', inline: true },
        { name: '⚡ Boosting', value: member?.premiumSince ? `<t:${Math.floor(member.premiumSinceTimestamp / 1000)}:R>` : 'No', inline: true });
    if (badges.length > 0) embed.addFields({ name: '🏅 Badges', value: badges.join('\n') });
    if (roles.length > 0) embed.addFields({ name: `🎭 Roles [${roles.length}]`, value: roles.join(' ') });
    embed.setFooter({ text: `Requested by ${interaction.user.tag}` }).setTimestamp();
    await interaction.editReply({ embeds: [embed] });
  },
};

const SERVERINFO = {
  data: new SlashCommandBuilder().setName('serverinfo').setDescription('Get info about this server'),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild; await guild.fetch();
    const members = await guild.members.fetch();
    const bots = members.filter(m => m.user.bot).size;
    const ch = guild.channels.cache;
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`🏠 ${guild.name}`).setThumbnail(guild.iconURL({ size: 512 }))
      .addFields({ name: '🆔 Server ID', value: guild.id, inline: true }, { name: '👑 Owner', value: `<@${guild.ownerId}>`, inline: true },
        { name: '📅 Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true },
        { name: '👥 Members', value: `Total: **${members.size}**\nHumans: **${members.size - bots}**\nBots: **${bots}**`, inline: true },
        { name: '💬 Channels', value: `Text: **${ch.filter(c => c.type === ChannelType.GuildText).size}**\nVoice: **${ch.filter(c => c.type === ChannelType.GuildVoice).size}**`, inline: true },
        { name: '🚀 Boost', value: `Level ${guild.premiumTier} (${guild.premiumSubscriptionCount || 0} boosts)`, inline: true })
      .setFooter({ text: `Requested by ${interaction.user.tag}` }).setTimestamp();
    if (guild.bannerURL()) embed.setImage(guild.bannerURL({ size: 1024 }));
    await interaction.editReply({ embeds: [embed] });
  },
};

const AVATAR = {
  data: new SlashCommandBuilder().setName('avatar').setDescription('Get avatar of a user')
    .addUserOption(o => o.setName('user').setDescription('User')),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const target = interaction.options.getUser('user') || interaction.user;
    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    const globalAvatar = target.displayAvatarURL({ size: 4096, extension: 'png' });
    const serverAvatar = member?.avatarURL({ size: 4096, extension: 'png' });
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Open Global Avatar').setStyle(ButtonStyle.Link).setURL(globalAvatar));
    if (serverAvatar) row.addComponents(new ButtonBuilder().setLabel('Open Server Avatar').setStyle(ButtonStyle.Link).setURL(serverAvatar));
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`🖼️ ${target.username}'s Avatar`).setImage(serverAvatar || globalAvatar).setFooter({ text: serverAvatar ? 'Server avatar' : 'Global avatar' })], components: [row] });
  },
};

const BOTINFO = {
  data: new SlashCommandBuilder().setName('botinfo').setDescription('Get info about the bot'),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const ping = client.ws.ping;
    const pingEmoji = ping < 100 ? '🟢' : ping < 200 ? '🟡' : '🔴';
    const uptime = (() => { const s = Math.floor(client.uptime / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24); return d > 0 ? `${d}d ${h % 24}h` : h > 0 ? `${h}h ${m % 60}m` : `${m}m ${s % 60}s`; })();
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`🤖 ${client.user.username}`).setThumbnail(client.user.displayAvatarURL({ size: 512 }))
      .addFields({ name: `${pingEmoji} Ping`, value: `${ping}ms`, inline: true }, { name: '⏱️ Uptime', value: uptime, inline: true },
        { name: '🏠 Servers', value: `${client.guilds.cache.size}`, inline: true }, { name: '⚡ Commands', value: `${client.commands.size}`, inline: true },
        { name: '💾 Memory', value: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`, inline: true }, { name: '📦 discord.js', value: require('discord.js').version, inline: true })
      .setFooter({ text: `Requested by ${interaction.user.tag}` }).setTimestamp()] });
  },
};

const DMSALL = {
  data: new SlashCommandBuilder().setName('dmsall').setDescription('Send DM to all members')
    .addStringOption(o => o.setName('type').setDescription('Message type').setRequired(true).addChoices({ name: '📝 Normal', value: 'normal' }, { name: '📊 Embed', value: 'embed' }))
    .addStringOption(o => o.setName('message').setDescription('Message to send').setRequired(true))
    .addStringOption(o => o.setName('title').setDescription('Embed title'))
    .addStringOption(o => o.setName('color').setDescription('Embed hex color e.g. #5865f2')),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const type = interaction.options.getString('type');
    const message = interaction.options.getString('message');
    const title = interaction.options.getString('title') || interaction.guild.name;
    const color = parseInt((interaction.options.getString('color') || '#5865f2').replace('#', ''), 16) || 0x5865f2;
    dmsallPending.set(interaction.user.id, { type, message, title, color, guildId: interaction.guildId });
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xffcc00).setTitle('⚠️ Confirm DM All').setDescription(`Send DM to **all members** of **${interaction.guild.name}**?\n\n**Type:** ${type}\n**Message:**\n> ${message}`).setFooter({ text: 'Confirm or Cancel' })],
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('dmsall:confirm').setLabel('✅ Confirm').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('dmsall:cancel').setLabel('❌ Cancel').setStyle(ButtonStyle.Danger))] });
  },
  async handleButton(interaction) {
    const action = interaction.customId.split(':')[1];
    const data = dmsallPending.get(interaction.user.id);
    if (!data) return interaction.reply({ content: '❌ Session expired.', flags: MessageFlags.Ephemeral });
    if (action === 'cancel') { dmsallPending.delete(interaction.user.id); return interaction.update({ content: '❌ Cancelled.', embeds: [], components: [] }); }
    if (action === 'confirm') {
      await interaction.update({ content: '📤 Sending DMs...', embeds: [], components: [] });
      dmsallPending.delete(interaction.user.id);
      const members = await interaction.guild.members.fetch(); let sent = 0, failed = 0;
      for (const [, m] of members) {
        if (m.user.bot) continue;
        try {
          if (data.type === 'embed') await m.send({ embeds: [new EmbedBuilder().setColor(data.color).setTitle(data.title).setDescription(data.message).setFooter({ text: interaction.guild.name, iconURL: interaction.guild.iconURL() }).setTimestamp()] });
          else await m.send(data.message);
          sent++;
        } catch { failed++; }
        await new Promise(r => setTimeout(r, 800));
      }
      await interaction.editReply({ content: '', embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('📬 DM All Completed').addFields({ name: '✅ Sent', value: `${sent}`, inline: true }, { name: '❌ Failed', value: `${failed}`, inline: true }).setTimestamp()] });
    }
  },
};

function parseDuration(str) { const m = str.match(/^(\d+)([smhd])$/i); if (!m) return null; return parseInt(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()]); }
function pickWinners(entries, count) { return [...entries].sort(() => Math.random() - 0.5).slice(0, count); }

async function endGiveaway(messageId, clientRef) {
  const giveaways = loadJSON('giveaways.json', {}); const gw = giveaways[messageId];
  if (!gw || gw.ended) return '❌ Not found or already ended.';
  gw.ended = true; saveJSON('giveaways.json', giveaways);
  const channel = await clientRef.channels.fetch(gw.channelId).catch(() => null); if (!channel) return '❌ Channel not found.';
  const msg = await channel.messages.fetch(messageId).catch(() => null);
  const winners = pickWinners(gw.entries, Math.min(gw.winnerCount, gw.entries.length));
  const winnersText = winners.length > 0 ? winners.map(id => `<@${id}>`).join(', ') : 'No winners';
  const endEmbed = new EmbedBuilder().setColor(0x888888).setTitle(`🎊 GIVEAWAY ENDED — ${gw.prize}`)
    .setDescription([`> 🏆 **Prize:** ${gw.prize}`, `> 👑 **Winner(s):** ${winnersText}`, `> 🎟️ **Entries:** ${gw.entries.length}`, `> 🎟️ **Host:** <@${gw.hostId}>`, '', '━━━━━━━━━━━━━━━━━━━━━━━', '*Giveaway has ended.*'].join('\n'))
    .setFooter({ text: 'Giveaway ended' }).setTimestamp();
  const disRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('giveaway:enter').setLabel('🎉 Ended').setStyle(ButtonStyle.Secondary).setDisabled(true), new ButtonBuilder().setCustomId('giveaway:count').setLabel(`${gw.entries.length} entries`).setStyle(ButtonStyle.Secondary).setDisabled(true));
  if (msg) await msg.edit({ embeds: [endEmbed], components: [disRow] });
  if (winners.length > 0) await channel.send({ content: winners.map(id => `<@${id}>`).join(' '), embeds: [new EmbedBuilder().setColor(0xff6bff).setTitle('🎉 Congratulations!').setDescription(`You won **${gw.prize}**!\nContact <@${gw.hostId}> to claim.`).setTimestamp()] });
  else await channel.send({ content: '😢 No one entered. No winners!' });
  return `✅ Ended. Winner(s): ${winnersText}`;
}

const GIVEAWAY = {
  data: new SlashCommandBuilder().setName('giveaway').setDescription('Manage giveaways')
    .addSubcommand(s => s.setName('start').setDescription('Start a giveaway')
      .addStringOption(o => o.setName('prize').setDescription('Prize').setRequired(true))
      .addStringOption(o => o.setName('duration').setDescription('Duration e.g. 1h, 30m').setRequired(true))
      .addIntegerOption(o => o.setName('winners').setDescription('Number of winners').setRequired(true).setMinValue(1).setMaxValue(20))
      .addChannelOption(o => o.setName('channel').setDescription('Channel to post in'))
      .addStringOption(o => o.setName('description').setDescription('Extra description')))
    .addSubcommand(s => s.setName('end').setDescription('End a giveaway early').addStringOption(o => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true)))
    .addSubcommand(s => s.setName('reroll').setDescription('Reroll winners').addStringOption(o => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true)).addIntegerOption(o => o.setName('winners').setDescription('Winners to reroll').setMinValue(1))),
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'start') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const prize = interaction.options.getString('prize'); const durationStr = interaction.options.getString('duration');
      const winnerCount = interaction.options.getInteger('winners'); const channel = interaction.options.getChannel('channel') || interaction.channel;
      const description = interaction.options.getString('description') || '';
      const seconds = parseDuration(durationStr); if (!seconds) return interaction.editReply({ content: '❌ Invalid duration. Use: 1h, 30m, 2d, 60s' });
      const endsAt = Math.floor(Date.now() / 1000) + seconds;
      const embed = new EmbedBuilder().setColor(0xff6bff).setTitle(`🎉 GIVEAWAY — ${prize}`)
        .setDescription([description ? `${description}\n` : '', `> 🏆 **Prize:** ${prize}`, `> 👥 **Winners:** ${winnerCount}`, `> ⏰ **Ends:** <t:${endsAt}:R>`, `> 🎟️ **Host:** ${interaction.user}`, '', '━━━━━━━━━━━━━━━━━━━━━━━', '**Press 🎉 to enter!**'].filter(Boolean).join('\n'))
        .setFooter({ text: `${winnerCount} winner(s) • Ends` }).setTimestamp(new Date(endsAt * 1000));
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('giveaway:enter').setLabel('🎉 Enter Giveaway').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('giveaway:count').setLabel('0 entries').setStyle(ButtonStyle.Secondary).setDisabled(true));
      const msg = await channel.send({ embeds: [embed], components: [row] });
      const giveaways = loadJSON('giveaways.json', {}); giveaways[msg.id] = { messageId: msg.id, channelId: channel.id, guildId: interaction.guildId, prize, winnerCount, endsAt, hostId: interaction.user.id, entries: [], ended: false }; saveJSON('giveaways.json', giveaways);
      setTimeout(() => endGiveaway(msg.id, client), seconds * 1000);
      await interaction.editReply({ content: `✅ Giveaway started in ${channel}!` });
    }
    if (sub === 'end') { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); await interaction.editReply({ content: await endGiveaway(interaction.options.getString('message_id'), client) }); }
    if (sub === 'reroll') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const giveaways = loadJSON('giveaways.json', {}); const gw = giveaways[interaction.options.getString('message_id')];
      if (!gw) return interaction.editReply({ content: '❌ Not found.' }); if (!gw.ended) return interaction.editReply({ content: '❌ Not ended yet.' }); if (gw.entries.length === 0) return interaction.editReply({ content: '❌ No entries.' });
      const count = interaction.options.getInteger('winners') || 1; const winners = pickWinners(gw.entries, Math.min(count, gw.entries.length));
      const ch = await client.channels.fetch(gw.channelId).catch(() => null);
      if (ch) await ch.send({ embeds: [new EmbedBuilder().setColor(0xff6bff).setTitle('🔄 Rerolled!').setDescription(`**Prize:** ${gw.prize}\n\n🏆 **New Winners:**\n${winners.map(id => `<@${id}>`).join(', ')}\n\nCongratulations! 🎉`).setTimestamp()] });
      await interaction.editReply({ content: `✅ Rerolled! Winners: ${winners.map(id => `<@${id}>`).join(', ')}` });
    }
  },
  async handleButton(interaction) {
    const action = interaction.customId.split(':')[1];
    if (action === 'enter') {
      const giveaways = loadJSON('giveaways.json', {}); const gw = giveaways[interaction.message.id];
      if (!gw) return interaction.reply({ content: '❌ Not found.', flags: MessageFlags.Ephemeral });
      if (gw.ended) return interaction.reply({ content: '❌ Already ended.', flags: MessageFlags.Ephemeral });
      const uid = interaction.user.id;
      if (gw.entries.includes(uid)) { gw.entries = gw.entries.filter(id => id !== uid); saveJSON('giveaways.json', giveaways); await interaction.update({ components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('giveaway:enter').setLabel('🎉 Enter Giveaway').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('giveaway:count').setLabel(`${gw.entries.length} entries`).setStyle(ButtonStyle.Secondary).setDisabled(true))] }); await interaction.followUp({ content: '↩️ You left the giveaway.', flags: MessageFlags.Ephemeral }); }
      else { gw.entries.push(uid); saveJSON('giveaways.json', giveaways); await interaction.update({ components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('giveaway:enter').setLabel('🎉 Enter Giveaway').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('giveaway:count').setLabel(`${gw.entries.length} entries`).setStyle(ButtonStyle.Secondary).setDisabled(true))] }); await interaction.followUp({ content: '✅ Entered! Good luck 🎉', flags: MessageFlags.Ephemeral }); }
    }
  },
};

const TICKET = {
  data: new SlashCommandBuilder().setName('ticket').setDescription('Ticket system')
    .addSubcommand(s => s.setName('setup').setDescription('Setup ticket panel')
      .addChannelOption(o => o.setName('channel').setDescription('Panel channel').setRequired(true))
      .addStringOption(o => o.setName('title').setDescription('Panel title').setRequired(true))
      .addStringOption(o => o.setName('description').setDescription('Panel description').setRequired(true))
      .addStringOption(o => o.setName('category_id').setDescription('Category ID for tickets').setRequired(true))
      .addRoleOption(o => o.setName('support_role').setDescription('Support role').setRequired(true))
      .addStringOption(o => o.setName('color').setDescription('Embed color e.g. #5865f2'))
      .addStringOption(o => o.setName('button_label').setDescription('Button label')))
    .addSubcommand(s => s.setName('close').setDescription('Close this ticket').addStringOption(o => o.setName('reason').setDescription('Reason')))
    .addSubcommand(s => s.setName('add').setDescription('Add user to ticket').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove user from ticket').addUserOption(o => o.setName('user').setDescription('User').setRequired(true))),
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'setup') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const channel = interaction.options.getChannel('channel'); const title = interaction.options.getString('title'); const description = interaction.options.getString('description');
      const categoryId = interaction.options.getString('category_id'); const supportRole = interaction.options.getRole('support_role');
      const color = parseInt((interaction.options.getString('color') || '#5865f2').replace('#', ''), 16) || 0x5865f2;
      const buttonLabel = interaction.options.getString('button_label') || '🎫 Open a Ticket';
      const category = await interaction.guild.channels.fetch(categoryId).catch(() => null);
      if (!category || category.type !== ChannelType.GuildCategory) return interaction.editReply({ content: '❌ Invalid category ID.' });
      const msg = await channel.send({ embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setFooter({ text: interaction.guild.name, iconURL: interaction.guild.iconURL() }).setTimestamp()], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket:open').setLabel(buttonLabel).setStyle(ButtonStyle.Primary))] });
      const data = loadJSON('tickets.json', { configs: {}, tickets: {} }); data.configs[interaction.guildId] = { panelMessageId: msg.id, panelChannelId: channel.id, categoryId, supportRoleId: supportRole.id, color }; saveJSON('tickets.json', data);
      await interaction.editReply({ content: `✅ Ticket panel sent in ${channel}!` });
    }
    if (sub === 'close') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const reason = interaction.options.getString('reason') || 'No reason'; const data = loadJSON('tickets.json', { configs: {}, tickets: {} }); const ticket = data.tickets[interaction.channelId];
      if (!ticket) return interaction.editReply({ content: '❌ Not a ticket channel.' });
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xff3232).setTitle('🔒 Ticket Closing').setDescription(`**Reason:** ${reason}\n\nDeleting in **5 seconds**.`).setTimestamp()] });
      ticket.closed = true; saveJSON('tickets.json', data);
      setTimeout(async () => { await interaction.channel.delete().catch(() => {}); const d = loadJSON('tickets.json', { configs: {}, tickets: {} }); delete d.tickets[interaction.channelId]; saveJSON('tickets.json', d); }, 5000);
    }
    if (sub === 'add') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }); const user = interaction.options.getUser('user');
      const data = loadJSON('tickets.json', { configs: {}, tickets: {} }); if (!data.tickets[interaction.channelId]) return interaction.editReply({ content: '❌ Not a ticket channel.' });
      await interaction.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
      await interaction.editReply({ content: `✅ Added ${user} to ticket.` });
    }
    if (sub === 'remove') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }); const user = interaction.options.getUser('user');
      const data = loadJSON('tickets.json', { configs: {}, tickets: {} }); if (!data.tickets[interaction.channelId]) return interaction.editReply({ content: '❌ Not a ticket channel.' });
      await interaction.channel.permissionOverwrites.edit(user.id, { ViewChannel: false });
      await interaction.editReply({ content: `✅ Removed ${user} from ticket.` });
    }
  },
  async handleButton(interaction) {
    const action = interaction.customId.split(':')[1];
    if (action === 'open') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const data = loadJSON('tickets.json', { configs: {}, tickets: {} }); const config = data.configs[interaction.guildId];
      if (!config) return interaction.editReply({ content: '❌ Ticket system not configured.' });
      const existing = Object.values(data.tickets || {}).find(t => t.userId === interaction.user.id && t.guildId === interaction.guildId && !t.closed);
      if (existing) return interaction.editReply({ content: `❌ You already have a ticket: <#${existing.channelId}>` });
      const num = Object.keys(data.tickets || {}).length + 1;
      const channel = await interaction.guild.channels.create({ name: `ticket-${String(num).padStart(4, '0')}`, type: ChannelType.GuildText, parent: config.categoryId, permissionOverwrites: [{ id: interaction.guildId, deny: [PermissionFlagsBits.ViewChannel] }, { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }, { id: config.supportRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }] });
      if (!data.tickets) data.tickets = {}; data.tickets[channel.id] = { channelId: channel.id, userId: interaction.user.id, guildId: interaction.guildId, createdAt: Date.now(), closed: false }; saveJSON('tickets.json', data);
      await channel.send({ content: `${interaction.user} <@&${config.supportRoleId}>`, embeds: [new EmbedBuilder().setColor(config.color || 0x5865f2).setTitle(`🎫 Ticket #${String(num).padStart(4, '0')}`).setDescription(`Welcome ${interaction.user}!\n\nDescribe your issue.\n\n━━━━━━━━━━━━━━━━━━━━━━━`).addFields({ name: '👤 Opened by', value: `${interaction.user}`, inline: true }, { name: '📅 Opened at', value: `<t:${Math.floor(Date.now() / 1000)}:f>`, inline: true }).setFooter({ text: 'Use /ticket close to close' }).setTimestamp()], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket:closebutton').setLabel('🔒 Close Ticket').setStyle(ButtonStyle.Danger))] });
      await interaction.editReply({ content: `✅ Ticket created: ${channel}` });
    }
    if (action === 'closebutton') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }); const data = loadJSON('tickets.json', { configs: {}, tickets: {} }); const ticket = data.tickets[interaction.channelId];
      if (!ticket) return interaction.editReply({ content: '❌ Ticket not found.' });
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xff3232).setTitle('🔒 Ticket Closing').setDescription('Deleting in **5 seconds**.').setTimestamp()] });
      ticket.closed = true; saveJSON('tickets.json', data);
      setTimeout(async () => { await interaction.channel.delete().catch(() => {}); const d = loadJSON('tickets.json', { configs: {}, tickets: {} }); delete d.tickets[interaction.channelId]; saveJSON('tickets.json', d); }, 5000);
    }
  },
};

const UPDATELOG = {
  data: new SlashCommandBuilder().setName('updatelog').setDescription('Post a formatted update log')
    .addStringOption(o => o.setName('game').setDescription('Game name').setRequired(true))
    .addStringOption(o => o.setName('version').setDescription('Version e.g. BETA').setRequired(true))
    .addStringOption(o => o.setName('type').setDescription('Update type').setRequired(true).addChoices({ name: '🟢 Full Release', value: 'release' }, { name: '🔵 Beta', value: 'beta' }, { name: '🟡 Patch', value: 'patch' }, { name: '🔴 Hotfix', value: 'hotfix' }, { name: '⚪ Alpha', value: 'alpha' }))
    .addStringOption(o => o.setName('tier').setDescription('Tier').setRequired(true).addChoices({ name: '👑 Premium', value: 'premium' }, { name: '🌐 Free', value: 'free' }, { name: '🔓 Free & Premium', value: 'both' }))
    .addStringOption(o => o.setName('changes').setDescription('Changes separated by |').setRequired(true))
    .addStringOption(o => o.setName('banner_url').setDescription('Banner image URL'))
    .addStringOption(o => o.setName('screenshot_url').setDescription('Screenshot URL'))
    .addStringOption(o => o.setName('channel').setDescription('Channel ID to post in'))
    .addStringOption(o => o.setName('ping_role').setDescription('Role ID to ping'))
    .addStringOption(o => o.setName('notes').setDescription('Additional notes')),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const typeMap = { release: { label: 'Released!! 🟢', color: 0x00cc66 }, beta: { label: 'BETA (Released!!)', color: 0x5865f2 }, patch: { label: 'Patch Released!!', color: 0xffcc00 }, hotfix: { label: 'Hotfix Released!!', color: 0xff3232 }, alpha: { label: 'Alpha Build', color: 0x888888 } };
    const tierMap = { premium: '⚠️ **PREMIUM VERSION ONLY** ⚠️', free: '✅ **FREE VERSION** ✅', both: '🌐 **FREE & PREMIUM** 🌐' };
    const game = interaction.options.getString('game'); const version = interaction.options.getString('version');
    const { label, color } = typeMap[interaction.options.getString('type')]; const tierLabel = tierMap[interaction.options.getString('tier')];
    const changes = interaction.options.getString('changes').split('|').map(c => c.trim()).filter(Boolean).map(c => `○  ${c}`).join('\n');
    const notes = interaction.options.getString('notes'); const bannerUrl = interaction.options.getString('banner_url'); const screenshotUrl = interaction.options.getString('screenshot_url');
    const channelInput = interaction.options.getString('channel'); const pingRoleId = interaction.options.getString('ping_role');
    const desc = ['*(INFORMATION)*', `🏆 **Game:** \`${game}\``, `🔧 **Version:** \`${version}\``, `📦 **Patch:** \`${label}\``, '', '━━━━━━━━━━━━━━━━━━━━━━━', '', tierLabel, '', '━━━━━━━━━━━━━━━━━━━━━━━', '', changes];
    if (notes) desc.push('', '━━━━━━━━━━━━━━━━━━━━━━━', '', `🔔 ${notes}`);
    const embed = new EmbedBuilder().setColor(color).setTitle(`📋 UPDATE LOG — ${game}`).setDescription(desc.join('\n')).setTimestamp();
    if (bannerUrl) embed.setImage(bannerUrl);
    let targetChannel = interaction.channel;
    if (channelInput) { const ch = await interaction.guild.channels.fetch(channelInput.replace(/[<#>]/g, '')).catch(() => null); if (ch) targetChannel = ch; }
    const embeds = [embed]; if (screenshotUrl) embeds.push(new EmbedBuilder().setColor(color).setImage(screenshotUrl));
    await targetChannel.send({ content: pingRoleId ? `<@&${pingRoleId.replace(/[<@&>]/g, '')}>` : undefined, embeds });
    await interaction.editReply({ content: `✅ Update log posted in ${targetChannel}!` });
  },
};

function emptyULBSession() { return { game: null, version: null, patchStatus: 'Released!!', tier: 'premium', changes: [], notes: null, bannerUrl: null, screenshotUrl: null, channelId: null, pingRoleId: null }; }
const tierLabelMap = { premium: '⚠️ **PREMIUM VERSION ONLY** ⚠️', free: '✅ **FREE VERSION** ✅', both: '🌐 **FREE & PREMIUM** 🌐' };
const tierColorMap = { premium: 0xff6bff, free: 0x00cc66, both: 0x5865f2 };
function buildULBPreview(s) {
  const desc = ['*(INFORMATION)*', `🏆 **Game:** \`${s.game || 'Not set'}\``, `🔧 **Version:** \`${s.version || 'Not set'}\``, `📦 **Patch:** \`${s.patchStatus}\``, '', '━━━━━━━━━━━━━━━━━━━━━━━', '', tierLabelMap[s.tier] || tierLabelMap.premium, '', '━━━━━━━━━━━━━━━━━━━━━━━', '', s.changes.length > 0 ? s.changes.map(c => `○  ${c}`).join('\n') : '*(No changes)*'];
  if (s.notes) desc.push('', '━━━━━━━━━━━━━━━━━━━━━━━', '', `🔔 ${s.notes}`);
  const e = new EmbedBuilder().setColor(tierColorMap[s.tier] || 0x00cc66).setTitle(`📋 UPDATE LOG${s.game ? ` — ${s.game}` : ''}`).setDescription(desc.join('\n')).setTimestamp();
  if (s.bannerUrl) e.setImage(s.bannerUrl); return e;
}
function buildULBStatus(s) {
  return new EmbedBuilder().setColor(0x5865f2).setTitle('📋 Update Log Builder')
    .setDescription([`**Game:** ${s.game || '*(not set)*'}`, `**Version:** ${s.version || '*(not set)*'}`, `**Patch:** \`${s.patchStatus}\``, `**Tier:** ${s.tier}`, `**Changes:** ${s.changes.length}`, `**Notes:** ${s.notes || '*(none)*'}`, `**Banner:** ${s.bannerUrl ? '✅ Uploaded' : '*(not uploaded)*'}`, `**Screenshot:** ${s.screenshotUrl ? '✅ Uploaded' : '*(not uploaded)*'}`, `**Channel:** ${s.channelId ? `<#${s.channelId}>` : '*(current channel)*'}`, `**Ping Role:** ${s.pingRoleId ? `<@&${s.pingRoleId}>` : '*(none)*'}`].join('\n'))
    .setFooter({ text: 'Fill required fields then Send' });
}
function buildULBControls() {
  return [
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('updatelogbuilder:setgame').setLabel('🏆 Game').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('updatelogbuilder:setversion').setLabel('🔧 Version').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('updatelogbuilder:setstatus').setLabel('📦 Patch Status').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('updatelogbuilder:settier').setLabel('🎖️ Tier').setStyle(ButtonStyle.Primary)),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('updatelogbuilder:addchange').setLabel('➕ Add Change').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('updatelogbuilder:clearchanges').setLabel('🗑️ Clear Changes').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('updatelogbuilder:setnotes').setLabel('🔔 Notes').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('updatelogbuilder:setbanner').setLabel('🖼️ Banner').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('updatelogbuilder:setscreenshot').setLabel('📷 Screenshot').setStyle(ButtonStyle.Secondary)),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('updatelogbuilder:setchannel').setLabel('📢 Channel').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('updatelogbuilder:setping').setLabel('🔔 Ping Role').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('updatelogbuilder:preview').setLabel('👁️ Preview').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('updatelogbuilder:send').setLabel('🚀 Send').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('updatelogbuilder:reset').setLabel('🔄 Reset').setStyle(ButtonStyle.Danger)),
  ];
}

const UPDATELOGBUILDER = {
  data: new SlashCommandBuilder().setName('updatelogbuilder').setDescription('Interactively build an update log'),
  async execute(interaction) { updatelogSessions.set(interaction.user.id, emptyULBSession()); const s = updatelogSessions.get(interaction.user.id); await interaction.reply({ embeds: [buildULBStatus(s)], components: buildULBControls(), flags: MessageFlags.Ephemeral }); },
  async handleButton(interaction) {
    const action = interaction.customId.split(':')[1]; let s = updatelogSessions.get(interaction.user.id); if (!s) { s = emptyULBSession(); updatelogSessions.set(interaction.user.id, s); }
    const modalMap = { setgame: ['Set Game', 'game', 'e.g. Wizard Alchemy', TextInputStyle.Short], setversion: ['Set Version', 'version', 'e.g. BETA', TextInputStyle.Short], setstatus: ['Set Patch Status', 'status', 'e.g. Released!!', TextInputStyle.Short], addchange: ['Add Change', 'change', 'Describe the change...', TextInputStyle.Paragraph], setnotes: ['Set Notes', 'notes', 'Additional notes...', TextInputStyle.Paragraph], setping: ['Set Ping Role ID', 'pingrole', 'Role ID', TextInputStyle.Short] };
    if (modalMap[action]) { const [title, inputId, placeholder, style] = modalMap[action]; return interaction.showModal(new ModalBuilder().setCustomId(`updatelogbuilder:modal:${action}`).setTitle(title).addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(inputId).setLabel(title).setStyle(style).setPlaceholder(placeholder).setRequired(true)))); }
    if (action === 'setbanner') {
      ulbImageWaiting.set(interaction.user.id, { type: 'banner', channelId: interaction.channelId });
      setTimeout(() => ulbImageWaiting.delete(interaction.user.id), 60000);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xffcc00).setTitle('🖼️ Upload Banner Image').setDescription('Send your **banner image** in this channel now.\n\n• Upload from phone gallery or PC\n• You have **60 seconds**\n• Just send it as a normal message').setFooter({ text: 'Waiting for your image...' })], flags: MessageFlags.Ephemeral });
    }
    if (action === 'setscreenshot') {
      ulbImageWaiting.set(interaction.user.id, { type: 'screenshot', channelId: interaction.channelId });
      setTimeout(() => ulbImageWaiting.delete(interaction.user.id), 60000);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xffcc00).setTitle('📷 Upload Screenshot Image').setDescription('Send your **screenshot image** in this channel now.\n\n• Upload from phone gallery or PC\n• You have **60 seconds**\n• Just send it as a normal message').setFooter({ text: 'Waiting for your image...' })], flags: MessageFlags.Ephemeral });
    }
    if (action === 'setchannel') {
      const channels = interaction.guild.channels.cache.filter(c => c.type === ChannelType.GuildText).first(25);
      const options = channels.map(c => ({ label: `# ${c.name}`, value: c.id }));
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📢 Select Channel').setDescription('Choose where to send the update log.\nIf you skip, it sends in **this channel**.')], components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('updatelogbuilder:channelselect').setPlaceholder('Select a channel...').addOptions(options))], flags: MessageFlags.Ephemeral });
    }
    if (action === 'settier') return interaction.reply({ content: 'Select tier:', components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('updatelogbuilder:selecttier').setPlaceholder('Select tier...').addOptions([{ label: '👑 Premium Only', value: 'premium', description: 'PREMIUM VERSION ONLY' }, { label: '🌐 Free Only', value: 'free', description: 'FREE VERSION' }, { label: '🔓 Free & Premium', value: 'both', description: 'FREE & PREMIUM' }]))], flags: MessageFlags.Ephemeral });
    if (action === 'clearchanges') { s.changes = []; return interaction.update({ embeds: [buildULBStatus(s)], components: buildULBControls() }); }
    if (action === 'preview') { const embeds = [buildULBPreview(s)]; if (s.screenshotUrl) embeds.push(new EmbedBuilder().setColor(tierColorMap[s.tier] || 0x00cc66).setImage(s.screenshotUrl)); return interaction.reply({ content: '👁️ Preview:', embeds, flags: MessageFlags.Ephemeral }); }
    if (action === 'reset') { updatelogSessions.set(interaction.user.id, emptyULBSession()); return interaction.update({ embeds: [buildULBStatus(updatelogSessions.get(interaction.user.id))], components: buildULBControls() }); }
    if (action === 'send') {
      if (!s.game || !s.version) return interaction.reply({ content: '❌ Game and Version required.', flags: MessageFlags.Ephemeral });
      const ch = s.channelId ? await interaction.guild.channels.fetch(s.channelId).catch(() => null) : interaction.channel;
      if (!ch) return interaction.reply({ content: '❌ Channel not found.', flags: MessageFlags.Ephemeral });
      const embeds = [buildULBPreview(s)]; if (s.screenshotUrl) embeds.push(new EmbedBuilder().setColor(tierColorMap[s.tier] || 0x00cc66).setImage(s.screenshotUrl));
      await ch.send({ content: s.pingRoleId ? `<@&${s.pingRoleId}>` : undefined, embeds }); updatelogSessions.delete(interaction.user.id);
      return interaction.update({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('✅ Sent!').setDescription(`Posted in ${ch}.`)], components: [] });
    }
  },
  async handleSelect(interaction) {
    const action = interaction.customId.split(':')[1]; let s = updatelogSessions.get(interaction.user.id); if (!s) return interaction.reply({ content: '❌ Session expired.', flags: MessageFlags.Ephemeral });
    if (action === 'selecttier') { s.tier = interaction.values[0]; return interaction.update({ embeds: [buildULBStatus(s)], components: buildULBControls() }); }
    if (action === 'channelselect') { s.channelId = interaction.values[0]; return interaction.update({ embeds: [buildULBStatus(s)], components: buildULBControls() }); }
  },
  async handleModal(interaction) {
    const action = interaction.customId.split(':')[2]; let s = updatelogSessions.get(interaction.user.id); if (!s) return interaction.reply({ content: '❌ Session expired.', flags: MessageFlags.Ephemeral });
    if (action === 'setgame') s.game = interaction.fields.getTextInputValue('game');
    if (action === 'setversion') s.version = interaction.fields.getTextInputValue('version');
    if (action === 'setstatus') s.patchStatus = interaction.fields.getTextInputValue('status');
    if (action === 'addchange') interaction.fields.getTextInputValue('change').split('\n').map(l => l.trim()).filter(Boolean).forEach(l => s.changes.push(l));
    if (action === 'setnotes') s.notes = interaction.fields.getTextInputValue('notes');
    if (action === 'setping') s.pingRoleId = interaction.fields.getTextInputValue('pingrole').replace(/[<@&>]/g, '');
    await interaction.update({ embeds: [buildULBStatus(s)], components: buildULBControls() });
  },
};

function emptyEBSession(userId) { return { userId, title: null, description: null, color: 0x5865f2, footer: null, imageUrl: null, thumbnailUrl: null, author: null, fields: [], timestamp: false, channelId: null }; }
function buildEBPreview(s) { const e = new EmbedBuilder().setColor(s.color); if (s.title) e.setTitle(s.title); if (s.description) e.setDescription(s.description); if (s.footer) e.setFooter({ text: s.footer }); if (s.imageUrl) e.setImage(s.imageUrl); if (s.thumbnailUrl) e.setThumbnail(s.thumbnailUrl); if (s.author) e.setAuthor({ name: s.author }); if (s.timestamp) e.setTimestamp(); for (const f of s.fields) e.addFields(f); return e; }
function buildEBStatus(s) { return new EmbedBuilder().setColor(0x5865f2).setTitle('🛠️ Embed Builder').setDescription([`**Title:** ${s.title || '*(not set)*'}`, `**Description:** ${s.description ? s.description.slice(0, 50) + '...' : '*(not set)*'}`, `**Color:** \`#${s.color.toString(16).padStart(6, '0')}\``, `**Footer:** ${s.footer || '*(not set)*'}`, `**Author:** ${s.author || '*(not set)*'}`, `**Image:** ${s.imageUrl ? '✅' : '*(not set)*'}`, `**Thumbnail:** ${s.thumbnailUrl ? '✅' : '*(not set)*'}`, `**Fields:** ${s.fields.length}`, `**Timestamp:** ${s.timestamp ? '✅' : 'No'}`, `**Channel:** ${s.channelId ? `<#${s.channelId}>` : '*(not set)*'}`].join('\n')).setFooter({ text: 'Use buttons to edit' }); }
function buildEBControls(s) { return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('embedbuilder:settitle').setLabel('📝 Title').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('embedbuilder:setdesc').setLabel('📄 Description').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('embedbuilder:setcolor').setLabel('🎨 Color').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('embedbuilder:setfooter').setLabel('📎 Footer').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('embedbuilder:setauthor').setLabel('✍️ Author').setStyle(ButtonStyle.Secondary)), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('embedbuilder:setimage').setLabel('🖼️ Image').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('embedbuilder:setthumbnail').setLabel('🖼️ Thumbnail').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('embedbuilder:addfield').setLabel('➕ Field').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('embedbuilder:togglets').setLabel(s.timestamp ? '🕐 TS: ON' : '🕐 TS: OFF').setStyle(s.timestamp ? ButtonStyle.Success : ButtonStyle.Secondary)), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('embedbuilder:setchannel').setLabel(`📢 Channel: ${s.channelId ? '✅ Selected' : 'Current Channel'}`).setStyle(s.channelId ? ButtonStyle.Success : ButtonStyle.Secondary), new ButtonBuilder().setCustomId('embedbuilder:preview').setLabel('👁️ Preview').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('embedbuilder:send').setLabel('🚀 Send').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('embedbuilder:reset').setLabel('🗑️ Reset').setStyle(ButtonStyle.Danger))]; }

const EMBEDBUILDER = {
  data: new SlashCommandBuilder().setName('embedbuilder').setDescription('Interactively build and send a custom embed'),
  async execute(interaction) { embedSessions.set(interaction.user.id, emptyEBSession(interaction.user.id)); const s = embedSessions.get(interaction.user.id); await interaction.reply({ embeds: [buildEBStatus(s)], components: buildEBControls(s), flags: MessageFlags.Ephemeral }); },
  async handleButton(interaction) {
    const action = interaction.customId.split(':')[1]; let s = embedSessions.get(interaction.user.id); if (!s) { s = emptyEBSession(interaction.user.id); embedSessions.set(interaction.user.id, s); }
    const modalMap = { settitle: ['Set Title', 'title', 'Enter title...', TextInputStyle.Short], setdesc: ['Set Description', 'description', 'Enter description...', TextInputStyle.Paragraph], setcolor: ['Set Color', 'color', '#ff6bff', TextInputStyle.Short], setfooter: ['Set Footer', 'footer', 'Footer text...', TextInputStyle.Short], setauthor: ['Set Author', 'author', 'Author name...', TextInputStyle.Short], setimage: ['Set Image URL', 'image', 'https://...', TextInputStyle.Short], setthumbnail: ['Set Thumbnail URL', 'thumbnail', 'https://...', TextInputStyle.Short], addfield: ['Add Field', 'field', 'Name | Value | yes/no', TextInputStyle.Paragraph] };
    if (modalMap[action]) { const [title, inputId, placeholder, style] = modalMap[action]; return interaction.showModal(new ModalBuilder().setCustomId(`embedbuilder:modal:${action}`).setTitle(title).addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(inputId).setLabel(title).setStyle(style).setPlaceholder(placeholder).setRequired(true)))); }
    if (action === 'setchannel') {
      const channels = interaction.guild.channels.cache.filter(c => c.type === ChannelType.GuildText).first(25);
      const options = channels.map(c => ({ label: `# ${c.name}`, value: c.id }));
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📢 Select Channel').setDescription('Choose where to send the embed.\nIf you skip this, it will be sent in **this channel**.')], components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('embedbuilder:channelselect').setPlaceholder('Select a channel...').addOptions(options))], flags: MessageFlags.Ephemeral });
    }
    if (action === 'togglets') { s.timestamp = !s.timestamp; return interaction.update({ embeds: [buildEBStatus(s)], components: buildEBControls(s) }); }
    if (action === 'preview') return interaction.reply({ content: '👁️ Preview:', embeds: [buildEBPreview(s)], flags: MessageFlags.Ephemeral });
    if (action === 'reset') { embedSessions.set(interaction.user.id, emptyEBSession(interaction.user.id)); const f = embedSessions.get(interaction.user.id); return interaction.update({ embeds: [buildEBStatus(f)], components: buildEBControls(f) }); }
    if (action === 'send') {
      if (!s.title && !s.description) return interaction.reply({ content: '❌ Add title or description.', flags: MessageFlags.Ephemeral });
      const ch = s.channelId ? await interaction.guild.channels.fetch(s.channelId).catch(() => null) : interaction.channel;
      if (!ch) return interaction.reply({ content: '❌ Channel not found.', flags: MessageFlags.Ephemeral });
      await ch.send({ embeds: [buildEBPreview(s)] }); embedSessions.delete(interaction.user.id);
      return interaction.update({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('✅ Embed Sent!').setDescription(`Sent to ${ch}.`)], components: [] });
    }
  },
  async handleModal(interaction) {
    const action = interaction.customId.split(':')[2]; let s = embedSessions.get(interaction.user.id); if (!s) return interaction.reply({ content: '❌ Session expired.', flags: MessageFlags.Ephemeral });
    if (action === 'settitle') s.title = interaction.fields.getTextInputValue('title');
    if (action === 'setdesc') s.description = interaction.fields.getTextInputValue('description');
    if (action === 'setfooter') s.footer = interaction.fields.getTextInputValue('footer');
    if (action === 'setauthor') s.author = interaction.fields.getTextInputValue('author');
    if (action === 'setimage') s.imageUrl = interaction.fields.getTextInputValue('image');
    if (action === 'setthumbnail') s.thumbnailUrl = interaction.fields.getTextInputValue('thumbnail');
    if (action === 'setcolor') { const p = parseInt(interaction.fields.getTextInputValue('color').replace('#', ''), 16); if (!isNaN(p)) s.color = p; }
    if (action === 'addfield') { const parts = interaction.fields.getTextInputValue('field').split('|').map(p => p.trim()); if (parts.length >= 2 && s.fields.length < 25) s.fields.push({ name: parts[0], value: parts[1], inline: parts[2]?.toLowerCase() === 'yes' }); }
    await interaction.update({ embeds: [buildEBStatus(s)], components: buildEBControls(s) });
  },
  async handleSelect(interaction) {
    const action = interaction.customId.split(':')[1];
    if (action === 'channelselect') {
      let s = embedSessions.get(interaction.user.id); if (!s) return interaction.reply({ content: '❌ Session expired.', flags: MessageFlags.Ephemeral });
      s.channelId = interaction.values[0];
      return interaction.update({ embeds: [buildEBStatus(s)], components: buildEBControls(s) });
    }
  },
};

const GETSCRIPT = {
  data: new SlashCommandBuilder().setName('getscript').setDescription('Browse and get scripts'),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const scripts = loadJSON('scripts.json', []);
    if (scripts.length === 0) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xff9900).setTitle('📭 No Scripts Available').setDescription('There are no scripts available right now.\nCheck back later or contact an admin to add scripts.').setFooter({ text: 'Use /setupgetscript to manage scripts' })] });
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📜 Script Library').setDescription(`**${scripts.length}** scripts available.`).setFooter({ text: 'Scripts are for educational purposes only.' })], components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('getscript:select').setPlaceholder('📜 Select a script...').addOptions(scripts.map(s => ({ label: s.name, description: s.description, value: s.id }))))] });
  },
  async handleSelect(interaction) {
    const scripts = loadJSON('scripts.json', []); const script = scripts.find(s => s.id === interaction.values[0]);
    if (!script) return interaction.update({ content: '❌ Not found.', embeds: [], components: [] });
    scriptSessions.set(interaction.user.id, script);
    await interaction.update({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(script.name).setDescription(`**Description:**\n> ${script.description}`).addFields({ name: 'Preview', value: `\`\`\`lua\n${script.code.slice(0, 500)}\n\`\`\`` }).setFooter({ text: 'Click Get Script to receive in DMs' })], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('getscript:get').setLabel('📥 Get Script').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('getscript:back').setLabel('◀️ Back').setStyle(ButtonStyle.Secondary))] });
  },
  async handleButton(interaction) {
    const part = interaction.customId.split(':')[1];
    if (part === 'get') {
      const script = scriptSessions.get(interaction.user.id); if (!script) return interaction.reply({ content: '❌ Session expired.', flags: MessageFlags.Ephemeral });
      try { await interaction.user.send({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle(`📜 ${script.name}`).setDescription(script.description).addFields({ name: 'Script', value: `\`\`\`lua\n${script.code}\n\`\`\`` }).setFooter({ text: 'Sent via Script Library' }).setTimestamp()] }); scriptSessions.delete(interaction.user.id); await interaction.update({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('✅ Script Sent!').setDescription('Check your DMs.')], components: [] }); }
      catch { await interaction.reply({ content: '❌ Could not DM you. Enable DMs from server members.', flags: MessageFlags.Ephemeral }); }
    }
    if (part === 'back') {
      scriptSessions.delete(interaction.user.id); const scripts = loadJSON('scripts.json', []);
      await interaction.update({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📜 Script Library').setDescription(`**${scripts.length}** scripts available.`).setFooter({ text: 'Educational purposes only.' })], components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('getscript:select').setPlaceholder('📜 Select a script...').addOptions(scripts.map(s => ({ label: s.name, description: s.description, value: s.id }))))] });
    }
  },
};

function buildSGSMain(scripts) { return new EmbedBuilder().setColor(0x5865f2).setTitle('📜 Script Manager').setDescription(scripts.length === 0 ? '> No scripts yet. Press **➕ Add Script**.' : scripts.map((s, i) => `**${i + 1}.** ${s.name}\n> ${s.description}`).join('\n\n')).setFooter({ text: `${scripts.length} script(s)` }); }
function buildSGSRows(scripts) { return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setupgetscript:add').setLabel('➕ Add Script').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('setupgetscript:edit').setLabel('✏️ Edit').setStyle(ButtonStyle.Primary).setDisabled(scripts.length === 0), new ButtonBuilder().setCustomId('setupgetscript:delete').setLabel('🗑️ Delete').setStyle(ButtonStyle.Danger).setDisabled(scripts.length === 0))]; }
function genScriptId() { return 'script_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

const SETUPGETSCRIPT = {
  data: new SlashCommandBuilder().setName('setupgetscript').setDescription('Manage scripts for /getscript').setDefaultMemberPermissions('0'),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.member.permissions.has('Administrator')) return interaction.editReply({ content: '❌ Administrators only.' });
    const scripts = loadJSON('scripts.json', []); await interaction.editReply({ embeds: [buildSGSMain(scripts)], components: buildSGSRows(scripts) });
  },
  async handleButton(interaction) {
    const action = interaction.customId.split(':')[1]; const scripts = loadJSON('scripts.json', []);
    if (action === 'add') return interaction.showModal(new ModalBuilder().setCustomId('setupgetscript:modal:add').setTitle('Add Script').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Script Name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('code').setLabel('Script Code').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(3900))));
    if (action === 'edit') { if (scripts.length === 0) return interaction.reply({ content: '❌ No scripts.', flags: MessageFlags.Ephemeral }); return interaction.update({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('✏️ Select Script to Edit')], components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('setupgetscript:selectedit').setPlaceholder('Select script...').addOptions(scripts.map(s => ({ label: s.name, description: s.description.slice(0, 50), value: s.id })))), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setupgetscript:back').setLabel('◀️ Back').setStyle(ButtonStyle.Secondary))] }); }
    if (action === 'delete') { if (scripts.length === 0) return interaction.reply({ content: '❌ No scripts.', flags: MessageFlags.Ephemeral }); return interaction.update({ embeds: [new EmbedBuilder().setColor(0xff3232).setTitle('🗑️ Select Script to Delete')], components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('setupgetscript:selectdelete').setPlaceholder('Select script...').addOptions(scripts.map(s => ({ label: s.name, description: s.description.slice(0, 50), value: s.id })))), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setupgetscript:back').setLabel('◀️ Back').setStyle(ButtonStyle.Secondary))] }); }
    if (action === 'back') { const f = loadJSON('scripts.json', []); return interaction.update({ embeds: [buildSGSMain(f)], components: buildSGSRows(f) }); }
    if (action === 'confirmdelete') { const id = scriptSessions.get(interaction.user.id + ':del'); if (!id) return interaction.reply({ content: '❌ Session expired.', flags: MessageFlags.Ephemeral }); saveJSON('scripts.json', scripts.filter(s => s.id !== id)); scriptSessions.delete(interaction.user.id + ':del'); return interaction.update({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('✅ Deleted')], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setupgetscript:back').setLabel('◀️ Back').setStyle(ButtonStyle.Secondary))] }); }
    if (action === 'canceldelete') { scriptSessions.delete(interaction.user.id + ':del'); const f = loadJSON('scripts.json', []); return interaction.update({ embeds: [buildSGSMain(f)], components: buildSGSRows(f) }); }
  },
  async handleSelect(interaction) {
    const action = interaction.customId.split(':')[1]; const scripts = loadJSON('scripts.json', []);
    if (action === 'selectedit') { const script = scripts.find(s => s.id === interaction.values[0]); if (!script) return interaction.reply({ content: '❌ Not found.', flags: MessageFlags.Ephemeral }); scriptSessions.set(interaction.user.id + ':edit', script.id); return interaction.showModal(new ModalBuilder().setCustomId('setupgetscript:modal:edit').setTitle('Edit Script').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Name').setStyle(TextInputStyle.Short).setValue(script.name).setRequired(true).setMaxLength(50)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Short).setValue(script.description).setRequired(true).setMaxLength(100)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('code').setLabel('Code').setStyle(TextInputStyle.Paragraph).setValue(script.code.slice(0, 3900)).setRequired(true).setMaxLength(3900)))); }
    if (action === 'selectdelete') { const script = scripts.find(s => s.id === interaction.values[0]); if (!script) return interaction.reply({ content: '❌ Not found.', flags: MessageFlags.Ephemeral }); scriptSessions.set(interaction.user.id + ':del', script.id); return interaction.update({ embeds: [new EmbedBuilder().setColor(0xff3232).setTitle('⚠️ Confirm Delete').setDescription(`Delete **${script.name}**? This cannot be undone.`)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setupgetscript:confirmdelete').setLabel('✅ Yes').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId('setupgetscript:canceldelete').setLabel('❌ Cancel').setStyle(ButtonStyle.Secondary))] }); }
  },
  async handleModal(interaction) {
    const action = interaction.customId.split(':')[2]; const scripts = loadJSON('scripts.json', []);
    if (action === 'add') { const name = interaction.fields.getTextInputValue('name'); const description = interaction.fields.getTextInputValue('description'); const code = interaction.fields.getTextInputValue('code'); scripts.push({ id: genScriptId(), name, description, code }); saveJSON('scripts.json', scripts); return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('✅ Script Added').addFields({ name: 'Name', value: name, inline: true }, { name: 'Description', value: description, inline: true }, { name: 'Preview', value: `\`\`\`lua\n${code.slice(0, 300)}\n\`\`\`` }).setTimestamp()], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setupgetscript:back').setLabel('◀️ Back').setStyle(ButtonStyle.Secondary))], flags: MessageFlags.Ephemeral }); }
    if (action === 'edit') { const id = scriptSessions.get(interaction.user.id + ':edit'); if (!id) return interaction.reply({ content: '❌ Session expired.', flags: MessageFlags.Ephemeral }); const idx = scripts.findIndex(s => s.id === id); if (idx === -1) return interaction.reply({ content: '❌ Not found.', flags: MessageFlags.Ephemeral }); scripts[idx] = { ...scripts[idx], name: interaction.fields.getTextInputValue('name'), description: interaction.fields.getTextInputValue('description'), code: interaction.fields.getTextInputValue('code') }; saveJSON('scripts.json', scripts); scriptSessions.delete(interaction.user.id + ':edit'); return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('✅ Script Updated')], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setupgetscript:back').setLabel('◀️ Back').setStyle(ButtonStyle.Secondary))], flags: MessageFlags.Ephemeral }); }
  },
};

function buildWelcomeEmbed(config) { return new EmbedBuilder().setColor(0x5865f2).setTitle('👋 Welcome Setup').setDescription([`**Channel:** ${config?.channelId ? `<#${config.channelId}>` : '*(not set)*'}`, `**Text:** ${config?.text ? `\`\`\`${config.text.slice(0, 80)}...\`\`\`` : '*(not set)*'}`, `**Image:** ${config?.imageUrl ? '✅ Set' : '*(not set)*'}`, `**Status:** ${config?.enabled ? '🟢 Active' : '🔴 Disabled'}`].join('\n')).setFooter({ text: 'Format: Text → @mention → Image' }); }
function buildWelcomeRows(config) { return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setupwelcome:setchannel').setLabel('📢 Channel').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('setupwelcome:settext').setLabel('📝 Text').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('setupwelcome:uploadimage').setLabel('🖼️ Upload Image').setStyle(ButtonStyle.Primary)), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setupwelcome:toggle').setLabel(config?.enabled ? '🔴 Disable' : '🟢 Enable').setStyle(config?.enabled ? ButtonStyle.Danger : ButtonStyle.Success), new ButtonBuilder().setCustomId('setupwelcome:test').setLabel('🧪 Test').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('setupwelcome:reset').setLabel('🗑️ Reset').setStyle(ButtonStyle.Danger))]; }
async function sendWelcome(channel, member, config) { const text = config.text.replace(/{user}/g, member.user.username).replace(/{server}/g, member.guild.name).replace(/{count}/g, member.guild.memberCount); await channel.send({ content: text }); await channel.send({ content: `${member}` }); if (config.imageUrl) await channel.send({ content: config.imageUrl }); }

const SETUPWELCOME = {
  data: new SlashCommandBuilder().setName('setupwelcome').setDescription('Setup welcome message').setDefaultMemberPermissions('0'),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.member.permissions.has('Administrator')) return interaction.editReply({ content: '❌ Administrators only.' });
    const config = loadJSON('welcome.json', {})[interaction.guildId];
    await interaction.editReply({ embeds: [buildWelcomeEmbed(config)], components: buildWelcomeRows(config) });
  },
  async handleButton(interaction) {
    const action = interaction.customId.split(':')[1]; const data = loadJSON('welcome.json', {}); if (!data[interaction.guildId]) data[interaction.guildId] = { enabled: false }; const config = data[interaction.guildId];
    if (action === 'setchannel') return interaction.showModal(new ModalBuilder().setCustomId('setupwelcome:modal:setchannel').setTitle('Set Channel').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('channel').setLabel('Channel ID').setStyle(TextInputStyle.Short).setPlaceholder('Right-click channel → Copy ID').setRequired(true))));
    if (action === 'settext') return interaction.showModal(new ModalBuilder().setCustomId('setupwelcome:modal:settext').setTitle('Set Welcome Text').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('text').setLabel('Text ({user} {server} {count})').setStyle(TextInputStyle.Paragraph).setPlaceholder('Welcome to {server}, {user}!').setValue(config.text || '').setRequired(true).setMaxLength(1800))));
    if (action === 'uploadimage') { waitingForImage.set(interaction.user.id, { guildId: interaction.guildId, channelId: interaction.channelId }); setTimeout(() => waitingForImage.delete(interaction.user.id), 60000); return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xffcc00).setTitle('🖼️ Upload Your Image').setDescription('Send your image in **this channel** now.\nYou have **60 seconds**.').setFooter({ text: 'Waiting...' })], flags: MessageFlags.Ephemeral }); }
    if (action === 'toggle') { config.enabled = !config.enabled; saveJSON('welcome.json', data); return interaction.update({ embeds: [new EmbedBuilder().setColor(config.enabled ? 0x00cc66 : 0xff3232).setTitle(config.enabled ? '🟢 Welcome Enabled' : '🔴 Welcome Disabled').setTimestamp()], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setupwelcome:back').setLabel('◀️ Back').setStyle(ButtonStyle.Secondary))] }); }
    if (action === 'test') { if (!config.channelId || !config.text) return interaction.reply({ content: '❌ Set channel and text first.', flags: MessageFlags.Ephemeral }); const ch = await interaction.guild.channels.fetch(config.channelId).catch(() => null); if (!ch) return interaction.reply({ content: '❌ Channel not found.', flags: MessageFlags.Ephemeral }); await sendWelcome(ch, interaction.member, config); return interaction.reply({ content: `✅ Test sent in ${ch}!`, flags: MessageFlags.Ephemeral }); }
    if (action === 'reset') { data[interaction.guildId] = { enabled: false }; saveJSON('welcome.json', data); return interaction.update({ embeds: [new EmbedBuilder().setColor(0xff3232).setTitle('🗑️ Reset').setDescription('Welcome config cleared.')], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setupwelcome:back').setLabel('◀️ Back').setStyle(ButtonStyle.Secondary))] }); }
    if (action === 'back') { const cfg = loadJSON('welcome.json', {})[interaction.guildId]; return interaction.update({ embeds: [buildWelcomeEmbed(cfg)], components: buildWelcomeRows(cfg) }); }
  },
  async handleModal(interaction) {
    const action = interaction.customId.split(':')[2]; const data = loadJSON('welcome.json', {}); if (!data[interaction.guildId]) data[interaction.guildId] = { enabled: false }; const config = data[interaction.guildId];
    if (action === 'setchannel') { const ch = await interaction.guild.channels.fetch(interaction.fields.getTextInputValue('channel').replace(/[<#>]/g, '')).catch(() => null); if (!ch) return interaction.reply({ content: '❌ Invalid channel.', flags: MessageFlags.Ephemeral }); config.channelId = ch.id; saveJSON('welcome.json', data); return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('✅ Channel Set').setDescription(`Welcome in ${ch}.`)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setupwelcome:back').setLabel('◀️ Back').setStyle(ButtonStyle.Secondary))], flags: MessageFlags.Ephemeral }); }
    if (action === 'settext') { config.text = interaction.fields.getTextInputValue('text'); saveJSON('welcome.json', data); return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('✅ Text Set').setDescription(`**Preview:**\n${config.text}`)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setupwelcome:back').setLabel('◀️ Back').setStyle(ButtonStyle.Secondary))], flags: MessageFlags.Ephemeral }); }
  },
  waitingForImage,
};

const SETUP = {
  data: new SlashCommandBuilder().setName('setup').setDescription('Configure command permissions').setDefaultMemberPermissions('0'),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.member.permissions.has('Administrator')) return interaction.editReply({ content: '❌ Administrators only.' });
    const commands = [...client.commands.keys()]; const currentSetup = getGuildSetup(interaction.guildId);
    const chunks = []; for (let i = 0; i < commands.length; i += 25) chunks.push(commands.slice(i, i + 25));
    const rows = chunks.map(chunk => new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('setup:selectcmds').setPlaceholder('📋 Select commands to configure...').setMinValues(1).setMaxValues(chunk.length).addOptions(chunk.map(cmd => ({ label: `/${cmd}`, description: currentSetup[cmd]?.length ? `🔒 ${currentSetup[cmd].length} role(s)` : '🌐 Everyone', value: cmd })))));
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('⚙️ Bot Setup').setDescription('Select **one or more commands** to configure together.\n\n🔒 **Restricted** — selected roles only\n🌐 **Open** — everyone\n\n> Changes apply instantly.').setFooter({ text: 'Administrator only' })], components: rows.slice(0, 5) });
  },
  async handleSelect(interaction) {
    const part = interaction.customId.split(':')[1];
    if (part === 'selectcmds') {
      const commands = interaction.values;
      const currentSetup = getGuildSetup(interaction.guildId);
      setupSessions.set(interaction.user.id, { commands });
      const desc = commands.map(cmd => { const roles = currentSetup[cmd] || []; return `**/${cmd}** — ${roles.length ? roles.map(r => `<@&${r}>`).join(', ') : '🌐 Everyone'}`; }).join('\n');
      return interaction.update({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`⚙️ Configure ${commands.length} Command(s)`).setDescription(`**Selected:**\n${desc}\n\nNow select which roles can use ${commands.length > 1 ? 'all these commands' : 'this command'}.`)], components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setup:selectroles').setPlaceholder('Select allowed roles...').setMinValues(0).setMaxValues(10)), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:clearroles').setLabel('🌐 Open to Everyone').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId('setup:back').setLabel('◀️ Back').setStyle(ButtonStyle.Secondary))] });
    }
    if (part === 'selectroles') {
      const session = setupSessions.get(interaction.user.id); if (!session) return;
      await interaction.deferUpdate();
      for (const command of session.commands) setCommandRoles(interaction.guildId, command, interaction.values);
      await syncCommandPermissions(interaction.guildId, [...client.commands.values()]); setupSessions.delete(interaction.user.id);
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('✅ Updated').addFields({ name: 'Commands', value: session.commands.map(c => `/${c}`).join(', '), inline: false }, { name: 'Roles', value: interaction.values.length ? interaction.values.map(r => `<@&${r}>`).join(', ') : 'Everyone' }).setDescription('Discord updated — commands hidden from unauthorized users.').setTimestamp()], components: [] });
    }
  },
  async handleButton(interaction) {
    const part = interaction.customId.split(':')[1];
    if (part === 'clearroles') { const session = setupSessions.get(interaction.user.id); if (!session) return; await interaction.deferUpdate(); for (const command of session.commands) setCommandRoles(interaction.guildId, command, []); await syncCommandPermissions(interaction.guildId, [...client.commands.values()]); setupSessions.delete(interaction.user.id); await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('✅ Cleared').setDescription(`**${session.commands.map(c => `/${c}`).join(', ')}** — open to everyone.`).setTimestamp()], components: [] }); }
    if (part === 'back') { setupSessions.delete(interaction.user.id); await SETUP.execute(Object.assign({}, interaction, { deferReply: async () => {}, editReply: async (d) => interaction.update(d) })); }
  },
};

const allCommands = [BAN, KICK, TIMEOUT, WARN, WARNINGS, UNBAN, PURGE, SLOWMODE, LOCK, USERINFO, SERVERINFO, AVATAR, BOTINFO, DMSALL, GIVEAWAY, TICKET, UPDATELOG, UPDATELOGBUILDER, EMBEDBUILDER, GETSCRIPT, SETUPGETSCRIPT, SETUPWELCOME, SETUP];
for (const cmd of allCommands) client.commands.set(cmd.data.name, cmd);

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = client.commands.get(interaction.commandName); if (!cmd) return;
      if (!hasPermission(interaction, interaction.commandName)) return interaction.reply({ content: '❌ No permission.', flags: MessageFlags.Ephemeral });
      await cmd.execute(interaction, client);
    }
    if (interaction.isStringSelectMenu()) { const cmd = client.commands.get(interaction.customId.split(':')[0]); if (cmd?.handleSelect) await cmd.handleSelect(interaction, client); }
    if (interaction.isButton()) { const cmd = client.commands.get(interaction.customId.split(':')[0]); if (cmd?.handleButton) await cmd.handleButton(interaction, client); }
    if (interaction.isModalSubmit()) { const cmd = client.commands.get(interaction.customId.split(':')[0]); if (cmd?.handleModal) await cmd.handleModal(interaction, client); }
    if (interaction.isRoleSelectMenu()) { const cmd = client.commands.get(interaction.customId.split(':')[0]); if (cmd?.handleSelect) await cmd.handleSelect(interaction, client); }
  } catch (err) {
    console.error(err);
    const payload = { content: '❌ An error occurred.', flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) interaction.followUp(payload).catch(() => {});
    else interaction.reply(payload).catch(() => {});
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  const config = loadJSON('welcome.json', {})[member.guild.id];
  if (!config?.enabled || !config.channelId || !config.text) return;
  const channel = await member.guild.channels.fetch(config.channelId).catch(() => null); if (!channel) return;
  await sendWelcome(channel, member, config);

  const cfg = loadJSON('antinuke.json', {})[member.guild.id];
  if (!cfg?.raid?.enabled) return;
  const guildId = member.guild.id; const now = Date.now(); const window = cfg.raid.window * 1000 || 10000; const threshold = cfg.raid.threshold || 5;
  if (!joinTracker.has(guildId)) joinTracker.set(guildId, []);
  const joins = joinTracker.get(guildId); joins.push(now);
  const recent = joins.filter(t => now - t < window); joinTracker.set(guildId, recent);
  if (recent.length >= threshold) {
    joinTracker.set(guildId, []);
    const members = await member.guild.members.fetch(); const newMembers = [...members.values()].filter(m => !m.user.bot && now - m.joinedTimestamp < window);
    for (const m of newMembers) { if (cfg.raid.action === 'ban') await m.ban({ reason: 'Anti-Raid' }).catch(() => {}); else await m.kick('Anti-Raid').catch(() => {}); }
    if (!lockdownGuilds.has(guildId)) {
      lockdownGuilds.add(guildId); const everyoneRole = member.guild.roles.everyone;
      await everyoneRole.setPermissions(everyoneRole.permissions.remove(['SendMessages', 'AddReactions', 'CreatePublicThreads'])).catch(() => {});
      if (cfg.logChannelId) { const logCh = await member.guild.channels.fetch(cfg.logChannelId).catch(() => null); if (logCh) await logCh.send({ embeds: [new EmbedBuilder().setColor(0xff3232).setTitle('🔒 ANTI-RAID LOCKDOWN').setDescription(`**Reason:** ${recent.length} joins in ${window / 1000}s\n\nServer locked.`).setTimestamp()] }).catch(() => {}); }
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const ulbSession = ulbImageWaiting.get(message.author.id);
  if (ulbSession && ulbSession.channelId === message.channelId) {
    const attachment = message.attachments.first();
    if (attachment && attachment.contentType?.startsWith('image/')) {
      ulbImageWaiting.delete(message.author.id);
      const s = updatelogSessions.get(message.author.id);
      if (s) {
        if (ulbSession.type === 'banner') s.bannerUrl = attachment.url;
        if (ulbSession.type === 'screenshot') s.screenshotUrl = attachment.url;
      }
      await message.delete().catch(() => {});
      const label = ulbSession.type === 'banner' ? '🖼️ Banner' : '📷 Screenshot';
      const msg = await message.channel.send({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle(`✅ ${label} Saved!`).setImage(attachment.url).setTimestamp()] });
      setTimeout(() => msg.delete().catch(() => {}), 10000);
      return;
    }
  }

  const session = waitingForImage.get(message.author.id); if (!session) return; if (session.channelId !== message.channelId) return;
  const attachment = message.attachments.first(); if (!attachment || !attachment.contentType?.startsWith('image/')) return;
  waitingForImage.delete(message.author.id);
  const data = loadJSON('welcome.json', {}); if (!data[session.guildId]) data[session.guildId] = { enabled: false }; data[session.guildId].imageUrl = attachment.url; saveJSON('welcome.json', data);
  await message.delete().catch(() => {});
  const msg = await message.channel.send({ embeds: [new EmbedBuilder().setColor(0x00cc66).setTitle('✅ Image Saved!').setImage(attachment.url).setTimestamp()], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setupwelcome:back').setLabel('◀️ Back to Setup').setStyle(ButtonStyle.Secondary))] });
  setTimeout(() => msg.delete().catch(() => {}), 15000);
});

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Online as ${c.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  const payload = allCommands.map(cmd => cmd.data.toJSON());
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: payload });
  console.log(`✅ Deployed ${payload.length} commands`);
});

client.login(process.env.TOKEN);
