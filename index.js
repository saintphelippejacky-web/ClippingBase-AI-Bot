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
  MessageFlags
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
// GLOBAL ERROR PROTECTION (VERY IMPORTANT)
// =========================

process.on("unhandledRejection", (reason, promise) => {
  console.error("🔥 Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("🔥 Uncaught Exception:", err);
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// 🧠 memory
let conversations = {};
const userThreads = {};
const threadTimeouts = {};

const analytics = {
  activeThreads: 0,
  totalThreads: 0,
  closedThreads: 0,
  solved: 0,
  unsolved: 0,
  messages: 0,
  fallback: 0,
  errors: 0
};

// =========================
// 🧠 SYSTEM PROMPT (LOCKED LOGIN FORMAT)
// =========================
const SYSTEM_PROMPT = `
You are ClippingBase AI — the official assistant for ClippingBase

━━━━━━━━━━━━━━━━━━━
🎯 CORE RULE
- ALWAYS answer user first
- NEVER invent UI or pages
- ONLY use real ClippingBase structure

━━━━━━━━━━━━━━━━━━━
💬 STYLE
- friendly
- human
- simple
- not robotic

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
- For example, if a user has a payout issue that you cannot resolve, you would say: "For payout issues, please contact our 
support team by mentioning the Admin role <@&1360755486793666580> or the Mods role <@&1476806644900827239> in the #support channel <#1455662844149366804>."
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
∘ Used to verify yourself as a real user and not a bot verify simply by clikcing the ✅Verify button in that channel upon clikcking 
the button you will be granted the Clipper role 1360418625307152414 which will give you access to the rest of the server channels and features
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
∘ Automated AI assistance channel for quick help, this is where you are right now! Users can ask questions and get instant AI-generated responses based on the ClippingBase Master System Map. This is ideal for common questions, navigation help, and general guidance without
 needing to wait for staff response. Users click the "Start Chat" button in this channel to create a private thread with ClippingBase AI for personalized assistance.
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

The CLIPPINGBASE MASTER SYSTEM MAP is the source of truth for all navigation questions. Do not tells users  based on the ClippingBase Master System Map. when telling locations. Those AI responses are generated by you.

LANDING PAGE
https://clippingbase.com

Top Bar:
● Left: ClippingBase logo
● Right: Hamburger menu

Landing Page Menu:
● Contact Page
● I'm a Creator

CREATOR PAGE
https://clippingbase.com/creator

Creator Page Menu:
● Contact
● Login

LOGIN POPUP

Title:
● Welcome, back

Options:
● Continue with Discord
● Continue with Email
● Continue with Google (Coming Soon)

Client Section:
● Are you a Client?
● Sign In as a Client (Coming Soon)

DESKTOP NAVIGATION

Top Navigation:
● Home
● Campaigns
● Leaderboard
● Socials
● Earnings
● My Campaigns

Right Side:
● Theme Toggle
● Notifications
● Profile Avatar

Profile Popup:
● Avatar
● Username
● Email
● Settings
● Support
● Report Bug
● Logout

MOBILE NAVIGATION

Bottom Navigation:
● Dashboard
● Earnings
● Campaigns
● Socials
● More

More Menu:
● My Campaigns
● Leaderboard
● Settings
● Support

Mobile Top Bar:
● Left: ClippingBase Logo
● Right: Notifications and Profile Avatar

Mobile Profile Popup:
● Avatar
● Username
● Email
● Theme Toggle
● Settings
● Support
● Logout

LEADERBOARD

Desktop:
● Top Navigation → Leaderboard

Mobile:
● More → Leaderboard

SUPPORT

Email:
● hello@clippingbase.com

Bug Reports:
● Profile Avatar → Report Bug

Users can:
● Submit text reports
● Upload screenshots/images
● Describe issues

RULES:
● NEVER guess UI locations
● ALWAYS use this map
● NEVER tell users to look around
● ALWAYS provide exact navigation paths

━━━━━━━━━━━━━━━━━━━
📌 RULE
Always guide users step-by-step using real UI only.
`;

// =========================
// INTENT DETECTOR
// =========================
function detectIntent(text) {
  const t = text.toLowerCase();

  if (/\b(sign up|signup|join|new here|start)\b/.test(t)) return "signup";
  if (/\b(login|log in|sign in|create account|register)\b/.test(t)) return "login";
  if (/\b(earnings|withdraw|payout|money)\b/.test(t)) return "earnings";
  if (/\b(campaign|campaigns|tasks)\b/.test(t)) return "campaigns";

  return "default";
}

// =========================
// BUTTONS
// =========================
function getButtons(intent) {

  if (intent === "signup") {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("Creator Sign Up")
          .setStyle(ButtonStyle.Link)
          .setURL("https://clippingbase.com/creator")
      )
    ];
  }

  if (intent === "login") {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("Creator Sign In")
          .setStyle(ButtonStyle.Link)
          .setURL("https://clippingbase.com/creator")
      )
    ];
  }

  return [];
}

// =========================
// BOT
// =========================
client.on('messageCreate', async (message) => {

  try {

    if (message.author.bot) return;

    const userId = message.author.id;
    analytics.messages++;

    const userInput = message.content.replace(/<@!?\d+>/g, '').trim();


// ==========================================
// 🏷️ AI-POWERED SMART THREAD RENAMING (GPT-4o-Mini)
// ==========================================
if (message.channel.isThread() && message.channel.name.toLowerCase() === `${message.author.username}-chat`.toLowerCase()) {

    (async () => {
        try {
            // Call the OpenAI API using your gpt-4o-mini configuration
            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ 
                    role: "user", 
                    content: `Analyze this user's first message and summarize it into a clean, title-cased channel topic that is exactly 2 to 4 words max. Do not include quotes, punctuation, or filler words. Message: "${userInput}"` 
                }],
                max_tokens: 12,
                temperature: 0.4
            });

            // Isolate and sanitize the generated string
            let smartTitle = response.choices[0].message.content.replace(/["'./\\]/g, '').trim();
            
            // Format to exact specs: "Username - Summarized Topic"
            const finalTitle = `${message.author.username} - ${smartTitle}`;
            
            // Push the rename update to the Discord thread API channel structure
            await message.channel.edit({ name: finalTitle });
            console.log(`🤖 Thread successfully renamed to: ${finalTitle}`);
        } catch (err) {
            console.error("⚠️ Failed to generate smart AI title:", err);
        }
    })();
}




    // =========================
    // EMPTY / MENTION ONLY CASE
    // =========================
    if (!userInput) {

      const avatarURL = message.author.displayAvatarURL({
        dynamic: true,
        size: 1024
      });

      const embed = new EmbedBuilder()
        .setColor(0x32CD32)
        .setAuthor({
          name: message.author.username,
          iconURL: avatarURL
        })
        .setDescription("Yo, what’s up? 😎✌️")
        .setFooter({ text: "ClippingBase AI" })
        .setTimestamp();

      return message.reply({ embeds: [embed] });
    }

    const lower = userInput.toLowerCase();

// ==========================================
// 🧵 TEXT-TRIGGERED THREAD CLOSURE DETECTION
// ==========================================
const closePhrases = ['close thread', 'close this thread', 'end thread', 'close ticket', 'end ticket'];

if (closePhrases.some(phrase => lower.includes(phrase))) {
    const avatarURL = message.author.displayAvatarURL({ dynamic: true, size: 1024 });

    // Check if this message happened outside a thread
    if (!message.channel.isThread()) {
        const errorEmbed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setAuthor({ name: message.author.username, iconURL: avatarURL })
            .setDescription("❌ You can only close threads inside an active thread channel!")
            .setFooter({ text: "ClippingBase AI" })
            .setTimestamp();

        return message.reply({ embeds: [errorEmbed] });
    }

    // Directly display your existing confirmation buttons
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("confirm_close_yes")
            .setLabel("Yes, close it")
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId("confirm_close_no")
            .setLabel("Cancel")
            .setStyle(ButtonStyle.Secondary)
    );

    // Create an embed version of your question to preserve your custom avatar styling
    const questionEmbed = new EmbedBuilder()
        .setColor(0x32CD32) // Uses your standard green theme
        .setAuthor({ name: message.author.username, iconURL: avatarURL })
        .setDescription("⚠️ Are you sure you want to close this thread?")
        .setFooter({ text: "ClippingBase AI" })
        .setTimestamp();

    return message.reply({ embeds: [questionEmbed], components: [row] });
}



// Your existing AI / database logic continues below...


    // =========================
    // MEMORY INIT
    // =========================
    if (!conversations[userId]) conversations[userId] = [];

    conversations[userId].push({
      role: "user",
      content: userInput
    });

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

    conversations[userId].push({
      role: "assistant",
      content: reply
    });

    if (conversations[userId].length > 14) {
      conversations[userId].shift();
    }

    const avatarURL = message.author.displayAvatarURL({
      dynamic: true,
      size: 1024
    });

    const embed = new EmbedBuilder()
      .setColor(0x32CD32)
      .setAuthor({
        name: message.author.username,
        iconURL: avatarURL
      })
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
// COMMAND
const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Send a custom ClippingBase AI panel')
    .addStringOption(option =>
      option.setName('title').setDescription('Embed title').setRequired(true))
    .addStringOption(option =>
      option.setName('description').setDescription('Embed description').setRequired(true))
    .addStringOption(option =>
      option.setName('image').setDescription('Image URL').setRequired(false))
    .addStringOption(option =>
      option.setName('color').setDescription('Hex color').setRequired(false)),

  new SlashCommandBuilder()
    .setName('analytics')
    .setDescription('Show ClippingBase AI performance dashboard')
].map(cmd => cmd.toJSON());


// READY EVENT
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setPresence({
  activities: [
    {
      name: "ClippingBase.com",
      type: 3 // WATCHING
    }
  ],
  status: "online"
});

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );

    console.log("✅ Slash command registered");
  } catch (err) {
    console.error(err);
  }
});

// =========================
// INTERACTIONS
// =========================
client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton()) {
        if (interaction.customId === "start_chat") {
            await interaction.deferReply({ ephemeral: true });
            const user = interaction.user;
            const avatarURL = user.displayAvatarURL({ dynamic: true, size: 1024 });

            // Case 1: User already has an active chat session open
            if (userThreads[user.id]) {
                const duplicateEmbed = new EmbedBuilder()
                    .setColor(0xFF0000) // Red warning border
                    .setAuthor({ name: user.username, iconURL: avatarURL })
                    .setDescription("❌ You already have an active chat.")
                    .setFooter({ text: "ClippingBase AI" })
                    .setTimestamp();

                return interaction.editReply({ embeds: [duplicateEmbed] });
            }

            // Create the private thread channel
            const thread = await interaction.channel.threads.create({ 
                name: `${user.username}-chat`, 
                type: ChannelType.PrivateThread, 
                autoArchiveDuration: 60 
            });
            
            await thread.members.add(user.id);
            userThreads[user.id] = thread.id;
            analytics.totalThreads++;
            analytics.activeThreads++;

            // Case 2: Successfully created a new private thread channel
            const successEmbed = new EmbedBuilder()
                .setColor(0x32CD32) // Standard green theme
                .setAuthor({ name: user.username, iconURL: avatarURL })
                .setDescription("Private chat created ✅")
                .setFooter({ text: "ClippingBase AI" })
                .setTimestamp();

            await interaction.editReply({ embeds: [successEmbed] });

            // Send the welcome payload inside the new thread
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

    // FIXED: Uses flags instead of the deprecated ephemeral attribute
    return interaction.reply({ 
        content: null, 
        embeds: [initialConfirmEmbed], 
        components: [row], 
        flags: [MessageFlags.Ephemeral] 
    }); 
} 


if (interaction.customId === "confirm_close_no") { 
    const avatarURL = interaction.user.displayAvatarURL({ dynamic: true, size: 1024 });
    const cancelEmbed = new EmbedBuilder()
        .setColor(0x32CD32) // Standard green theme
        .setAuthor({ name: interaction.user.username, iconURL: avatarURL })
        .setDescription("❎ Cancelled. Thread will stay open.")
        .setFooter({ text: "ClippingBase AI" })
        .setTimestamp();

    return interaction.update({ content: null, embeds: [cancelEmbed], components: [] }); 
} 

if (interaction.customId === "confirm_close_yes") { 
    const row = new ActionRowBuilder().addComponents( 
        new ButtonBuilder().setCustomId("feedback_yes").setLabel("Yes 👍").setStyle(ButtonStyle.Success), 
        new ButtonBuilder().setCustomId("feedback_no").setLabel("No 👎").setStyle(ButtonStyle.Danger) 
    ); 

    const avatarURL = interaction.user.displayAvatarURL({ dynamic: true, size: 1024 });
    const feedbackEmbed = new EmbedBuilder()
        .setColor(0x32CD32)
        .setAuthor({ name: interaction.user.username, iconURL: avatarURL })
        .setDescription("💬 Did ClippingBase AI solve your problem?")
        .setFooter({ text: "ClippingBase AI" })
        .setTimestamp();

    return interaction.update({ content: null, embeds: [feedbackEmbed], components: [row] }); 
} 

if (interaction.customId === "feedback_yes" || interaction.customId === "feedback_no") { 
    const channel = interaction.channel; 
    const isYes = interaction.customId === "feedback_yes";

    // 1. Process Analytics
    analytics.activeThreads = Math.max(0, analytics.activeThreads - 1); 
    analytics.closedThreads++; 
    if (isYes) {
        analytics.solved++;
    } else {
        analytics.unsolved++;
    }

    // 2. 🛡️ AGGRESSIVE SESSION WIPE (Fixes the duplicate active chat bug)
    // Gather all possible keys your database might be tracking
    const keysToClear = new Set();
    
    if (interaction.user.id) keysToClear.add(interaction.user.id);
    if (channel && channel.id) keysToClear.add(channel.id);
    if (channel && channel.isThread() && channel.ownerId) keysToClear.add(channel.ownerId);

    // Loop through keys and clear conversations/userThreads
    keysToClear.forEach(key => {
        if (typeof conversations !== 'undefined' && conversations[key]) delete conversations[key]; 
        if (typeof userThreads !== 'undefined' && userThreads[key]) delete userThreads[key];
    });

    // Also scan your userThreads object by value in case the thread ID is saved inside it
    if (typeof userThreads !== 'undefined' && channel && channel.id) {
        for (const [uid, tid] of Object.entries(userThreads)) {
            if (tid === channel.id) {
                delete userThreads[uid];
                if (typeof conversations !== 'undefined') delete conversations[uid];
            }
        }
    }

    // 3. Render Visual Embed Frame
    const avatarURL = interaction.user.displayAvatarURL({ dynamic: true, size: 1024 });
    const finalEmbed = new EmbedBuilder()
        .setColor(0x32CD32)
        .setAuthor({ name: interaction.user.username, iconURL: avatarURL })
        .setDescription(isYes 
            ? "✅ Thanks for your feedback! Closing thread..." 
            : "👍 Got it — we’ll keep improving ClippingBase AI."
        )
        .setFooter({ text: "ClippingBase AI" })
        .setTimestamp();

    return interaction.update({ content: null, embeds: [finalEmbed], components: [] })
        .then(() => {
            // Delete channel safely
            setTimeout(() => channel.delete().catch(() => {}), 2500); 
        });
  }

  }

  if (!interaction.isChatInputCommand()) return;

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

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("start_chat")
        .setLabel("Start Chat 🚀")
        .setStyle(ButtonStyle.Success)
    );

    return interaction.reply({
      embeds: [embed],
      components: [row]
    });
  }

  if (interaction.commandName === "analytics") {
    if (!interaction.member.permissions.has("Administrator")) {
      return interaction.reply({
        content: "❌ Admin only.",
        ephemeral: true
      });
    }

    const rate =
      analytics.closedThreads === 0
        ? 0
        : Math.round((analytics.solved / analytics.closedThreads) * 100);

    const embed = new EmbedBuilder()
      .setColor(0x32CD32)
      .setTitle("ClippingBase AI Support Analytics Dashboard")
      .addFields(
        { name: " 💬 Messages", value: `${analytics.messages}`, inline: true },
        { name: " 📊 Total Threads", value: `${analytics.totalThreads}`, inline: true },
        { name: " 🕒 Active Threads", value: `${analytics.activeThreads}`, inline: true },
        { name: " 📤 Closed Threads", value: `${analytics.closedThreads}`, inline: true },
        { name: " ✅ Solved", value: `${analytics.solved}`, inline: true },
        { name: " ❌ Unsolved", value: `${analytics.unsolved}`, inline: true },
        { name: " 🎯 Resolution Rate", value: `${rate}%`, inline: true },
      )
      .setTimestamp();

    return interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
  }
});

// Log in the Discord client
client.login(process.env.DISCORD_TOKEN);
