require('dotenv').config({ path: './secrets.env' });
const { Client, GatewayIntentBits, SlashCommandBuilder, Routes } = require('discord.js');
const { REST } = require('@discordjs/rest');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

// CONFIG
const CLIENT_ID = '1435372712515338250';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY?.trim();
const LOG_FILE = path.join(__dirname, 'bot_logs.txt');

if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 32) {
    console.error('ENCRYPTION_KEY must be set in .env and be 32 characters long.');
    process.exit(1);
}

const IV_LENGTH = 16;
const ACTIVE_SESSIONS = new Set(); // track ongoing chat sessions

// LOGGING HELPER
function logMessage(message) {
    const timestamp = new Date().toISOString();
    const fullMessage = `[${timestamp}] ${message}\n`;
    console.log(fullMessage.trim());
    fs.appendFile(LOG_FILE, fullMessage, err => {
        if (err) console.error('Failed to write to log file:', err);
    });
}

// ENCRYPTION HELPERS
function encrypt(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
    try {
        const parts = text.split(':');
        if (parts.length < 2) throw new Error('Invalid encrypted text');
        const iv = Buffer.from(parts.shift(), 'hex');
        const encryptedText = parts.join(':');
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch {
        throw new Error('Failed to decrypt text');
    }
}

// DATA
const DATA_FILE = process.env.RENDER_DISK_PATH
  ? path.join(process.env.RENDER_DISK_PATH, 'user_data.json')
  : path.join(__dirname, 'user_data.json');

let userData = {};
if (fs.existsSync(DATA_FILE)) {
    try {
        userData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    } catch {
        logMessage('Failed to parse user_data.json, starting fresh.');
        userData = {};
    }
}

async function saveUserData() {
    try {
        await fs.promises.writeFile(DATA_FILE, JSON.stringify(userData, null, 2), 'utf-8');
        logMessage('User data saved successfully.');
    } catch (err) {
        logMessage(`Failed to save user data: ${err}`);
    }
}

// DISCORD CLIENT
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// COMMANDS
const commandList = [
    new SlashCommandBuilder()
        .setName('chat')
        .setDescription('Chat with OpenAI using your custom prompt')
        .addStringOption(option =>
            option.setName('prompt_id')
                  .setDescription('Custom system prompt (optional)')
                  .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('setprompt')
        .setDescription('Save your custom system prompt (max 4000 characters)')
        .addStringOption(option =>
            option.setName('prompt_id')
                  .setDescription('Enter your prompt (max 4000 chars)')
                  .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('promptlimit')
        .setDescription('Show the 4000-character limit for prompts'),
    new SlashCommandBuilder()
        .setName('setkey')
        .setDescription('Save your OpenAI API key (encrypted)')
        .addStringOption(option =>
            option.setName('openai_key')
                  .setDescription('Enter your OpenAI API key')
                  .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('deleteprompt')
        .setDescription('Delete your saved custom system prompt'),
    new SlashCommandBuilder()
        .setName('deletekey')
        .setDescription('Delete your saved OpenAI API key'),
    new SlashCommandBuilder()
        .setName('info')
        .setDescription('Show your saved key and prompt status'),
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show help info for all commands')
];

const commands = commandList.map(cmd => cmd.toJSON());
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

// REGISTER COMMANDS
(async () => {
    try {
        logMessage('Registering commands...');
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        logMessage('Commands registered successfully.');
    } catch (error) {
        logMessage(`Command registration failed: ${error}`);
    }
})();

// CHAT HANDLER
async function handleChatCommand(interaction, userId) {
    if (ACTIVE_SESSIONS.has(userId)) {
        await interaction.reply({
            content: `<@${userId}>, you already have an active session. Type "exit" to end it first.`,
            ephemeral: true
        });
        return;
    }

    let prompt = interaction.options.getString('prompt_id');
    const encryptedKey = userData[userId]?.openaiKey;

    if (!encryptedKey) {
        await interaction.reply({ content: 'You have no saved OpenAI API key. Use `/setkey` first.', ephemeral: true });
        return;
    }

    let openaiKey;
    try {
        openaiKey = decrypt(encryptedKey);
    } catch {
        await interaction.reply({ content: 'Failed to read your key. Please reset it with `/setkey`.', ephemeral: true });
        return;
    }

    if (prompt) {
        userData[userId].promptId = prompt;
        await saveUserData();
    } else {
        prompt = userData[userId]?.promptId;
    }

    if (!prompt) {
        await interaction.reply({ content: 'No custom prompt found. Use `/setprompt` or provide one with `/chat`.', ephemeral: true });
        return;
    }

    ACTIVE_SESSIONS.add(userId);

    const replyMsg = await interaction.reply({
        content: `**Custom system prompt:**\n\`\`\`\n${prompt}\n\`\`\`\nWhat would you like to ask? (Type "exit" to end the chat)`,
        fetchReply: true,
        ephemeral: true
    });
    setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);

    const channel = await client.channels.fetch(interaction.channelId);
    const filter = m => m.author.id === userId && m.channelId === interaction.channelId;
    const collector = channel.createMessageCollector({ filter, time: 300000 }); // 5 min timeout

    collector.on('collect', async m => {
        const userMsg = m.content.trim();

        if (['exit', 'stop'].includes(userMsg.toLowerCase())) {
            await m.reply('✅ Chat session ended.');
            collector.stop();
            return;
        }

        await m.channel.sendTyping();

        const payload = {
            model: 'gpt-4',
            max_tokens: 500,
            messages: [
                { role: 'system', content: prompt },
                { role: 'user', content: userMsg }
            ]
        };

        const req = https.request({
            hostname: 'api.openai.com',
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${openaiKey}`,
                'Content-Type': 'application/json'
            }
        }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', async () => {
                try {
                    const result = JSON.parse(data);
                    const reply = result.choices?.[0]?.message?.content || 'No response from OpenAI.';
                    await m.reply(reply);
                } catch {
                    await m.reply('⚠️ Failed to get a valid response from OpenAI.');
                }
            });
        });

        req.on('error', async () => {
            await m.reply('❌ Error communicating with OpenAI API.');
        });

        req.write(JSON.stringify(payload));
        req.end();
    });

    collector.on('end', collected => {
        ACTIVE_SESSIONS.delete(userId);
        logMessage(`Chat session with ${userId} ended. Messages collected: ${collected.size}`);
        channel.send(`<@${userId}>, your chat session has expired after 5 minutes. Use /chat to start a new one.`);
    });
}

// INTERACTIONS
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const userId = interaction.user.id;
    if (!userData[userId]) userData[userId] = {};

    try {
        switch (interaction.commandName) {
            case 'setprompt': {
                const prompt = interaction.options.getString('prompt_id');
                const charCount = prompt.length;
                const charLimit = 4000;
                const userMention = `<@${userId}>`;

                if (charCount > charLimit) {
                    await interaction.reply({
                        content: `${userMention}, your prompt is **too long** — you used **${charCount} / ${charLimit} characters**. ❌\nPlease shorten it.`,
                        ephemeral: true
                    });
                    return;
                }

                userData[userId].promptId = prompt;
                await saveUserData();
                logMessage(`User ${userId} saved a new prompt. Character count: ${charCount}`);
                await interaction.reply({
                    content: `${userMention}, your custom prompt has been saved! ✅\nCharacter count: **${charCount} / ${charLimit}**.`,
                    ephemeral: true
                });
                break;
            }

            case 'promptlimit':
                await interaction.reply({ content: `<@${userId}>, your prompt can be up to 4000 characters.`, ephemeral: true });
                break;

            case 'setkey':
                userData[userId].openaiKey = encrypt(interaction.options.getString('openai_key'));
                await saveUserData();
                logMessage(`User ${userId} saved an API key.`);
                await interaction.reply({ content: 'Your OpenAI API key has been saved securely! ✅', ephemeral: true });
                break;

            case 'deleteprompt':
                if (userData[userId].promptId) {
                    delete userData[userId].promptId;
                    await saveUserData();
                    logMessage(`User ${userId} deleted their prompt.`);
                    await interaction.reply({ content: 'Your custom prompt was deleted. ✅', ephemeral: true });
                } else await interaction.reply({ content: 'No custom prompt to delete.', ephemeral: true });
                break;

            case 'deletekey':
                if (userData[userId].openaiKey) {
                    delete userData[userId].openaiKey;
                    await saveUserData();
                    logMessage(`User ${userId} deleted their API key.`);
                    await interaction.reply({ content: 'Your OpenAI API key was deleted. ✅', ephemeral: true });
                } else await interaction.reply({ content: 'No OpenAI API key to delete.', ephemeral: true });
                break;

            case 'info': {
                const user = userData[userId];
                await interaction.reply({
                    content:
                        `**Your current setup:**\n` +
                        `• API key: ${user?.openaiKey ? '✅ Saved' : '❌ Not saved'}\n` +
                        `• Prompt: ${user?.promptId ? '✅ Saved' : '❌ Not saved'}`,
                    ephemeral: true
                });
                break;
            }

            case 'help':
                await interaction.reply({
                    content:
                        `**Command List:**\n` +
                        `/chat — Start a chat with OpenAI using your saved or temporary prompt\n` +
                        `/setprompt — Save a custom prompt (max 4000 characters)\n` +
                        `/promptlimit — Show the prompt character limit\n` +
                        `/setkey — Save your OpenAI API key securely\n` +
                        `/deleteprompt — Delete your saved prompt\n` +
                        `/deletekey — Delete your saved OpenAI key\n` +
                        `/info — Show saved key and prompt status\n` +
                        `/help — Show this help message`,
                    ephemeral: true
                });
                break;

            case 'chat':
                await handleChatCommand(interaction, userId);
                break;

            default:
                await interaction.reply({ content: 'Unknown command.', ephemeral: true });
        }
    } catch (err) {
        logMessage(`Error handling command ${interaction.commandName}: ${err}`);
        if (!interaction.replied) await interaction.reply({ content: 'An error occurred.', ephemeral: true });
    }
});

client.login(process.env.DISCORD_TOKEN);