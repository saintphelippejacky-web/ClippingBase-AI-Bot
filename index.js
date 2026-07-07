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
  AttachmentBuilder
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
const userThreads = {};
const threadLastActivity = {}; // Tracks timestamp of the last message sent in a thread: { [threadId]: timestamp }

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
  
  // Track metrics for micro-scale friction points
  categories: {
    "💸 Payments": 0,
    "👥 Sign-Up Bug": 0,
    "📢 Campaign Inquiry": 0,
    "❓ General Question": 0,
    "📝 Rules and Post Review": 0,
    "❓ Other": 0
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
  const slug = customId.replace(/^feedback_(yes|no)_/, '').replace(/^cat_/, '');
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
  return { ok: true, message: `✅ Added "${cleanName}" to the thread closing topics.` };
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

function buildTopicSelectionRows() {
  const topicNames = Object.keys(analytics.categories);
  const rows = [];

  for (let i = 0; i < topicNames.length; i += 5) {
    const chunk = topicNames.slice(i, i + 5);
    const row = new ActionRowBuilder();

    chunk.forEach((topicName) => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`cat_${slugifyTopicName(topicName)}`)
          .setLabel(topicName)
          .setStyle(ButtonStyle.Secondary)
      );
    });

    rows.push(row);
  }

  return rows;
}

// Helper pagination generator for Feature Request flows
function createFeatureEmbedAndRow(requestsList, currentIndex, flowType) {
  const target = requestsList[currentIndex];
  const serverIcon = client.user.displayAvatarURL();

  const embed = new EmbedBuilder()
    .setColor(0x32CD32)
    .setTitle(flowType === 'pending' ? "⏳ Pending Feature Request" : "💡 Feature Request Detail")
    .setDescription(
      `**Request | By:** <@${target.userId}> (@${target.userTag})\n\n` +
      `"${target.text}"\n\n` +
      `*Item \`${currentIndex + 1}\` of \`${requestsList.length}\` items in this view*`
    )
    .setFooter({ text: `${target.timestamp} • Status: ${target.reviewed ? "✅ Reviewed" : "⏳ Pending"}`, iconURL: serverIcon });

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
You are ClippingBase AI — the official assistant for ClippingBase If a image and sent to you and you see ClippingBase AI text there and user ask is that you? you should answer yes and explain that you are the official AI assistant for ClippingBase and you are here to help users with their questions, issues, and guidance related to ClippingBase.

━━━━━━━━━━━━━━━━━━━
🎯 CORE RULE
- ALWAYS answer user first
- NEVER invent UI or pages
- ONLY use real ClippingBase structure
- IF the user sends an image or screenshot, inspect it carefully and help explain the issue shown

━━━━━━━━━━━━━━━━━━━
💬 STYLE
- friendly
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

Always write in a modern, clean, and professional style.

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
- “Sign Up” = new user account creation intent
- “Login” = existing user access intent

NEVER use:
- sign in
- register
- create account (outside template)

━━━━━━━━━━━━━━━━━━━
🗺️ PLATFORM RULES

● Earnings:
∘ there payment procesessors like Paypal,Cash App, Crypto, and each one has different payout schedule and fees, you can check details at Earnings → Payouts page
∘ there is a $1.50 platform fee for each payout, so if you choose paypal payout and you have $20 ready for payout, you will get $18.50 before your payment method fees
∘ Minimum payout: $15
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

● Support Channel → <#1455662844149366804>
∘ users open tickets for Direct help from staff team and support agents like mods and admins direct users here if you feel like you can't help them or if they have specific questions about their account, payments, campaigns, or any other issues that require staff attention.
∘ Account, payout, and general support tickets or any other issues

● AI Support → <#1511543190803447858>
∘ Automated AI assistance channel for quick help, this is where you are right now! Users can ask questions and get instant AI-generated responses based on the ClippingBase Master System Map. This is ideal for common questions, navigation help, and general guidance without needing to wait for staff response. Users click the "Start Chat" button in this channel to create a private thread with ClippingBase AI for personalized assistance.
∘ Quick answers and troubleshooting help

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

                await logChannel.send({ embeds: [timeoutLogEmbed] });
              }
            } catch (logErr) {
              console.error("Failed handling automated timeout channel log distribution:", logErr);
            }

            await threadChannel.delete().catch(() => {});
          }
        } catch (err) {
          console.error(`Error processing inactivity sweep on thread ID ${threadId}:`, err);
        }

        delete conversations[uid];
        delete userThreads[uid];
        delete threadLastActivity[threadId];
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
    const isBotTrackedThread = message.channel.isThread() && Object.values(userThreads).includes(message.channel.id);

    if (isBotTrackedThread) {
      threadLastActivity[message.channel.id] = Date.now();

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
                content: `⚠️ **Attention Staff!** <@&${ADMIN_ROLE_ID}> <@&${MODS_ROLE_ID}> — Potential thread exploit spam isolated below:`,
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

    if (message.channel.isThread() && message.channel.name.toLowerCase() === `${message.author.username}-chat`.toLowerCase()) {
      (async () => {
        try {
          const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ 
              role: "user", 
              content: `Analyze this user's first message and summarize it into a clean, title-cased channel topic that is exactly 2 to 4 words max. Do not include quotes, punctuation, or filler words. Message: "${userInput}"` 
            }],
            max_tokens: 12,
            temperature: 0.4
          });

          let smartTitle = response.choices[0].message.content.replace(/["'./\\]/g, '').trim();
          const finalTitle = `${message.author.username} - ${smartTitle}`;
          
          await message.channel.edit({ name: finalTitle });
          console.log(`🤖 Thread successfully renamed to: ${finalTitle}`);
        } catch (err) {
          console.error("⚠️ Failed to generate smart AI title:", err);
        }
      })();
    }

    if (!userInput && !hasImage) {
      const avatarURL = message.author.displayAvatarURL({ dynamic: true, size: 1024 });

      const embed = new EmbedBuilder()
        .setColor(0x32CD32)
        .setAuthor({ name: message.author.username, iconURL: avatarURL })
        .setDescription("Yo, what’s up? 😎✌️")
        .setFooter({ text: "ClippingBase AI" })
        .setTimestamp();

      return message.reply({ embeds: [embed] });
    }

    const lower = userInput.toLowerCase();
    const closePhrases = ['close thread', 'close this thread', 'end thread', 'close ticket', 'end ticket'];

    if (closePhrases.some(phrase => lower.includes(phrase))) {
      const avatarURL = message.author.displayAvatarURL({ dynamic: true, size: 1024 });

      if (!message.channel.isThread()) {
        const errorEmbed = new EmbedBuilder()
          .setColor(0xFF0000)
          .setAuthor({ name: message.author.username, iconURL: avatarURL })
          .setDescription("❌ You can only close threads inside an active thread channel!")
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
        .setDescription("⚠️ Are you sure you want to close this thread?")
        .setFooter({ text: "ClippingBase AI" })
        .setTimestamp();

      return message.reply({ embeds: [questionEmbed], components: [row] });
    }

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

      const topicLines = Object.entries(analytics.categories)
        .map(([topicName, count]) => `• **${topicName}:** \`${count}\``)
        .join('\n');

      const embed = new EmbedBuilder()
        .setColor(0x32CD32)
        .setTitle("ClippingBase AI Support Analytics Dashboard")
        .setDescription(
          `### Dashboard\n` +
          `💬 **Messages:** \`${analytics.messages}\`\n\n` +
          `📊 **Total Threads:** \`${analytics.totalThreads}\`\n` +
          `🕒 **Active Threads:** \`${analytics.activeThreads}\`\n` +
          `📤 **Closed Threads:** \`${analytics.closedThreads}\`\n` +
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
          .setStyle(ButtonStyle.Secondary)
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
  }

  if (interaction.isButton()) {
    // 1. Initial Close Confirmation
    if (interaction.customId === "confirm_close_yes") { 
      await interaction.deferUpdate();
      
      const topicRows = buildTopicSelectionRows();
      const embed = new EmbedBuilder()
          .setColor(0x32CD32)
          .setDescription("⚠️ Are you sure? Please select the topic of your inquiry to finish closing the thread.");

      return interaction.editReply({ embeds: [embed], components: topicRows }); 
    }

    // 2. Category Selection (Directly captures the topic)
    if (interaction.customId.startsWith("cat_")) {
        const selectedCategory = getTopicLabelFromCustomId(interaction.customId);

        if (!selectedCategory) {
          return interaction.reply({ content: "⚠️ This topic is no longer available.", flags: [MessageFlags.Ephemeral] });
        }

        analytics.categories[selectedCategory]++;

        const row = new ActionRowBuilder().addComponents( 
            new ButtonBuilder().setCustomId(`feedback_yes_${interaction.customId}`).setLabel("Yes 👍").setStyle(ButtonStyle.Success), 
            new ButtonBuilder().setCustomId(`feedback_no_${interaction.customId}`).setLabel("No 👎").setStyle(ButtonStyle.Danger) 
        ); 

        const embed = new EmbedBuilder()
            .setColor(0x32CD32)
            .setDescription(`Topic: **${selectedCategory}**\n\nDid ClippingBase AI solve your problem?`);

        return interaction.update({ embeds: [embed], components: [row] });
    }

    // 3. Final Feedback & Cleanup
    if (interaction.customId.startsWith("feedback_yes_") || interaction.customId.startsWith("feedback_no_")) { 
      await interaction.deferUpdate();

      const isYes = interaction.customId.startsWith("feedback_yes_");
      const user = interaction.user;
      const channel = interaction.channel; 
      const selectedCategory = getTopicLabelFromCustomId(interaction.customId) || 'Unknown Topic';

      analytics.activeThreads = Math.max(0, analytics.activeThreads - 1); 
      analytics.closedThreads++; 
      isYes ? analytics.solved++ : analytics.unsolved++;

      try {
        const logChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        if (logChannel) {
          const closeEmbed = new EmbedBuilder()
            .setColor(isYes ? 0x32CD32 : 0xFF0000)
            .setTitle('✅ Private Chat Closed')
            .addFields(
              { name: 'User', value: `<@${user.id}>`, inline: true },
              { name: 'Topic', value: `**${selectedCategory}**`, inline: true },
              { name: 'Resolved', value: `**${isYes ? 'Yes' : 'No'}**`, inline: true },
              { name: 'Thread', value: `<#${channel?.id || 'unknown'}>`, inline: true }
            )
            .setFooter({
              text: 'ClippingBase AI Detection System',
              iconURL: client.user.displayAvatarURL()
            })
            .setTimestamp();

          await logChannel.send({ embeds: [closeEmbed] });
        }
      } catch (logErr) {
        console.error('Could not send private chat close log:', logErr);
      }

      // Cleanup logic
      const keysToClear = [user.id, channel?.id];
      keysToClear.forEach(key => {
          delete conversations[key]; 
          delete userThreads[key];
          delete antiSpamTracker[key]; 
      });
      delete threadLastActivity[channel?.id];

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
          .setDescription("❎ Cancelled. Thread will stay open.");
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
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
      const user = interaction.user;
      const avatarURL = user.displayAvatarURL({ dynamic: true, size: 1024 });

      if (userThreads[user.id]) {
        const duplicateEmbed = new EmbedBuilder()
            .setColor(0xFF0000) 
            .setAuthor({ name: user.username, iconURL: avatarURL })
            .setDescription("❌ You already have an active chat.")
            .setFooter({ text: "ClippingBase AI" })
            .setTimestamp();

        return interaction.editReply({ embeds: [duplicateEmbed] });
      }

      const thread = await interaction.channel.threads.create({ 
          name: `${user.username}-chat`, 
          type: ChannelType.PrivateThread, 
          autoArchiveDuration: 60 
      });
      
      await thread.members.add(user.id);
      userThreads[user.id] = thread.id;
      threadLastActivity[thread.id] = Date.now(); 
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
                      { name: 'Thread', value: `<#${thread.id}>`, inline: true }
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
          .setAuthor({ name: user.username, iconURL: avatarURL })
          .setDescription("Private chat created ✅")
          .setFooter({ text: "ClippingBase AI" })
          .setTimestamp();

      await interaction.editReply({ embeds: [successEmbed] });

      const welcome = new EmbedBuilder()
          .setColor(0x32CD32)
          .setTitle("ClippingBase AI Chat")
          .setDescription(`Hey ${user.username} 👋\n\nYou're now chatting with ClippingBase AI.`);

      const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
              .setCustomId("close_thread")
              .setLabel("Close Thread")
              .setStyle(ButtonStyle.Danger)
      );

      await thread.send({ embeds: [welcome], components: [row] });
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
          .setDescription("⚠️ Are you sure you want to close this thread?")
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
