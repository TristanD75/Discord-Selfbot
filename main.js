const { Client } = require('discord.js-selfbot-v13');
const Groq = require('groq-sdk');

const DISCORD_TOKEN = '';
const GROQ_API_KEY = '';
const ACTIVATION_KEYWORD = 'START';

const discordClient = new Client({ checkUpdate: false });
const groqClient = new Groq({ apiKey: GROQ_API_KEY });

const activeChannels = new Set();
let isLocked = false;
let rateLimitUntil = 0;

const systemPrompt = `
Analyze in detail the conversation to respond to the last message with exactly the same writing style, sentence structure, meaning, and context of the other people (not you). WITHOUT INCLUDING THE NAME AT THE BEGINNING WITH THE COLON ':' IN THE MESSAGE YOU WILL WRITE. You must make fairly short sentences, speak naturally, and don't write too well. MAKE QUITE SHORT SENTENCES.
`;

function logEvent(event, details = '') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${event}] ${details}`);
}

function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

discordClient.on('ready', () => {
  logEvent('BOT_READY', `${discordClient.user.username} is ready !`);
});

discordClient.on('messageCreate', async (message) => {
  if (Date.now() < rateLimitUntil) {
    logEvent('RATE_LIMIT', 'Waiting from rate-limit...');
    return;
  }

  if (message.author.id === discordClient.user.id && message.content.trim() === ACTIVATION_KEYWORD) {
    activeChannels.add(message.channel.id);
    logEvent('CHANNEL_ACTIVATED', `Channel ID: ${message.channel.id}`);
    return;
  }

  if (!activeChannels.has(message.channel.id)) return;
  if (message.author.id === discordClient.user.id) return;
  if (isLocked) return;

  await handleMessage(message);
});

function truncateMessage(content, maxLength = 100) {
  return content.length > maxLength ? content.slice(0, maxLength) : content;
}

async function handleMessage(triggerMessage) {
  try {
    isLocked = true;
    const fetchedMessages = await triggerMessage.channel.messages.fetch({ limit: 30 });
    const sortedMessages = fetchedMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const context = [
      { role: 'system', content: systemPrompt.trim() },
      ...sortedMessages.map(msg => {
        let replyInfo = '';
        if (msg.reference && msg.reference.messageId) {
          const repliedMessage = fetchedMessages.get(msg.reference.messageId);
          if (repliedMessage) {
            replyInfo = `(in response to ${repliedMessage.author.username}: "${truncateMessage(repliedMessage.content, 30)}") `;
          }
        }
        return {
          role: msg.author.id === discordClient.user.id ? 'assistant' : 'user',
          content: msg.author.id === discordClient.user.id
            ? truncateMessage(msg.content)
            : `${msg.author.username}: ${replyInfo}${truncateMessage(msg.content)}`
        };
      })
    ];

    await triggerMessage.channel.sendTyping().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, getRandomDelay(2500, 6000)));

    const chatCompletion = await groqClient.chat.completions.create({
      messages: context,
      model: 'llama-3.1-8b-instant'
    });

    const botResponse = chatCompletion.choices[0].message.content ?? '...';
    const newMessages = await triggerMessage.channel.messages.fetch({ after: triggerMessage.id, limit: 1 });

    if (newMessages.size === 0) {
      await triggerMessage.channel.send(botResponse);
      logEvent('MESSAGE_SENT', 'Sent without reply.');
    } else {
      await triggerMessage.reply(botResponse);
      logEvent('MESSAGE_REPLY_SENT', 'Sent with reply.');
    }

  } catch (error) {
    if (error.response && error.response.status === 429) {
      const retryAfter = parseInt(error.response.headers['retry-after'] || '60', 10) * 1000;
      rateLimitUntil = Date.now() + retryAfter;
      logEvent('RATE_LIMIT', `${retryAfter / 1000}s pause from rate-limit.`);
    } else {
      logEvent('ERROR', `ERROR: ${error.message}`);
    }
  } finally {
    isLocked = false;
  }
}

discordClient.login(DISCORD_TOKEN);
