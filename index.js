console.log("🚀 ClippingBase AI Running");

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder
} = require('discord.js');

const OpenAI = require('openai');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// =========================
// CONFIG & DATA TRACKING
// =========================
let whatsNewText = "Welcome! No new updates just yet. Stay tuned!"; 
const LOG_CHANNEL_ID = '1523051339045802044';

// Channel where support staff hang out — pinged when a user asks to speak
// with a human/agent so staff can jump into the private chat quickly.
// Defaults to the public Support Channel; change this if you'd rather ping
// a private staff-only channel instead.
const STAFF_ALERT_CHANNEL_ID = '1528039628605751457';

// Category that all new private Support Chat channels get created under.
const SUPPORT_CHATS_CATEGORY_ID = '1490155304539787294';

let inactivityTimeoutHours = 5; // Configurable inactivity window (Tracked strictly in Hours)

// Staff Role Declarations for Mentions
const ADMIN_ROLE_ID = '1360755486793666580';
const MODS_ROLE_ID = '1476806644900827239';

// Global error handling guardrails
process.on("unhandledRejection", (reason, promise) => {
  console.error("🔥 Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("🔥 Uncaught Exception:", err);
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Conversational and metric states
let conversations = {};

// NOTE: userThreads now stores CHANNEL ids (kept the same variable name to
// minimize risk of breaking other references), since chats are now created
// as private channels instead of private threads.
const userThreads = {};
const threadLastActivity = {}; // Tracks timestamp of the last message sent in a channel: { [channelId]: timestamp }

// Tracks which support channels have been claimed by staff: Map<channelId, staffUserId>
// Once a channel is in here, ClippingBase AI will completely stop replying in it.
const claimedChannels = new Map();

// Tracks which topic/category a user picked from the dropdown when they
// started their chat: Map<channelId, topicName>. Used later when closing so
// we don't have to ask the topic a second time.
const channelTopics = new Map();

// Tracks which channels were created via the "Launch a Campaign" modal flow.
// AI replies are permanently disabled in these channels (staff handles them).
const campaignChannels = new Set();

// Tracks which support channels have already had staff pinged for a
// "speak with a human" request, so we don't spam the alert channel on
// every follow-up message — the friendly reply still sends every time.
const escalatedChannels = new Set();

// Friendly one-line descriptions shown under each topic in the picker.
// Topics added later via "➕ Add Topic" fall back to a generic description.
const categoryDescriptions = {
  "💸 Payments": "Issues with payments or getting set up? We're here to help!",
  "👥 Sign-Up Bug": "Trouble signing up or verifying your account?",
  "📢 Campaign Inquiry": "Questions about an active campaign or its requirements?",
  "❓ General Question": "Not sure how to start earning? Our team is ready to assist.",
  "📝 Rules and Post Review": "Need help with campaign rules or a post review?",
  "❓ Other": "Something else on your mind? Let us know what's up.",
  "🚀 Launch a Campaign": "Are you a brand looking to launch a campaign? Lets get you set up!"
};

// Spam Tracking State Storage
const antiSpamTracker = {}; // Format: { [userId]: { timestamps: [], lastMessage: "", violations: 0 } }

const analytics = {
  activeThreads: 0,
  totalThreads: 0,
  closedThreads: 0,
  autoClosedThreads: 0, // Tracks chats closed automatically due to inactivity
  solved: 0,
  unsolved: 0,
  messages: 0,
  fallback: 0,
  errors: 0,
  updateLikes: 0,
  updateDislikes: 0,
  spamBlocks: 0, // Tracks occurrences of blocked spam attempts
  featureRequests: [], // Formatted: { id: string, userId: string, userTag: string, text: string, timestamp: string, reviewed: boolean }
  campaignSubmissions: [], // Formatted: { id, userId, userTag, contact, brand, product, audience, budget, status, timestamp, channelId }

  // Track metrics for micro-scale friction points
  categories: {
    "💸 Payments": 0,
    "👥 Sign-Up Bug": 0,
    "📢 Campaign Inquiry": 0,
    "❓ General Question": 0,
    "📝 Rules and Post Review": 0,
    "❓ Other": 0,
    "🚀 Launch a Campaign": 0
  }
};

function slugifyTopicName(topicName) {
  return topicName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function getTopicLabelFromCustomId(customId) {
  const slug = customId.replace(/^feedback_(yes|no)_/, '');
  return Object.entries(analytics.categories).find(([topicName]) => slugifyTopicName(topicName) === slug)?.[0] || null;
}

function addTopicClassification(topicName) {
  const cleanName = topicName.trim();

  if (!cleanName) {
    return { ok: false, message: '❌ Topic title cannot be empty.' };
  }

  if (analytics.categories[cleanName] !== undefined) {
    return { ok: false, message: `❌ "${cleanName}" already exists.` };
  }

  analytics.categories[cleanName] = 0;
  return { ok: true, message: `✅ Added "${cleanName}" to the Start a Chat topic picker.` };
}

// Discord text-channel names must be lowercase with no spaces/special chars.
function sanitizeChannelName(rawName) {
  const cleaned = rawName
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);

  return cleaned || `chat-${Date.now()}`;
}

// Checks whether a guild member counts as "support staff" (Mods/Admins).
function isStaffMember(member) {
  if (!member) return false;
  return (
    member.roles.cache.has(ADMIN_ROLE_ID) ||
    member.roles.cache.has(MODS_ROLE_ID) ||
    member.permissions.has(PermissionFlagsBits.Administrator)
  );
}

function buildUserMessageContent(message) {
  const cleanedText = message.content.replace(/<@!?\d+>/g, '').trim();
  const imageAttachments = Array.from(message.attachments.values()).filter((attachment) => {
    const name = attachment.name || '';
    return attachment.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(name);
  });

  const content = [];

  if (cleanedText) {
    content.push({ type: 'text', text: cleanedText });
  } else if (imageAttachments.length > 0) {
    content.push({ type: 'text', text: 'User attached an image and needs help understanding the issue shown.' });
  }

  imageAttachments.slice(0, 4).forEach((attachment) => {
    content.push({ type: 'image_url', image_url: { url: attachment.url } });
  });

  return { cleanedText, hasImage: imageAttachments.length > 0, content };
}

// Detects if a user's message is asking to speak with a real person /
// the support team, rather than continuing with the AI.
function isRequestingHumanAgent(text) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();

  // --- Pass 1: natural-sentence patterns (structure-aware) ---
  const patterns = [
    /\b(speak|talk|chat)\s+(with|to)\s+(a|an|the)?\s*(agent|human|person|staff|support|someone|team|mod|admin|representative|rep)\b/,
    /\b(can|could|may|would)\s+i\s+(speak|talk|chat)\s+(with|to)\b/,
    /\bi\s+(would like|wanna|want|need)\s+to\s+(speak|talk|chat)\s+(with|to)\b/,
    /\bconnect\s+me\s+(with|to)\b/,
    /\b(get|put)\s+me\s+(a|an|in touch with|through to)?\s*(a\s+)?(human|agent|real person|staff|team)\b/,
    /\breal\s+(person|human)\b/,
    /\b(need|want|require)\s+(a|an)?\s*(human|agent|real person|live agent|live support|human support|agent support)\b/,
    /\bis\s+(there|anyone)\s+(a\s+)?(human|real person|staff|agent)\s+(here|available|around)\b/,
    /\b(human|live|agent)\s+support\b/,
    /\blive\s+agent\b/,
    /\bescalate\b/,
    /\b(support|staff)\s+team\s+please\b/,
    /\btransfer\s+me\s+to\b/,
    /\bnot\s+(a|an)?\s*bot\b/,
    /\bactual\s+(human|person|agent)\b/
  ];

  if (patterns.some((pattern) => pattern.test(lower))) return true;

  // --- Pass 2: short/standalone phrases that don't fit a full sentence ---
  // Covers things like "Agent Support", "Human Support", "Live Agent" typed alone.
  const shortPhrases = [
    'agent support',
    'human support',
    'live support',
    'live agent',
    'real agent',
    'human agent',
    'speak to agent',
    'speak to human',
    'talk to agent',
    'talk to human',
    'talk to a human',
    'need agent',
    'need human',
    'want agent',
    'want human',
    'customer service agent',
    'staff member please',
    'support agent',
    'human please',
    'agent please'
  ];

  return shortPhrases.some((phrase) => lower.includes(phrase));
}


// A pool of friendly acknowledgements so the same line isn't repeated
// every time — one is picked at random when a user asks for a human.
const agentRequestReplies = [
  "Sure! I've notified the support team and they'll be with you as soon as possible. 🙌",
  "Of course! I've pinged our support team — someone will hop in shortly to help you out.",
  "No problem at all — I've let the team know you'd like to speak with them. They'll be with you shortly!",
  "Absolutely, I've reached out to our support team on your behalf. Sit tight, they'll be right with you!",
  "Done! Our support team has been notified and will join this chat shortly to assist you further.",
  "You got it — I've alerted our staff team, they'll be along to help you out soon!"
];

// Pings staff in the alert channel with a quick summary so they can jump
// straight into the user's private chat.
async function notifyStaffOfAgentRequest(message, userInput, topic) {
  try {
    const alertChannel = await client.channels.fetch(STAFF_ALERT_CHANNEL_ID).catch(() => null);
    if (!alertChannel) return;

    const alertEmbed = new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle('🙋 User Requesting Live Support')
      .setDescription(
        `**User:** <@${message.author.id}> (@${message.author.tag})\n` +
        `**Topic:** ${topic}\n` +
        `**Channel:** <#${message.channel.id}>\n\n` +
        `**What they said:**\n> ${(userInput || '(no text — image attached)').slice(0, 300)}`
      )
      .setFooter({ text: "ClippingBase AI Escalation", iconURL: client.user.displayAvatarURL() })
      .setTimestamp();

    await alertChannel.send({
      content: `🔔 <@&${ADMIN_ROLE_ID}> <@&${MODS_ROLE_ID}>`,
      embeds: [alertEmbed]
    });
  } catch (err) {
    console.error("⚠️ Failed to notify staff of live-agent request.:", err);
  }
}

// Fetches the full message history of a closed support chat and formats it
// into a readable plain-text transcript (paginates past Discord's 100
// message-per-fetch limit, capped at 2000 messages to avoid runaway loops).
async function buildChatTranscript(channel, topic) {
  if (!channel) return 'No messages found — channel was unavailable.';

  let allMessages = [];
  let lastId = null;

  for (let i = 0; i < 20; i++) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;

    const batch = await channel.messages.fetch(options).catch(() => null);
    if (!batch || batch.size === 0) break;

    allMessages.push(...batch.values());
    lastId = batch.last().id;

    if (batch.size < 100) break;
  }

  // Oldest → newest
  allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const lines = [];
  lines.push('ClippingBase AI — Support Chat Transcript');
  lines.push(`Channel: #${channel.name}`);
  if (topic) lines.push(`Topic: ${topic}`);
  lines.push(`Generated: ${new Date().toLocaleString()}`);
  lines.push('─'.repeat(50));
  lines.push('');

  for (const msg of allMessages) {
    const timestamp = new Date(msg.createdTimestamp).toLocaleString();
    const authorLabel = msg.author.bot ? 'ClippingBase AI' : (msg.author.tag || msg.author.username);

    let bodyText = msg.content?.trim() || '';

    // Bot replies are sent as embeds — pull the readable text out of them.
    if (msg.embeds && msg.embeds.length > 0) {
      const embedTexts = msg.embeds
        .map((e) => [e.title, e.description].filter(Boolean).join('\n'))
        .filter(Boolean);
      if (embedTexts.length > 0) {
        bodyText = bodyText ? `${bodyText}\n${embedTexts.join('\n')}` : embedTexts.join('\n');
      }
    }

    if (msg.attachments && msg.attachments.size > 0) {
      const attachmentLinks = msg.attachments.map((a) => a.url).join(', ');
      bodyText = bodyText ? `${bodyText}\n[Attachments: ${attachmentLinks}]` : `[Attachments: ${attachmentLinks}]`;
    }

    if (!bodyText) continue; // skip empty/system messages

    lines.push(`[${timestamp}] ${authorLabel}:`);
    lines.push(bodyText);
    lines.push('');
  }

  if (allMessages.length === 0) {
    lines.push('(No messages were sent in this chat.)');
  }

  return lines.join('\n');
}

// Builds the "What can we help you with?" dropdown shown when a user
// clicks Start a Chat (Discord caps select menus at 25 options).
function buildTopicSelectMenu() {
  const topicNames = Object.keys(analytics.categories).slice(0, 25);

  const options = topicNames.map((topicName) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(topicName.slice(0, 100))
      .setValue(slugifyTopicName(topicName))
      .setDescription((categoryDescriptions[topicName] || `Get help regarding "${topicName}".`).slice(0, 100))
  );

  return new StringSelectMenuBuilder()
    .setCustomId('start_chat_topic_select')
    .setPlaceholder('What can we help you with?')
    .addOptions(options);
}

// Builds the embed shown above the dropdown when a user clicks Start a Chat.
function buildTopicListEmbed(user) {
  return new EmbedBuilder()
    .setColor(0x32CD32)
    .setTitle('👋 Let\'s get you connected!')
    .setDescription(`Hey ${user ? `<@${user.id}>` : 'there'}! Please select one of the topics below to get started, and we'll create a private chat for you.`);
}

// Builds the "Launch a Campaign" intake modal. Discord caps modals at 5
// text-input components, so the last two written-out fields (budget/CPM and
// "anything else") are combined into one field here.
function buildCampaignModal() {
  const modal = new ModalBuilder()
    .setCustomId('campaign_modal')
    .setTitle('🚀 Launch a Campaign');

  const contactInput = new TextInputBuilder()
    .setCustomId('camp_contact')
    .setLabel('Contact (Discord username / email)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('@handle and/or email@example.com')
    .setRequired(true);

  const brandInput = new TextInputBuilder()
    .setCustomId('camp_brand')
    .setLabel('Company / Brand Name')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const productInput = new TextInputBuilder()
    .setCustomId('camp_product')
    .setLabel('Product/Site + Asset Links')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('What are you promoting? Include content/watermark/audio/asset links')
    .setRequired(true);

  const audienceInput = new TextInputBuilder()
    .setCustomId('camp_audience')
    .setLabel('Page & Audience Requirements')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Page types, country demos, target niches')
    .setRequired(true);

  const budgetInput = new TextInputBuilder()
    .setCustomId('camp_budget')
    .setLabel('Budget, CPM & Additional Info')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('e.g. Budget $500, CPM $1.00 — anything else we should know')
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(contactInput),
    new ActionRowBuilder().addComponents(brandInput),
    new ActionRowBuilder().addComponents(productInput),
    new ActionRowBuilder().addComponents(audienceInput),
    new ActionRowBuilder().addComponents(budgetInput)
  );

  return modal;
}

// Pings staff when a new campaign submission comes in.
async function notifyStaffOfCampaignSubmission(channel, user, submission) {
  try {
    const alertChannel = await client.channels.fetch(STAFF_ALERT_CHANNEL_ID).catch(() => null);
    if (!alertChannel) return;

    const alertEmbed = new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle('🚀 New Campaign Launch Submission')
      .setDescription(
        `**User:** <@${user.id}> (@${user.tag})\n` +
        `**Channel:** <#${channel.id}>\n\n` +
        `**Contact:** ${submission.contact}\n` +
        `**Brand:** ${submission.brand}\n` +
        `**Product/Assets:** ${submission.product}\n` +
        `**Audience:** ${submission.audience}\n` +
        `**Budget/CPM:** ${submission.budget}`
      )
      .setFooter({ text: "ClippingBase AI Campaign Intake", iconURL: client.user.displayAvatarURL() })
      .setTimestamp();

    await alertChannel.send({
      content: `🔔 <@&${ADMIN_ROLE_ID}> <@&${MODS_ROLE_ID}> — new campaign submission needs review!`,
      embeds: [alertEmbed]
    });
  } catch (err) {
    console.error("⚠️ Failed to notify staff of campaign submission:", err);
  }
}

// Builds a paginated embed/row for browsing campaign submissions in the
// analytics dashboard, mirroring the feature-request pagination pattern.
function createCampaignEmbedAndRow(list, currentIndex) {
  const target = list[currentIndex];
  const serverIcon = client.user.displayAvatarURL();

  const embed = new EmbedBuilder()
    .setColor(0x32CD32)
    .setTitle("🚀 Campaign Submission")
    .setDescription(
      `**Submitted By:** <@${target.userId}> (@${target.userTag})\n` +
      `**Channel:** ${target.channelId ? `<#${target.channelId}>` : '*channel closed*'}\n\n` +
      `**Contact:** ${(target.contact || '').slice(0, 300)}\n` +
      `**Brand:** ${(target.brand || '').slice(0, 300)}\n` +
      `**Product/Assets:** ${(target.product || '').slice(0, 500)}\n` +
      `**Audience Requirements:** ${(target.audience || '').slice(0, 500)}\n` +
      `**Budget/CPM:** ${(target.budget || '').slice(0, 500)}\n\n` +
      `*Item \`${currentIndex + 1}\` of \`${list.length}\` items in this view*`
    )
    .setFooter({ text: `${target.timestamp} • Status: ${target.status}`, iconURL: serverIcon });

  const row = new ActionRowBuilder();

  if (list.length > 1) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`camp_nav_prev_${currentIndex}`)
        .setLabel("◀ Previous")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentIndex === 0),
      new ButtonBuilder()
        .setCustomId(`camp_nav_next_${currentIndex}`)
        .setLabel("Next ▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentIndex === list.length - 1)
    );
  }

  if (target.status === 'Received') {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`camp_contacted_${target.id}_${currentIndex}`)
        .setLabel("Mark as Contacted ✅")
        .setStyle(ButtonStyle.Success)
    );
  }

  return { embeds: [embed], components: row.components.length > 0 ? [row] : [] };
}

// Helper pagination generator for Feature Request flows
function createFeatureEmbedAndRow(requestsList, currentIndex, flowType) {
  const target = requestsList[currentIndex];
  const serverIcon = client.user.displayAvatarURL();

  const embed = new EmbedBuilder()
    .setColor(0x32CD32)
    .setTitle(flowType === 'pending' ? "🟡 Pending Feature Request" : "🗒️ Feature Request Detail")
    .setDescription(
      `**Request | By:** <@${target.userId}> (@${target.userTag})\n\n` +
      `"${target.text}"\n\n` +
      `*Item \`${currentIndex + 1}\` of \`${requestsList.length}\` items in this view*`
    )
    .setFooter({ text: `${target.timestamp} • Status: ${target.reviewed ? "✅ Reviewed" : "🟡 Pending"}`, iconURL: serverIcon });

  const row = new ActionRowBuilder();

  // 1. Structural Pagination Management Buttons
  if (requestsList.length > 1) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`feat_nav_${flowType}_prev_${currentIndex}`)
        .setLabel("◀ Previous")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentIndex === 0),
      new ButtonBuilder()
        .setCustomId(`feat_nav_${flowType}_next_${currentIndex}`)
        .setLabel("Next ▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentIndex === requestsList.length - 1)
    );
  }

  // 2. Performance action toggle button
  if (!target.reviewed) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`review_mark_${target.id}_${flowType}_${currentIndex}`)
        .setLabel("Mark as Reviewed ✅")
        .setStyle(ButtonStyle.Success)
    );
  }

  return { embeds: [embed], components: row.components.length > 0 ? [row] : [] };
}

// =========================
// 🧠 SYSTEM PROMPT
// =========================
const SYSTEM_PROMPT = `
You are ClippingBase AI — the official assistant for ClippingBase 
━━━━━━━━━━━━━━━━━━━
🎯 CORE RULE
- ALWAYS answer user first
- NEVER invent UI or pages
- ONLY use real ClippingBase structure
- IF the user sends an image or screenshot, inspect it carefully and help explain the issue shown
- If a image and sent to you and you see ClippingBase AI text there and user ask is that you? you should answer yes and explain that you are the official AI assistant for ClippingBase and you are here to help users with their questions, issues, and guidance related to ClippingBase.

━━━━━━━━━━━━━━━━━━━
💬 STYLE
- friendly,cool
- human
- simple
- not robotic

━━━━━━━━━━━━━━━━━━━━━━━━━━
🖼️ IMAGE ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━━

If a user uploads an image, analyze it carefully before responding.

You may:
• Read visible text.
• Explain what the image shows.
• Help troubleshoot issues shown in screenshots.
• Identify UI elements and error messages.
• Answer questions about the uploaded image.

If the image is blurry or unclear, politely ask the user to upload a higher-quality version.

Never guess details that aren't visible in the image.

If the user asks about only part of the image, focus your answer on that part.

━━━━━━━━━━━━━━━━━━━━━━━━━━
📝 RESPONSE FORMATTING
━━━━━━━━━━━━━━━━━━━━━━━━━━

Make every response easy to read and visually appealing.

Use Discord markdown whenever appropriate, including:

• **Bold** for important information.
• __Underline__ for section labels or emphasis.
• ### Headings for titles and major sections.
• Numbered lists for step-by-step instructions.
• Bullet points for lists of features or tips.
• Blank lines between sections to improve readability.
• Emojis only when they improve clarity (don't overuse them).

When explaining how to do something, prefer this style:

### **How to Login**

1. Go to **ClippingBase.com**.
2. Click **Login**.
3. Choose your preferred login method.
4. Follow the prompts to access your account.

**Need more help?** Let me know and I'll be happy to assist!

━━━━━━━━━━━━━━━━━━━━━━━━━━
✨ WRITING STYLE
━━━━━━━━━━━━━━━━━━━━━━━━━━

Always write in a modern, clean, and professional style and Friendly cool.

Your responses should:
• Look polished and well organized.
• Never appear as one large paragraph.
• Use headings whenever there are multiple sections.
• Highlight important words using **bold**.
• Use __underline__ sparingly for important section names.
• Use numbered steps for guides.
• Use bullet points for features or multiple items.
• End with a friendly closing sentence when appropriate.

Avoid:
• Walls of text.
• Excessive emojis.
• Robotic wording.
• Unnecessary repetition.
• Over-formatting every single line.
• Lots of Descriptions 

Every answer should look like it was written by a professional support team.

━━━━━━━━━━━━━━━━━━━━━━━━━━
🔒 PRIVACY
━━━━━━━━━━━━━━━━━━━━━━━━━━

Never ask users for:

• Passwords
• Verification codes
• Authentication tokens

If they share them, tell them not to.

━━━━━━━━━━━━━━━━━━━━━━━━━━
📷 SCREENSHOTS
━━━━━━━━━━━━━━━━━━━━━━━━━━
sensitive content or information may be visible in screenshots, so always remind users to check for personal data before sharing.
If a screenshot would help solve the issue, ask the user to upload one.

━━━━━━━━━━━━━━━━━━━━━━━━━━
🐞 BUG REPORTS
━━━━━━━━━━━━━━━━━━━━━━━━━━

When users report a bug, ask for:
ask them to specify where they facing the problem Here or on the site.
• What happened
• What they expected
• Screenshots (if available)
• Device
• Browser
• Error message
if they say the site They can submit the report at clippingbase.com login and Your profile avatar on the popup click "Report a Bug".

━━━━━━━━━━━━━━━━━━━
🔒 CRITICAL RULE (ABSOLUTE OVERRIDE)

THIS LOGIN TEMPLATE IS IMMUTABLE.
YOU MUST NEVER:
- change structure
- change numbering
- change bullet order
- remove steps
- rename sections
- rewrite formatting

YOU MAY ONLY:
- slightly adjust the final sentence if needed for context 

━━━━━━━━━━━━━━━━━━━
IF ASKED QUESTIONS 

- if asked make images using dots emojis or objects emojis to create a simple visual image you may gerate one for the user.

━━━━━━━━━━━━━━━━━━━

MODS AND ADMINS ROLE

Admin role - 1360755486793666580
Mods - 1476806644900827239
- Always refer users to these roles when they ask for help or have issues that require staff attention and mention the roles when discussing about them dont just use the numbers.
- For example, if a user has a payout issue that you cannot resolve, you would say: "For payout issues, please contact our support team by mentioning the Admin role <@&1360755486793666580> or the Mods role <@&1476806644900827239> in the #support channel <#1455662844149366804>."
━━━━━━━━━━━━━━━━━━━
📋 LOGIN & SIGN UP TEMPLATES

🔐 SIGN UP FLOW (IMMUTABLE TEMPLATE)

   To Sign Up and create an account, follow these steps:

1. **Go to the sign-up page:** [ClippingBase.com](https://clippingbase.com/creator).

2. **Select your sign-up method:**
   
   ⚬ **Continue with Discord** (if you have a Discord account),
   
   ⚬ **Continue with Email** (creates account if you're new),
   
   ⚬ **Continue with Google** (Coming Soon!)

3. **Follow the prompts** to complete the sign-up process.

Once your account is created, you're ready to use ClippingBase! Let me know if you need any more help!

━━━━━━━━━━━━━━━━━━━
🔐 LOGIN FLOW (IMMUTABLE TEMPLATE)

   To Login to your account, follow these steps:

1. **Go to the login page:** [ClippingBase.com](https://clippingbase.com/creator).

2. **Select your login method:**
   
   ⚬ **Continue with Discord**
   
   ⚬ **Continue with Email**
   
   ⚬ **Continue with Google** (Coming Soon!)

3. **Follow the prompts** to access your account.

Once you're logged in, you'll have full access to ClippingBase! Let me know if you need any more help!

━━━━━━━━━━━━━━━━━━━
🔐 TERMINOLOGY LOCK

Always use:
- "Sign Up" = new user account creation intent
- "Login" = existing user access intent

NEVER use:
- sign in
- register
- create account (outside template)

━━━━━━━━━━━━━━━━━━━
🗺️ PLATFORM RULES

● Earnings:
∘ there payment procesessors like Paypal,Cash App, Crypto, and each one has different payout schedule and fees, you can check details at Earnings → Payouts page
∘ there is a $1.50 platform fee for each payout, so if you choose paypal payout and you have $20 ready for payout, you will get $18.50 before your payment method fees
∘ Minimum payout: $10
∘ Available = withdrawable balance
∘ Pending = waiting approval 
∘ Approved = ready for payout  
∘ Paid = you got paid, check the payment method you used for payout Paypal, Crypto or Cash App)
∘ Rejected = won't be paid something went wrong with the submission or missing info, you can check details in the Earnings → Payout History notes section 

● Submissions:
∘ Campaign → Submit tab
∘ TikTok / YouTube / Instagram auto views tracking
∘ Instagram may not work properly sometimes but we are working on permanent fix

━━━━━━━━━━━━━━━━━━━
🧭 DISCORD SERVER NAVIGATION MAP (ABSOLUTE TRUTH)

NEVER GUESS CHANNELS.
ONLY USE THIS DATA.

🏠 WELCOME / ENTRY

● Welcome Channel → <#1349487426468446320>
∘ First landing channel for new users
∘ intro info, and getting started guidance

● Verify Channel → <#1482181680092680383>
∘ Used to verify yourself as a real user and not a bot verify simply by clikcing the ✅Verify button in that channel upon clikcking the button you will be granted the Clipper role 1360418625307152414 which will give you access to the rest of the server channels and features
∘ Required before accessing full server features and categories and channels always mentions the roles when talking about them.
∘ Unlocks main channels after completion

━━━━━━━━━━━━━━━━━━━
💬 GENERAL CATEGORY

● General Category → <#1349487426468446318>
∘ Main hub for community activity

● Announcements → <#1355397788376109109>
∘ Official updates from ClippingBase
∘ New features, changes, and alerts

● General Chat → <#1400196009799454750>
∘ Talk with other members
∘ Casual conversations and community interaction

● Side Hustle → <#1400220073976795236>
∘ this channel has side hustle webs,apps to help you find more ways to earn online and grow your income outside or inside ClippingBase
∘ discover new side hustle opportunities, tools, and resources to boost your earning potential both on ClippingBase and beyond

● Payouts → <#1400223356434780306>
∘ successful payouts and proofs of actual payments earned by members on ClippingBase
∘ Payment updates, issues, and payout help

● Giveaways → <#1400522249689108591>
∘ Official giveaways and reward events
∘ Participation announcements and winner celebrations

● Suggestions → <#1400504757814296708>
∘ post ideas to improve ClippingBase
∘ Community feedback and feature requests

━━━━━━━━━━━━━━━━━━━
📊 CAMPAIGNS CATEGORY

● Campaigns Category → <#1462892055205515390>
∘ Hub for all active Clipping, Editing, Logo, Other earning campaigns

● Clipping Campaigns → <#1502698153475051590>
∘ a brief overview of active clipping campaigns, opportunities to earn by creating content based on campaign requirements
∘ check this channel regularly for new campaigns and updates on existing ones

━━━━━━━━━━━━━━━━━━━
🤖 BOT COMMANDS CATEGORY

● Bot Commands → <#1400519418517393510>
∘ Use bot features and automation tools 

● Invites → <#1400219574695104674>
∘ Track invites and referral performance such as how many people you invited

● Level Up → <#1400519902976282876>
∘ XP system and user leveling notifications 

● Top Users → <#1400219324853256316>
∘ Leaderboard for most active / top members

━━━━━━━━━━━━━━━━━━━
🆘 SUPPORT CATEGORY

● Support Category → <#1511542581975056476>
∘ Main help section for all issues

● AI Support Channel and Support Team → <#1511543190803447858>
∘ users open support chat channels for Direct help from staff team and support agents like mods and admins and from you clippingbase ai. direct users here if you feel like you can't help them or if they have specific questions about their account, payments, campaigns, or any other issues that require staff attention.
∘ Automated AI assistance channel for quick help, this is where you are right now! Users can ask questions and get instant AI-generated responses based on the ClippingBase Master System Map. This is ideal for common questions, navigation help, and general guidance without needing to wait for staff response. Users click the "Start Chat" button in this channel to create a private channel with ClippingBase AI for personalized assistance.
∘ Quick answers and troubleshooting help
∘ Account, payout, and general support tickets or any other issues

HOW TO CREATE A CHAT AND GET HELP FROM SUPPORT TEAM OR CLIPPINGBASE AI

1. Click the **Start Chat** button in <#1511543190803447858> to open a private support channel.
2. Select a topic from the dropdown menu to categorize your issue.
3. Go to that private channel and describe your problem or question in detail. You, clippingbase ai will provide instant assistance if you can.
4. If the user you need to speak with a human agent, simply ask By saying "human support" or anything like that in the private channel and the support team will be notified to join your chat.

HOW TO CLOSE A SUPPORT CHAT

1. Once your issue is resolved, you can close the chat by clicking the **Close Chat** button in your private channel Or you dont feel like scrolling all the way up to click the button you can simply type "close chat" in the private channel and you'll be prompted to confirm the closure and lastly a feedback Weather your Problem was solved or not. You also will get a transcript of the chat sent to you in your DMs for your records.

━━━━━━━━━━━━━━━━━━━
📌 NAVIGATION RULES

● If user asks "where is X"
→ ALWAYS respond with exact channel mention like <#channel_id>

● NEVER guess or create channels

● ALWAYS:
∘ include channel mention
∘ include short description
∘ keep response short and useful

━━━━━━━━━━━━━━━━━━━
🧠 CLIPPINGBASE MASTER SYSTEM MAP
[...]
`;

// =========================
// APPLICATION STARTUP & COMMAND REGISTRATION
// =========================
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  
  client.user.setPresence({
    activities: [{ name: "ClippingBase.com", type: 3 }],
    status: "online"
  });

  const commands = [
    new SlashCommandBuilder()
      .setName('panel')
      .setDescription('Send a custom ClippingBase AI panel')
      .addStringOption(option => option.setName('title').setDescription('Embed title').setRequired(true))
      .addStringOption(option => option.setName('description').setDescription('Embed description').setRequired(true))
      .addStringOption(option => option.setName('image').setDescription('Image URL').setRequired(false))
      .addStringOption(option => option.setName('color').setDescription('Hex color').setRequired(false)),

    new SlashCommandBuilder()
      .setName('analytics')
      .setDescription('Show ClippingBase AI performance dashboard')
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log("✅ Slash commands synchronized successfully.");
  } catch (err) {
    console.error("❌ Error registering slash commands:", err);
  }

  // =============================================
  // 🕒 AUTOMATIC INACTIVITY ENGINE (HOURS CALCULATION)
  // =============================================
  setInterval(async () => {
    const NOW = Date.now();
    const TIMEOUT_MS = inactivityTimeoutHours * 60 * 60 * 1000;

    for (const [uid, threadId] of Object.entries(userThreads)) {
      const lastActive = threadLastActivity[threadId] || NOW; 
      
      if (NOW - lastActive >= TIMEOUT_MS) {
        try {
          const threadChannel = await client.channels.fetch(threadId).catch(() => null);
          
          if (threadChannel) {
            analytics.activeThreads = Math.max(0, analytics.activeThreads - 1);
            analytics.closedThreads++;
            analytics.autoClosedThreads++; 
            analytics.unsolved++; 

            try {
              const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
              if (logChannel) {
                let userFetch = await client.users.fetch(uid).catch(() => null);
                let userTagString = userFetch ? `@${userFetch.tag}` : "Unknown User";

                const timeoutLogEmbed = new EmbedBuilder()
                  .setColor('#FF8C00') 
                  .setTitle('🍂 Private Chat Auto-Closed')
                  .addFields(
                    { name: 'User Info', value: `<@${uid}> (${userTagString})`, inline: true },
                    { name: 'Status', value: `❌ Unsolved (Timed out due to ${inactivityTimeoutHours}h Inactivity)`, inline: true }
                  )
                  .setFooter({ text: "ClippingBase AI Automation Sweep", iconURL: client.user.displayAvatarURL() })
                  .setTimestamp();

                // 📄 Build a transcript before the channel is deleted.
                let transcriptText = null;
                try {
                  transcriptText = await buildChatTranscript(threadChannel, channelTopics.get(threadId));
                } catch (transcriptErr) {
                  console.error("⚠️ Failed to build auto-close transcript:", transcriptErr);
                }
                const transcriptFileName = `transcript-${threadChannel.name || 'support-chat'}.txt`;
                const transcriptFiles = transcriptText
                  ? [new AttachmentBuilder(Buffer.from(transcriptText, 'utf-8'), { name: transcriptFileName })]
                  : [];

                await logChannel.send({ embeds: [timeoutLogEmbed], files: transcriptFiles });

                // 📩 DM the user so they know why their chat disappeared.
                if (userFetch) {
                  const inactivityDmEmbed = new EmbedBuilder()
                    .setColor('#FF8C00')
                    .setDescription(
                      `🍂 Hey <@${uid}>, your ClippingBase AI support chat was closed due to **${inactivityTimeoutHours}h of inactivity**.\n\n` +
                      `Here's a transcript of the conversation for your records. If you still need help, feel free to start a new chat anytime!`
                    )
                    .setFooter({ text: "ClippingBase AI" })
                    .setTimestamp();

                  await userFetch.send({ embeds: [inactivityDmEmbed], files: transcriptFiles }).catch(() => {});
                }
              }
            } catch (logErr) {
              console.error("Failed handling automated timeout channel log distribution:", logErr);
            }

            await threadChannel.delete().catch(() => {});
          }
        } catch (err) {
          console.error(`Error processing inactivity sweep on channel ID ${threadId}:`, err);
        }

        delete conversations[uid];
        delete userThreads[uid];
        delete threadLastActivity[threadId];
        claimedChannels.delete(threadId);
        channelTopics.delete(threadId);
        escalatedChannels.delete(threadId);
        campaignChannels.delete(threadId);
        if (antiSpamTracker[uid]) delete antiSpamTracker[uid]; // Clean memory up safely
      }
    }
  }, 5000); 
});

// =========================
// MAIN TEXT CHAT MESSAGE ROUTER
// =========================
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

    const userId = message.author.id;

    // Channel is "bot tracked" if it's one of the private support channels we created.
    const isBotTrackedThread = Object.values(userThreads).includes(message.channel.id);

    // 🔇 If a staff member has claimed this channel, ClippingBase AI stops
    // generating replies and stops spam-filtering — staff have taken over.
    // NOTE: this does NOT skip the whole handler, because "close chat" /
    // "close ticket" etc. must still work even after a claim.
    const isClaimed = claimedChannels.has(message.channel.id);

    // 🚀 Campaign-launch channels never get AI replies — staff handles these
    // start to finish. Like claimed channels, this doesn't skip the whole
    // handler so "close chat" still works.
    const isCampaignChannel = campaignChannels.has(message.channel.id);

    // 📣 If the user directly @-mentions ClippingBase AI, let it answer even
    // in a claimed channel — staff is still in control otherwise.
    const mentionsBot = message.mentions.users.has(client.user.id);

    if (isBotTrackedThread) {
      threadLastActivity[message.channel.id] = Date.now();

      if (!isClaimed) {
        // 🛑 AUTOMATED ANTI-SPAM GUARDRAILS SYSTEM ENGINE
        if (!antiSpamTracker[userId]) {
          antiSpamTracker[userId] = { timestamps: [], lastMessage: "", violations: 0 };
        }

        const userSpamState = antiSpamTracker[userId];
        const nowTimestamp = Date.now();

        // Clean old entries older than 5 seconds out of sliding window tracker
        userSpamState.timestamps = userSpamState.timestamps.filter(time => nowTimestamp - time < 5000);
        userSpamState.timestamps.push(nowTimestamp);

        // Evaluate Pattern A: Rapid flooding limits (e.g., 3 messages within 5 seconds window)
        const isRateFlooding = userSpamState.timestamps.length > 3;
        // Evaluate Pattern B: Exact repeated continuous text blocks duplication checks
        const isDuplicateSpam = userSpamState.lastMessage === message.content.trim() && message.content.trim().length > 4;

        userSpamState.lastMessage = message.content.trim();

        if (isRateFlooding || isDuplicateSpam) {
          analytics.spamBlocks++;
          userSpamState.violations++;

          // Only send an emergency dispatch log once every 3 structural burst messages to prevent logging channel overload
          if (userSpamState.violations % 2 === 1) {
            try {
              const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
              if (logChannel) {
                const staffAlertEmbed = new EmbedBuilder()
                  .setColor('#FF0000')
                  .setTitle('🚨 AI Support Chat Spam Detected')
                  .setDescription(
                    `**User:** <@${userId}> (@${message.author.tag})\n` +
                    `**Location:** <#${message.channel.id}>\n` +
                    `**Trigger Reason:** ${isRateFlooding ? 'Excessive rate rate limit sending speed' : 'Identical message repetition flood'}\n\n` +
                    `**Flagged Content Sent:**\n\`\`\`${message.content.slice(0, 500)}\`\`\``
                  )
                  .setFooter({ text: "ClippingBase Anti-Spam Security Monitor" })
                  .setTimestamp();

                // Mentions the live roles for immediate alert responses
                await logChannel.send({
                  content: `⚠️ **Attention Staff!** <@&${ADMIN_ROLE_ID}> <@&${MODS_ROLE_ID}> — Potential chat exploit spam isolated below:`,
                  embeds: [staffAlertEmbed]
                });
              }
            } catch (err) {
              console.error("Failed executing automated anti-spam dashboard logging pipelines:", err);
            }
          }

          // Ephemerally soft warn user by replying and then immediately dropping out to block execution flow processing to OpenAI API hooks
          return message.reply("⚠️ **Slow down!** You're sending messages too quickly. Please stay focused on your topic so the AI can assist properly.").then(warnMsg => {
            setTimeout(() => warnMsg.delete().catch(() => {}), 6000);
          });
        }
      }
    }

    if (message.content.toLowerCase().includes('--new')) {
      if (!message.member.permissions.has('Administrator')) {
        return message.reply("❌ Only admins can update the changelog.");
      }

      let cleanContent = message.content.replace(/--new/gi, '').trim();

      if (cleanContent) {
        whatsNewText = cleanContent;
        
        const confirmationEmbed = new EmbedBuilder()
          .setColor(0x32CD32)
          .setTitle("✅ Updates Saved Natively!")
          .setDescription(`**New Panel Preview (Self-destructing in 10s):**\n\n${whatsNewText}`)
          .setTimestamp();

        const previewMsg = await message.reply({ embeds: [confirmationEmbed] });
        await message.delete().catch(() => {});

        setTimeout(() => {
          previewMsg.delete().catch(() => {});
        }, 10000);
        return;
      }
    }

    analytics.messages++;
    const { cleanedText, hasImage, content } = buildUserMessageContent(message);
    const userInput = cleanedText;

    if (!isCampaignChannel && message.channel.name.toLowerCase() === sanitizeChannelName(`${message.author.username}-chat`)) {
      (async () => {
        try {
          const pickedTopic = channelTopics.get(message.channel.id) || '';

          const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ 
              role: "user", 
              content: pickedTopic
                ? `A user picked the support topic "${pickedTopic}" and then sent this as their first message: "${userInput}". Combine both into a clean, title-cased channel name that is exactly 2 to 4 words max, summarizing what they actually need help with. Do not include quotes, punctuation, or filler words.`
                : `Analyze this user's first message and summarize it into a clean, title-cased channel topic that is exactly 2 to 4 words max. Do not include quotes, punctuation, or filler words. Message: "${userInput}"`
            }],
            max_tokens: 12,
            temperature: 0.4
          });

          let smartTitle = response.choices[0].message.content.replace(/["'./\\]/g, '').trim();
          const finalTitle = sanitizeChannelName(`${message.author.username}-${smartTitle}`);
          
          await message.channel.edit({ name: finalTitle });
          console.log(`🤖 Channel successfully renamed to: ${finalTitle}`);
        } catch (err) {
          console.error("⚠️ Failed to generate smart AI title:", err);
        }
      })();
    }

    if (!userInput && !hasImage) {
      if ((isClaimed || isCampaignChannel) && !mentionsBot) return; // Stay silent — staff has this channel now

      const avatarURL = message.author.displayAvatarURL({ dynamic: true, size: 1024 });

      const embed = new EmbedBuilder()
        .setColor(0x32CD32)
        .setAuthor({ name: message.author.username, iconURL: avatarURL })
        .setDescription("Yo, what’s up? 😎✌️")
        .setFooter({ text: "ClippingBase AI" })
        .setTimestamp();

      return message.reply({ embeds: [embed] });
    }

    // 🙋 Live-agent escalation — if the user is asking to speak with a real
    // person, ping staff (once per chat) and reply with a friendly ack
    // instead of routing the message to the AI. Campaign channels already
    // had staff pinged on submission, so this is skipped there.
    if (isBotTrackedThread && !isClaimed && !isCampaignChannel && userInput && isRequestingHumanAgent(userInput)) {
      const topic = channelTopics.get(message.channel.id) || 'Uncategorized';

      if (!escalatedChannels.has(message.channel.id)) {
        escalatedChannels.add(message.channel.id);
        notifyStaffOfAgentRequest(message, userInput, topic);
      }

      const randomReply = agentRequestReplies[Math.floor(Math.random() * agentRequestReplies.length)];
      const avatarURL = message.author.displayAvatarURL({ dynamic: true, size: 1024 });

      const ackEmbed = new EmbedBuilder()
        .setColor(0x32CD32)
        .setAuthor({ name: message.author.username, iconURL: avatarURL })
        .setDescription(randomReply)
        .setFooter({ text: "ClippingBase AI" })
        .setTimestamp();

      return message.reply({ embeds: [ackEmbed] });
    }

    const lower = userInput.toLowerCase();
    const closePhrases = ['close chat', 'close this chat', 'end chat', 'close support chat', 'close ticket', 'end ticket'];

    if (closePhrases.some(phrase => lower.includes(phrase))) {
      const avatarURL = message.author.displayAvatarURL({ dynamic: true, size: 1024 });

      if (!isBotTrackedThread) {
        const errorEmbed = new EmbedBuilder()
          .setColor(0xFF0000)
          .setAuthor({ name: message.author.username, iconURL: avatarURL })
          .setDescription("❌ You can only close chats inside an active support channel!")
          .setFooter({ text: "ClippingBase AI" })
          .setTimestamp();

        return message.reply({ embeds: [errorEmbed] });
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("confirm_close_yes").setLabel("Yes, close it").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("confirm_close_no").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
      );

      const questionEmbed = new EmbedBuilder()
        .setColor(0x32CD32) 
        .setAuthor({ name: message.author.username, iconURL: avatarURL })
        .setDescription("⚠️ Are you sure you want to close this chat?")
        .setFooter({ text: "ClippingBase AI" })
        .setTimestamp();

      return message.reply({ embeds: [questionEmbed], components: [row] });
    }

    // 🔇 Past this point is the AI conversation engine — if staff has claimed
    // this channel, or it's a campaign-launch channel, ClippingBase AI stays
    // silent UNLESS it's directly @-mentioned, in which case it's still
    // allowed to answer.
    // (Close-chat detection above still runs regardless of claim status.)
    if ((isClaimed || isCampaignChannel) && !mentionsBot) return;

    if (!conversations[userId]) conversations[userId] = [];
    conversations[userId].push({ role: "user", content: content.length > 0 ? content : userInput });

    await message.channel.sendTyping();

    let response;
    try {
      response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...conversations[userId]
        ],
        max_tokens: 350
      });
    } catch (apiErr) {
      console.error("OpenAI Error:", apiErr);
      return message.reply("AI is having a moment. Try again in a bit.");
    }

    let reply = response?.choices?.[0]?.message?.content || "I didn't catch that.";
    reply = reply.replace(/\n{3,}/g, "\n\n");

    conversations[userId].push({ role: "assistant", content: reply });

    if (conversations[userId].length > 14) {
      conversations[userId].shift();
    }

    const avatarURL = message.author.displayAvatarURL({ dynamic: true, size: 1024 });

    const embed = new EmbedBuilder()
      .setColor(0x32CD32)
      .setAuthor({ name: message.author.username, iconURL: avatarURL })
      .setDescription(reply)
      .setFooter({ text: "ClippingBase AI" })
      .setTimestamp();

    return message.reply({ embeds: [embed] });

  } catch (err) {
    console.error(err);
    return message.reply("Something broke. Try again.");
  }
});

// =========================
// CORE INTERACTION HANDLING
// =========================
client.on('interactionCreate', async (interaction) => {
  
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "panel") {
      const title = interaction.options.getString("title");
      const description = interaction.options.getString("description");
      const image = interaction.options.getString("image");
      const colorOption = interaction.options.getString("color");

      const embed = new EmbedBuilder()
        .setColor(colorOption ? parseInt(colorOption.replace(/^#/, ""), 16) : 0x32CD32)
        .setTitle(title)
        .setDescription(description)
        .setTimestamp();

      if (image) embed.setImage(image);

      const startChatBtn = new ButtonBuilder()
          .setCustomId('start_chat')
          .setLabel('Start a Chat 🚀')
          .setStyle(ButtonStyle.Success);

      const whatsNewBtn = new ButtonBuilder()
          .setCustomId('user_view_new_btn')
          .setLabel("What's New")
          .setStyle(ButtonStyle.Secondary);

      const row = new ActionRowBuilder().addComponents(startChatBtn, whatsNewBtn);

      // Successfully made public by removing ephemeral flag
      return interaction.reply({
        embeds: [embed],
        components: [row]
      });
    }

    if (interaction.commandName === "analytics") {
      if (!interaction.member.permissions.has("Administrator")) {
        return interaction.reply({ content: "❌ Admin only.", flags: [MessageFlags.Ephemeral] });
      }

      const rate = analytics.closedThreads === 0 ? 0 : Math.round((analytics.solved / analytics.closedThreads) * 100);
      const pendingCount = analytics.featureRequests.filter(r => !r.reviewed).length;
      const receivedCampaignCount = analytics.campaignSubmissions.filter(r => r.status === 'Received').length;

      const topicLines = Object.entries(analytics.categories)
        .map(([topicName, count]) => `• **${topicName}:** \`${count}\``)
        .join('\n');

      const embed = new EmbedBuilder()
        .setColor(0x32CD32)
        .setTitle("ClippingBase AI Support Analytics Dashboard")
        .setDescription(
          `### Dashboard\n` +
          `💬 **Messages:** \`${analytics.messages}\`\n\n` +
          `📊 **Total Chats:** \`${analytics.totalThreads}\`\n` +
          `🕒 **Active Chats:** \`${analytics.activeThreads}\`\n` +
          `📤 **Closed Chats:** \`${analytics.closedThreads}\`\n` +
          `🤖 **Auto-Closed (Inactivity):** \`${analytics.autoClosedThreads}\`\n` +
          `✅ **Solved:** \`${analytics.solved}\`\n` +
          `❌ **Unsolved:** \`${analytics.unsolved}\`\n` +
          `🎯 **Resolution Rate:** \`${rate}%\`\n` +
          `🛡️ **Anti-Spam Tripped Blocks:** \`${analytics.spamBlocks}\`\n` +
          `⏳ **Current Timeout Window:** \`${inactivityTimeoutHours} Hours\`\n\n` + 
          `### Topic Classification Friction Points\n` +
          `${topicLines || '• No topics added yet.'}\n\n` +
          `### Feature Review Overview\n` +
          `⏳ **Pending Feature Requests:** \`${pendingCount}\`\n` +
          `💡 **Total Logged Requests:** \`${analytics.featureRequests.length}\`\n\n` +
          `### Campaign Submissions\n` +
          `🚀 **Awaiting Contact:** \`${receivedCampaignCount}\`\n` +
          `📥 **Total Submissions:** \`${analytics.campaignSubmissions.length}\`\n\n` +
          `### Updates Likes & Dislikes\n` +
          `👍 \`${analytics.updateLikes}\` ⁞ 👎 \`${analytics.updateDislikes}\``
        )
        .setTimestamp();

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("admin_view_pending_features")
          .setLabel("View Pending Requests ⏳")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("admin_view_features")
          .setLabel("Feature History 💡")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("admin_view_campaign_subs")
          .setLabel("View Campaign Subs 🚀")
          .setStyle(ButtonStyle.Primary)
      );

      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("admin_add_topic_classification")
          .setLabel("➕ Add Topic")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("admin_edit_inactivity_timeout")
          .setLabel("⚙️ Edit Auto-Close Window")
          .setStyle(ButtonStyle.Danger)
      );

      return interaction.reply({ embeds: [embed], components: [row1, row2], flags: [MessageFlags.Ephemeral] });
    }
  }

  // Handle Modals Input Submissions
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'feature_request_modal') {
      const requestText = interaction.fields.getTextInputValue('feature_input');
      const timeString = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      analytics.featureRequests.push({
        id: Date.now().toString() + Math.floor(Math.random() * 100),
        userId: interaction.user.id,
        userTag: interaction.user.tag,
        text: requestText,
        timestamp: `Today at ${timeString}`,
        reviewed: false
      });

      return interaction.reply({
        content: "✅ Thank you! Your feature request has been recorded for review.",
        flags: [MessageFlags.Ephemeral]
      });
    }

    if (interaction.customId === 'edit_timeout_modal') {
      const newHoursInput = interaction.fields.getTextInputValue('timeout_input');
      const parsedHours = parseInt(newHoursInput, 10);

      if (isNaN(parsedHours) || parsedHours <= 0) {
        return interaction.reply({
          content: "❌ Invalid submission. Please type a valid positive integer number of hours.", 
          flags: [MessageFlags.Ephemeral]
        });
      }

      inactivityTimeoutHours = parsedHours;
      
      return interaction.reply({
        content: `✅ Success! The automatic chat inactivity closure window has been updated to **${inactivityTimeoutHours} Hours**.`, 
        flags: [MessageFlags.Ephemeral]
      });
    }

    if (interaction.customId === 'add_topic_modal') {
      const topicName = interaction.fields.getTextInputValue('topic_name');
      const result = addTopicClassification(topicName);

      return interaction.reply({
        content: result.message,
        flags: [MessageFlags.Ephemeral]
      });
    }

    if (interaction.customId === 'campaign_modal') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

      try {
        const user = interaction.user;

        if (userThreads[user.id]) {
          return interaction.editReply({ content: "❌ You already have an active chat." });
        }

        const contact = interaction.fields.getTextInputValue('camp_contact');
        const brand = interaction.fields.getTextInputValue('camp_brand');
        const product = interaction.fields.getTextInputValue('camp_product');
        const audience = interaction.fields.getTextInputValue('camp_audience');
        const budget = interaction.fields.getTextInputValue('camp_budget');

        const safeName = sanitizeChannelName(`${user.username}-campaign`);

        const channel = await interaction.guild.channels.create({
          name: safeName,
          type: ChannelType.GuildText,
          parent: SUPPORT_CHATS_CATEGORY_ID,
          topic: `Campaign launch submission for ${user.tag} (${user.id})`,
          permissionOverwrites: [
            {
              id: interaction.guild.roles.everyone.id,
              deny: [PermissionFlagsBits.ViewChannel]
            },
            {
              id: user.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.AttachFiles
              ]
            },
            {
              id: ADMIN_ROLE_ID,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory
              ]
            },
            {
              id: MODS_ROLE_ID,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory
              ]
            },
            {
              id: client.user.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageChannels
              ]
            }
          ]
        });

        userThreads[user.id] = channel.id;
        threadLastActivity[channel.id] = Date.now();
        channelTopics.set(channel.id, "🚀 Launch a Campaign");
        campaignChannels.add(channel.id);
        analytics.totalThreads++;
        analytics.activeThreads++;
        if (analytics.categories["🚀 Launch a Campaign"] !== undefined) {
          analytics.categories["🚀 Launch a Campaign"]++;
        }

        const submissionId = Date.now().toString() + Math.floor(Math.random() * 1000);
        const timeString = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const submission = {
          id: submissionId,
          userId: user.id,
          userTag: user.tag,
          contact,
          brand,
          product,
          audience,
          budget,
          status: 'Received',
          timestamp: `Today at ${timeString}`,
          channelId: channel.id
        };

        analytics.campaignSubmissions.push(submission);

        try {
          const logChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
          if (logChannel) {
            const logEmbed = new EmbedBuilder()
              .setColor('#00FF00')
              .setAuthor({ name: user.username, iconURL: user.displayAvatarURL({ dynamic: true, size: 1024 }) })
              .setTitle('🚀 New Campaign Launch Submission')
              .addFields(
                { name: 'User', value: `<@${user.id}>`, inline: true },
                { name: 'Brand', value: brand.slice(0, 100), inline: true },
                { name: 'Channel', value: `<#${channel.id}>`, inline: true }
              )
              .setFooter({ text: "ClippingBase AI Campaign Intake", iconURL: client.user.displayAvatarURL() })
              .setTimestamp();

            await logChannel.send({ embeds: [logEmbed] });
          }
        } catch (error) {
          console.error("Could not send campaign log to channel:", error);
        }

        notifyStaffOfCampaignSubmission(channel, user, submission);

        const avatarURL = user.displayAvatarURL({ dynamic: true, size: 1024 });
        const welcomeEmbed = new EmbedBuilder()
          .setColor(0x32CD32)
          .setAuthor({ name: user.username, iconURL: avatarURL })
          .setTitle('🚀 Campaign Launch Form Submitted')
          .setDescription(
            `Your Campaign Launch Form has been submitted! I've let our staff team know to come check this out as soon as possible — they'll be here shortly.\n\n` +
            `Feel free to drop anything else here in the meantime.`
          )
          .setFooter({ text: "ClippingBase AI" })
          .setTimestamp();

        const claimBtn = new ButtonBuilder()
          .setCustomId("claim_chat")
          .setLabel("Claim")
          .setStyle(ButtonStyle.Primary);

        const closeBtn = new ButtonBuilder()
          .setCustomId("close_thread")
          .setLabel("Close Chat")
          .setStyle(ButtonStyle.Danger);

        const row = new ActionRowBuilder().addComponents(claimBtn, closeBtn);

        await channel.send({ content: `<@${user.id}>`, embeds: [welcomeEmbed], components: [row] });

        try {
          const dmEmbed = new EmbedBuilder()
            .setColor(0x32CD32)
            .setDescription(
              `✅ Thanks! We've received your campaign submission for **${brand}**.\n\n` +
              `Our team will reach out to you soon via **email** or **Discord DM**.`
            )
            .setFooter({ text: "ClippingBase AI" })
            .setTimestamp();

          await user.send({ embeds: [dmEmbed] }).catch(() => {});
        } catch (dmErr) {
          console.error("⚠️ Failed to DM campaign confirmation:", dmErr);
        }

        const confirmEmbed = new EmbedBuilder()
          .setColor(0x32CD32)
          .setAuthor({ name: user.username, iconURL: avatarURL })
          .setDescription(`Private chat created ✅ — head over to <#${channel.id}>`)
          .setFooter({ text: "ClippingBase AI" })
          .setTimestamp();

        return interaction.editReply({ embeds: [confirmEmbed] });

      } catch (err) {
        console.error("❌ Error handling campaign modal submission:", err);
        return interaction.editReply({
          content: "❌ Something went wrong submitting your campaign form. Please try again, or contact staff if this keeps happening."
        }).catch(() => {});
      }
    }
  }

  // Handles the "What can we help you with?" dropdown selection — this is
  // where the private support channel actually gets created now.
  if (interaction.isStringSelectMenu() && interaction.customId === 'start_chat_topic_select') {
    const selectedSlug = interaction.values[0];
    const selectedCategory = Object.keys(analytics.categories).find(name => slugifyTopicName(name) === selectedSlug) || 'Uncategorized';

    // 🚀 "Launch a Campaign" branches off into a modal intake form instead of
    // creating a normal AI chat — must happen BEFORE deferUpdate() since a
    // modal can't be shown after an interaction has already been deferred.
    if (selectedCategory === '🚀 Launch a Campaign') {
      if (userThreads[interaction.user.id]) {
        const duplicateEmbed = new EmbedBuilder()
          .setColor(0xFF0000)
          .setDescription("❌ You already have an active chat.");
        return interaction.reply({ embeds: [duplicateEmbed], flags: [MessageFlags.Ephemeral] });
      }

      return interaction.showModal(buildCampaignModal());
    }

    try {
      await interaction.deferUpdate();
    } catch (err) {
      console.error("❌ Failed to defer start_chat_topic_select interaction:", err);
      return;
    }

    try {
      const user = interaction.user;
      const avatarURL = user.displayAvatarURL({ dynamic: true, size: 1024 });

      if (userThreads[user.id]) {
        const duplicateEmbed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setDescription("❌ You already have an active chat.");

        return interaction.editReply({ embeds: [duplicateEmbed], components: [] });
      }

      if (analytics.categories[selectedCategory] !== undefined) {
        analytics.categories[selectedCategory]++;
      }

      const safeName = sanitizeChannelName(`${user.username}-chat`);

      // 📦 Create a real private CHANNEL (instead of a thread) so staff get
      // full channel-level tools (permissions, pins, webhooks, etc).
      const channel = await interaction.guild.channels.create({
        name: safeName,
        type: ChannelType.GuildText,
        parent: SUPPORT_CHATS_CATEGORY_ID,
        topic: `Private ClippingBase AI support chat for ${user.tag} (${user.id}) — Topic: ${selectedCategory}`,
        permissionOverwrites: [
          {
            id: interaction.guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel]
          },
          {
            id: user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.AttachFiles
            ]
          },
          {
            id: ADMIN_ROLE_ID,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory
            ]
          },
          {
            id: MODS_ROLE_ID,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory
            ]
          },
          {
            id: client.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.ManageChannels
            ]
          }
        ]
      });

      userThreads[user.id] = channel.id;
      threadLastActivity[channel.id] = Date.now();
      channelTopics.set(channel.id, selectedCategory);
      analytics.totalThreads++;
      analytics.activeThreads++;

      try {
          const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
          if (logChannel) {
              const logEmbed = new EmbedBuilder()
                  .setColor('#00FF00')
                  .setAuthor({ name: user.username, iconURL: avatarURL })
                  .setTitle('New Private Chat Created')
                  .addFields(
                      { name: 'User', value: `<@${user.id}>`, inline: true },
                      { name: 'Topic', value: `**${selectedCategory}**`, inline: true },
                      { name: 'Channel', value: `<#${channel.id}>`, inline: true }
                  )
                  .setFooter({ 
                      text: "ClippingBase AI Detection System", 
                      iconURL: client.user.displayAvatarURL() 
                  })
                  .setTimestamp();

              await logChannel.send({ embeds: [logEmbed] });
          }
      } catch (error) {
          console.error("Could not send log to channel:", error);
      }

      const successEmbed = new EmbedBuilder()
          .setColor(0x32CD32) 
          .setDescription(`Private chat created ✅ — head over to <#${channel.id}>`)
          .setFooter({ text: "ClippingBase AI" })
          .setTimestamp();

      await interaction.editReply({ embeds: [successEmbed], components: [] });

      // 🤖 Generate a short, topic-specific opening question to include
      // directly inside the welcome embed (no separate message, no delay).
      let openingReply = "Go ahead and tell me what's going on!";
      try {
        const openingResponse = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: `A user just opened a new support chat and selected the topic "${selectedCategory}". Ask ONE short, specific question (max 1 sentence, no greeting) to help you understand their issue related to "${selectedCategory}".`
            }
          ],
          max_tokens: 50
        });

        openingReply = (openingResponse?.choices?.[0]?.message?.content || openingReply)
          .replace(/\n{2,}/g, ' ')
          .trim();
      } catch (err) {
        console.error("⚠️ Failed to generate topic opening question:", err);
      }

      if (!conversations[user.id]) conversations[user.id] = [];
      conversations[user.id].push({ role: "assistant", content: openingReply });

      const welcome = new EmbedBuilder()
          .setColor(0x32CD32)
          .setTitle("ClippingBase AI Chat")
          .setDescription(`Hey <@${user.id}> 👋\n\nYou're now chatting with ClippingBase AI about **${selectedCategory}**.\n${openingReply}`);

      // Claim goes in front of Close, per spec. Only Mods/Admins can
      // successfully use Claim (enforced on click — Discord doesn't support
      // showing a button to only some viewers of the same message).
      const claimBtn = new ButtonBuilder()
          .setCustomId("claim_chat")
          .setLabel("Claim")
          .setStyle(ButtonStyle.Primary);

      const closeBtn = new ButtonBuilder()
          .setCustomId("close_thread")
          .setLabel("Close Chat")
          .setStyle(ButtonStyle.Danger);

      const row = new ActionRowBuilder().addComponents(claimBtn, closeBtn);

      await channel.send({ content: `<@${user.id}>`, embeds: [welcome], components: [row] });

      return;

    } catch (err) {
      console.error("❌ Error while creating support chat channel:", err);
      return interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0xFF0000).setDescription("❌ Something went wrong creating your chat. Please try again, or contact staff if this keeps happening.")],
        components: []
      }).catch(() => {});
    }
  }

  if (interaction.isButton()) {
    // 1. Initial Close Confirmation — jumps straight to Yes/No feedback now,
    // since the topic was already picked from the dropdown when the chat started.
    if (interaction.customId === "confirm_close_yes") { 
      await interaction.deferUpdate();

      const selectedCategory = channelTopics.get(interaction.channel.id) || 'Uncategorized';
      const slug = slugifyTopicName(selectedCategory);

      const row = new ActionRowBuilder().addComponents( 
          new ButtonBuilder().setCustomId(`feedback_yes_${slug}`).setLabel("Yes 👍").setStyle(ButtonStyle.Success), 
          new ButtonBuilder().setCustomId(`feedback_no_${slug}`).setLabel("No 👎").setStyle(ButtonStyle.Danger) 
      ); 

      const embed = new EmbedBuilder()
          .setColor(0x32CD32)
          .setDescription(`Topic: **${selectedCategory}**\n\nDid ClippingBase AI solve your problem?`);

      return interaction.editReply({ embeds: [embed], components: [row] }); 
    }

    // 2. Final Feedback & Cleanup
    if (interaction.customId.startsWith("feedback_yes_") || interaction.customId.startsWith("feedback_no_")) { 
      await interaction.deferUpdate();

      const isYes = interaction.customId.startsWith("feedback_yes_");
      const closerUser = interaction.user; // whoever clicked the button (could be the ticket owner OR staff)
      const channel = interaction.channel; 
      // Prefer the topic stored at chat-creation time (always accurate, even
      // if topics were renamed/added later); fall back to decoding it from
      // the button's customId slug if that map entry is somehow gone.
      const selectedCategory = channelTopics.get(channel?.id) || getTopicLabelFromCustomId(interaction.customId) || 'Unknown Topic';

      // The actual ticket owner, looked up by channel id — NOT necessarily
      // the same as whoever clicked the close/feedback buttons.
      const ticketOwnerId = Object.keys(userThreads).find(uid => userThreads[uid] === channel?.id) || closerUser.id;
      const closedByStaff = ticketOwnerId !== closerUser.id;

      analytics.activeThreads = Math.max(0, analytics.activeThreads - 1); 
      analytics.closedThreads++; 
      isYes ? analytics.solved++ : analytics.unsolved++;

      // 📄 Build a transcript of the full conversation before the channel
      // gets deleted, so it can go to both the log channel and the user's DMs.
      let transcriptText = null;
      try {
        transcriptText = await buildChatTranscript(channel, selectedCategory);
      } catch (transcriptErr) {
        console.error('⚠️ Failed to build chat transcript:', transcriptErr);
      }
      const transcriptFileName = `transcript-${channel?.name || 'support-chat'}.txt`;

      try {
        const logChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        if (logChannel) {
          const closeEmbed = new EmbedBuilder()
            .setColor(isYes ? 0x32CD32 : 0xFF0000)
            .setTitle('✅ Private Chat Closed')
            .addFields(
              { name: 'User', value: `<@${ticketOwnerId}>`, inline: true },
              { name: 'Topic', value: `**${selectedCategory}**`, inline: true },
              { name: 'Resolved', value: `**${isYes ? 'Yes' : 'No'}**`, inline: true },
              { name: 'Channel', value: `<#${channel?.id || 'unknown'}>`, inline: true },
              { name: 'Closed By', value: `<@${closerUser.id}>${closedByStaff ? ' (Support Team)' : ''}`, inline: true }
            )
            .setFooter({
              text: 'ClippingBase AI Detection System',
              iconURL: client.user.displayAvatarURL()
            })
            .setTimestamp();

          await logChannel.send({
            embeds: [closeEmbed],
            files: transcriptText ? [new AttachmentBuilder(Buffer.from(transcriptText, 'utf-8'), { name: transcriptFileName })] : []
          });
        }
      } catch (logErr) {
        console.error('Could not send private chat close log:', logErr);
      }

      // 📩 Always DM the ticket owner a copy of the transcript, with a note
      // if staff were the ones who closed it.
      try {
        const ownerFetch = await client.users.fetch(ticketOwnerId).catch(() => null);
        if (ownerFetch) {
          const dmDescription = closedByStaff
            ? `Hey <@${ticketOwnerId}>, your support chat was closed by our support team.\n\n` +
              `Here's a transcript of the conversation for your records. If your question wasn't resolved, feel free to open a new chat anytime!`
            : `Hey <@${ticketOwnerId}>, your support chat has been closed.\n\n` +
              `Here's a transcript of the conversation for your records. Feel free to open a new chat anytime!`;

          const closeDm = new EmbedBuilder()
            .setColor(0x32CD32)
            .setDescription(dmDescription)
            .setFooter({ text: "ClippingBase AI" })
            .setTimestamp();

          await ownerFetch.send({
            embeds: [closeDm],
            files: transcriptText ? [new AttachmentBuilder(Buffer.from(transcriptText, 'utf-8'), { name: transcriptFileName })] : []
          }).catch(() => {});
        }
      } catch (dmErr) {
        console.error('Failed to DM user the closing transcript:', dmErr);
      }

      // Cleanup logic
      const keysToClear = [ticketOwnerId, channel?.id];
      keysToClear.forEach(key => {
          delete conversations[key]; 
          delete userThreads[key];
          delete antiSpamTracker[key]; 
      });
      delete threadLastActivity[channel?.id];
      claimedChannels.delete(channel?.id);
      channelTopics.delete(channel?.id);
      escalatedChannels.delete(channel?.id);
      campaignChannels.delete(channel?.id);

      const finalEmbed = new EmbedBuilder()
          .setColor(0x32CD32)
          .setDescription(isYes ? "✅ Thanks for your feedback!" : "👍 Got it — we’ll keep improving ClippingBase AI.");

      await interaction.editReply({ embeds: [finalEmbed], components: [] });
      setTimeout(() => channel.delete().catch(() => {}), 2500);
      return;
    }

    if (interaction.customId === "confirm_close_no") { 
      const cancelEmbed = new EmbedBuilder()
          .setColor(0x32CD32) 
          .setDescription("❎ Cancelled. Chat will stay open.");
      return interaction.update({ embeds: [cancelEmbed], components: [] }); 
    }
    
    if (interaction.customId === "admin_add_topic_classification") {
      if (!interaction.member.permissions.has("Administrator")) {
        return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
      }

      const modal = new ModalBuilder()
        .setCustomId('add_topic_modal')
        .setTitle('Add New Closing Topic');

      const topicInput = new TextInputBuilder()
        .setCustomId('topic_name')
        .setLabel("Topic Title")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("e.g. Billing Issue")
        .setRequired(true);

      const actionRow = new ActionRowBuilder().addComponents(topicInput);
      modal.addComponents(actionRow);

      return interaction.showModal(modal);
    }

    if (interaction.customId === "admin_edit_inactivity_timeout") {
      if (!interaction.member.permissions.has("Administrator")) {
        return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
      }

      const modal = new ModalBuilder()
        .setCustomId('edit_timeout_modal')
        .setTitle('Configure Auto-Close Engine');

      const timeoutInput = new TextInputBuilder()
        .setCustomId('timeout_input')
        .setLabel("Inactivity Duration Limit (In Hours)") 
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("e.g. 5")
        .setValue(inactivityTimeoutHours.toString())
        .setRequired(true);

      const actionRow = new ActionRowBuilder().addComponents(timeoutInput);
      modal.addComponents(actionRow);

      return interaction.showModal(modal);
    }

    if (interaction.customId === "admin_view_features") {
      if (!interaction.member.permissions.has("Administrator")) {
        return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
      }

      if (analytics.featureRequests.length === 0) {
        return interaction.reply({ content: "📭 There are currently no feature requests logged.", flags: [MessageFlags.Ephemeral] });
      }

      const data = createFeatureEmbedAndRow(analytics.featureRequests, 0, 'history');
      return interaction.reply({ embeds: data.embeds, components: data.components, flags: [MessageFlags.Ephemeral] });
    }

    if (interaction.customId === "admin_view_pending_features") {
      if (!interaction.member.permissions.has("Administrator")) {
        return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
      }

      const pendings = analytics.featureRequests.filter(r => !r.reviewed);

      if (pendings.length === 0) {
        return interaction.reply({ content: "🎉 All caught up! No pending feature requests found.", flags: [MessageFlags.Ephemeral] });
      }

      const data = createFeatureEmbedAndRow(pendings, 0, 'pending');
      return interaction.reply({ embeds: data.embeds, components: data.components, flags: [MessageFlags.Ephemeral] });
    }

    if (interaction.customId === "admin_view_campaign_subs") {
      if (!interaction.member.permissions.has("Administrator")) {
        return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
      }

      if (analytics.campaignSubmissions.length === 0) {
        return interaction.reply({ content: "📭 No campaign submissions yet.", flags: [MessageFlags.Ephemeral] });
      }

      const data = createCampaignEmbedAndRow(analytics.campaignSubmissions, 0);
      return interaction.reply({ embeds: data.embeds, components: data.components, flags: [MessageFlags.Ephemeral] });
    }

    if (interaction.customId.startsWith("camp_nav_")) {
      const parts = interaction.customId.split("_");
      const direction = parts[2];
      const oldIndex = parseInt(parts[3], 10);

      let targetIndex = direction === 'next' ? oldIndex + 1 : oldIndex - 1;

      if (targetIndex < 0 || targetIndex >= analytics.campaignSubmissions.length) {
        return interaction.reply({ content: "⚠️ Page bounds anomaly detected.", flags: [MessageFlags.Ephemeral] });
      }

      const updatedView = createCampaignEmbedAndRow(analytics.campaignSubmissions, targetIndex);
      return interaction.update({ embeds: updatedView.embeds, components: updatedView.components });
    }

    if (interaction.customId.startsWith("camp_contacted_")) {
      if (!interaction.member.permissions.has("Administrator")) {
        return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
      }

      const parts = interaction.customId.split("_");
      const targetId = parts[2];
      const currentViewIndex = parseInt(parts[3], 10);

      const index = analytics.campaignSubmissions.findIndex(r => r.id === targetId);
      if (index !== -1) {
        analytics.campaignSubmissions[index].status = 'Contacted';
      }

      const targetIndex = Math.min(currentViewIndex, analytics.campaignSubmissions.length - 1);
      const updatedView = createCampaignEmbedAndRow(analytics.campaignSubmissions, targetIndex);
      return interaction.update({ embeds: updatedView.embeds, components: updatedView.components });
    }

    if (interaction.customId.startsWith("feat_nav_")) {
      const parts = interaction.customId.split("_"); 
      const flowType = parts[2];
      const direction = parts[3];
      const oldIndex = parseInt(parts[4], 10);
      
      let targetIndex = direction === 'next' ? oldIndex + 1 : oldIndex - 1;
      const targetDataset = flowType === 'pending' 
        ? analytics.featureRequests.filter(r => !r.reviewed)
        : analytics.featureRequests;

      if (targetIndex < 0 || targetIndex >= targetDataset.length) {
        return interaction.reply({ content: "⚠️ Page bounds anomaly detected.", flags: [MessageFlags.Ephemeral] });
      }

      const updatedView = createFeatureEmbedAndRow(targetDataset, targetIndex, flowType);
      return interaction.update({ embeds: updatedView.embeds, components: updatedView.components });
    }

    if (interaction.customId.startsWith("review_mark_")) {
      if (!interaction.member.permissions.has("Administrator")) {
        return interaction.reply({ content: "❌ Access Denied.", flags: [MessageFlags.Ephemeral] });
      }

      const parts = interaction.customId.split("_"); 
      const targetId = parts[2];
      const flowType = parts[3];
      const currentViewIndex = parseInt(parts[4], 10);

      const index = analytics.featureRequests.findIndex(r => r.id === targetId);
      if (index !== -1) {
        analytics.featureRequests[index].reviewed = true;
      }

      const remainingDataset = flowType === 'pending'
        ? analytics.featureRequests.filter(r => !r.reviewed)
        : analytics.featureRequests;

      if (remainingDataset.length === 0) {
        return interaction.update({
          content: "Base updated natively outside an embed structure context. ✅ Request verified!",
          embeds: [],
          components: []
        });
      }

      let targetIndex = currentViewIndex;
      if (targetIndex >= remainingDataset.length) {
        targetIndex = remainingDataset.length - 1;
      }

      const nextView = createFeatureEmbedAndRow(remainingDataset, targetIndex, flowType);
      return interaction.update({ embeds: nextView.embeds, components: nextView.components });
    }

    if (interaction.customId === "start_chat") {
      const user = interaction.user;

      if (userThreads[user.id]) {
        const duplicateEmbed = new EmbedBuilder()
            .setColor(0xFF0000) 
            .setAuthor({ name: user.username, iconURL: user.displayAvatarURL({ dynamic: true, size: 1024 }) })
            .setDescription("❌ You already have an active chat.")
            .setFooter({ text: "ClippingBase AI" })
            .setTimestamp();

        return interaction.reply({ embeds: [duplicateEmbed], flags: [MessageFlags.Ephemeral] });
      }

      // 🧭 Show the topic picker dropdown FIRST — the channel itself is only
      // created once the user picks what they need help with.
      const topicEmbed = buildTopicListEmbed(interaction.user);
      const selectRow = new ActionRowBuilder().addComponents(buildTopicSelectMenu());

      return interaction.reply({
        embeds: [topicEmbed],
        components: [selectRow],
        flags: [MessageFlags.Ephemeral]
      });
    }

    if (interaction.customId === "claim_chat") {
      const isStaff = isStaffMember(interaction.member);

      if (!isStaff) {
        return interaction.reply({
          content: "❌ Only support staff (Support Team) can claim this chat.",
          flags: [MessageFlags.Ephemeral]
        });
      }

      if (claimedChannels.has(interaction.channel.id)) {
        const claimedBy = claimedChannels.get(interaction.channel.id);
        return interaction.reply({
          content: `⚠️ This chat has already been claimed by <@${claimedBy}>.`,
          flags: [MessageFlags.Ephemeral]
        });
      }

      claimedChannels.set(interaction.channel.id, interaction.user.id);

      // Disable the Claim button on the original message and mark it claimed,
      // keep the Close button intact and functional.
      try {
        const existingRow = interaction.message.components[0];
        const updatedRow = new ActionRowBuilder().addComponents(
          ButtonBuilder.from(existingRow.components[0])
            .setDisabled(true)
            .setLabel(`✅ Claimed by ${interaction.user.username}`),
          ButtonBuilder.from(existingRow.components[1])
        );

        await interaction.update({ components: [updatedRow] });
      } catch (err) {
        console.error("Failed to update claim button state:", err);
        await interaction.deferUpdate().catch(() => {});
      }

      const staffGreetings = [
        `Hey im <@${interaction.user.id}> and ill be assisting you today! how may i help?`,
        `H, <@${interaction.user.id}> here — I'll be assisting you. How may I help you?`,
        `Hello! <@${interaction.user.id}> stepping in to help you out. How can I assist you today?`,
        `Hey there, this is <@${interaction.user.id}> — I've got your chat from here. What do you need help with?`,
        `Hi! <@${interaction.user.id}> jumping in to assist you today. What can I do for you?`,
        `Greetings! <@${interaction.user.id}> here to help. How can I assist you?`,

      ];

      const chosenGreeting = staffGreetings[Math.floor(Math.random() * staffGreetings.length)];
      const staffAvatarURL = interaction.user.displayAvatarURL({ dynamic: true, size: 1024 });
      const guildIconURL = interaction.guild.iconURL({ dynamic: true, size: 1024 });

      const claimEmbed = new EmbedBuilder()
        .setColor(0x32CD32)
        .setAuthor({ name: interaction.user.username, iconURL: staffAvatarURL })
        .setDescription(chosenGreeting)
        .setFooter({ text: interaction.guild.name, iconURL: guildIconURL || undefined })
        .setTimestamp();

      await interaction.channel.send({ embeds: [claimEmbed] }).catch(() => {});
      return;
    }

    if (interaction.customId === 'user_view_new_btn') {
      const avatarURL = interaction.user.displayAvatarURL({ dynamic: true, size: 1024 });
      
      const updateEmbed = new EmbedBuilder()
          .setColor(0x32CD32) 
          .setAuthor({ name: "ClippingBase AI", iconURL: client.user.displayAvatarURL() })
          .setTitle("What's New on ClippingBase ✨")
          .setDescription(whatsNewText) 
          .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: avatarURL })
          .setTimestamp();

      const rateBtn = new ButtonBuilder()
          .setCustomId('rate_update_trigger')
          .setLabel('Rate This Update ⭐')
          .setStyle(ButtonStyle.Primary);

      const featureBtn = new ButtonBuilder()
          .setCustomId('request_feature_trigger')
          .setLabel('Request a Feature 💡')
          .setStyle(ButtonStyle.Success);

      const row = new ActionRowBuilder().addComponents(rateBtn, featureBtn);

      return interaction.reply({ 
          embeds: [updateEmbed], 
          components: [row],
          flags: [MessageFlags.Ephemeral] 
      });
    }

    if (interaction.customId === 'rate_update_trigger') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vote_update_like').setLabel('Like 👍').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('vote_update_dislike').setLabel('Dislike 👎').setStyle(ButtonStyle.Danger)
      );

      return interaction.update({ components: [row] });
    }

    if (interaction.customId === 'vote_update_like' || interaction.customId === 'vote_update_dislike') {
      if (interaction.customId === 'vote_update_like') {
        analytics.updateLikes++;
      } else {
        analytics.updateDislikes++;
      }

      return interaction.update({
        content: "✅ Thanks for letting us know your thoughts!",
        embeds: [],
        components: []
      });
    }

    if (interaction.customId === 'request_feature_trigger') {
      const modal = new ModalBuilder()
        .setCustomId('feature_request_modal')
        .setTitle('Request a Feature');

      const featureInput = new TextInputBuilder()
        .setCustomId('feature_input')
        .setLabel("What feature would you like to see?")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("Type your feature request here...")
        .setMaxLength(100)
        .setRequired(true);

      const actionRow = new ActionRowBuilder().addComponents(featureInput);
      modal.addComponents(actionRow);

      return interaction.showModal(modal);
    }

    if (interaction.customId === "close_thread") { 
      const row = new ActionRowBuilder().addComponents( 
          new ButtonBuilder().setCustomId("confirm_close_yes").setLabel("Yes, close it").setStyle(ButtonStyle.Danger), 
          new ButtonBuilder().setCustomId("confirm_close_no").setLabel("Cancel").setStyle(ButtonStyle.Secondary) 
      ); 

      const avatarURL = interaction.user.displayAvatarURL({ dynamic: true, size: 1024 });
      const initialConfirmEmbed = new EmbedBuilder()
          .setColor(0x32CD32)
          .setAuthor({ name: interaction.user.username, iconURL: avatarURL })
          .setDescription("⚠️ Are you sure you want to close this chat?")
          .setFooter({ text: "ClippingBase AI" })
          .setTimestamp();

      return interaction.reply({ 
          embeds: [initialConfirmEmbed], 
          components: [row], 
          flags: [MessageFlags.Ephemeral] 
      }); 
    } 
  }
});

// =========================
// LOGIN
// =========================
client.login(process.env.DISCORD_TOKEN);
