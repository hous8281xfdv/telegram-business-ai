import fs from 'fs';
import path from 'path';

// Память для слежки за удаленными и измененными сообщениями
const messageCache = new Map();

// Бесплатные модели OpenRouter
const FREE_MODELS = [
  "google/gemini-2.0-flash-exp:free",
  "meta-llama/llama-3.1-8b-instruct:free",
  "deepseek/deepseek-r1:free",
  "qwen/qwen-2.5-coder-32b-instruct:free",
  "openrouter/auto"
];

// ПРОМПТЫ ДЛЯ 3 МАНЕР РЕЧИ
const SYSTEM_PROMPTS = {
  default: `Ты — обычный ровный паренек, сидишь на аккаунте и отвечаешь за владельца в личке в ТГ.

ПРАВИЛА ТВОЕГО СТИЛЯ И ОБЩЕНИЯ:
1. Пиши ВСЁ исключительно с маленькой буквы (без заглавных букв вообще).
2. НЕ пиши как душный умник или бот: не ставь точки в конце предложений, минимизируй запятые и сложную пунктуацию.
3. Общайся простым разговорным языком (как обычные пацаны переписываются в ТГ). Без воды, кратко и строго по теме вопроса.
4. Пофигистичный, простой и расслабленный стиль общения, но отвечай по сути того, что у тебя спросили.
5. Никогда не называй себя ИИ, ботом или Tilking AI. Ты просто чел.`,

  anime: `Ты — анимешник, отаку и няша, сидишь на аккаунте и отвечаешь за владельца в личке в ТГ.

ПРАВИЛА ТВОЕГО СТИЛЯ И ОБЩЕНИЯ:
1. Пиши ВСЁ исключительно с маленькой буквы (без заглавных букв вообще).
2. Активно используй анимешный сленг и эмотиконы (ня, десу, охайо, uwu, >_<, ^_^, тян, кун, бака).
3. Общайся кавайно, эмоционально, весело, слегка стеснительно, но при этом давай ответ по сути того, что у тебя спросили.
4. Не ставь точки в конце предложений и избегай сложной пунктуации.
5. Никогда не называй себя ИИ или ботом. Ты просто чел.`,

  kid: `Ты — дерзкий, крутой 13-летний пацанчик, сидишь на аккаунте и отвечаешь за владельца в личке в ТГ.

ПРАВИЛА ТВОЕГО СТИЛЯ И ОБЩЕНИЯ:
1. Пиши ВСЁ исключительно с маленькой буквы (без заглавных букв вообще).
2. Используй школьный и молодежный сленг (пон, кринж, база, соло, по фактам, чел, эщкере, ауф, го, пруф).
3. Общайся выпендрежно, максимально дерзко и круто, словно ты самый жесткий на районе и в классе, но при этом давай ответ по сути вопроса.
4. Никаких точек в конце предложений и никакой сложной пунктуации.
5. Никогда не называй себя ИИ или ботом.`
};

// Вспомогательные функции
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// =========================================================
// ХРАНЕНИЕ СОСТОЯНИЯ ЧЕРЕЗ TELEGRAM API
// Short description: "troll_on:anime" или "troll_off:default"
// =========================================================
async function getState(token) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMyShortDescription`);
    const data = await res.json();
    const desc = data.result?.short_description || "troll_off:default";
    const parts = desc.split(":");
    return {
      troll: parts[0] === 'troll_on',
      style: parts[1] || 'default'
    };
  } catch (e) {
    return { troll: false, style: 'default' };
  }
}

async function setState(token, { troll, style }) {
  try {
    const current = await getState(token);
    const newTroll = troll !== undefined ? troll : current.troll;
    const newStyle = style !== undefined ? style : current.style;
    const value = `${newTroll ? 'troll_on' : 'troll_off'}:${newStyle}`;

    await fetch(`https://api.telegram.org/bot${token}/setMyShortDescription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ short_description: value })
    });
  } catch (e) {
    console.error("Ошибка записи состояния в Telegram:", e.message);
  }
}

// Определение типа содержимого
function getMessageContent(msg) {
  if (msg.text) return { type: 'текст', content: msg.text };
  if (msg.voice) return { type: 'голосовое сообщение', content: '🎤 [Голосовое сообщение]' };
  if (msg.photo) return { type: 'фотография', content: msg.caption ? `📸 [Фото]: ${msg.caption}` : '📸 [Фотография]' };
  if (msg.video) return { type: 'видео', content: msg.caption ? `🎥 [Видео]: ${msg.caption}` : '🎥 [Видеозапись]' };
  if (msg.sticker) return { type: 'стикер', content: `🧩 [Стикер ${msg.sticker.emoji || ''}]` };
  if (msg.document) return { type: 'файл', content: `📁 [Файл]: ${msg.document.file_name || ''}` };
  if (msg.audio) return { type: 'аудио', content: '🎵 [Аудиозапись]' };
  return { type: 'сообщение', content: msg.text || msg.caption || '[Медиа/Неизвестный тип]' };
}

// Запрос к OpenRouter с учетом манеры речи
async function queryOpenRouter(text, apiKey, adminId, sendMessage, style = 'default') {
  const systemPrompt = SYSTEM_PROMPTS[style] || SYSTEM_PROMPTS.default;
  const errorLogs = [];

  for (const model of FREE_MODELS) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey.trim()}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://vercel.app",
          "X-Title": "TG Userbot"
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: text }
          ]
        })
      });

      const data = await res.json();

      if (!res.ok) {
        const errDetail = data.error?.message || JSON.stringify(data);
        errorLogs.push(`❌ <b>${model}</b> [HTTP ${res.status}]: ${errDetail}`);
        continue;
      }

      const reply = data.choices?.[0]?.message?.content;
      if (reply && reply.trim().length > 0) {
        return reply.toLowerCase();
      } else {
        errorLogs.push(`⚠️ <b>${model}</b>: Пустой ответ`);
      }
    } catch (e) {
      errorLogs.push(`💥 <b>${model}</b> [Network Err]: ${e.message}`);
    }
  }

  const report = `🚨 <b>ОШИБКА OPENROUTER:</b>\n\n` + errorLogs.join("\n\n");
  await sendMessage(adminId, report, null, 'HTML');

  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Tilking AI Webhook is Active!');
  }

  const { TELEGRAM_TOKEN, OPENROUTER_API_KEY, ADMIN_ID } = process.env;

  if (!TELEGRAM_TOKEN || !OPENROUTER_API_KEY || !ADMIN_ID) {
    return res.status(200).send('Missing ENV variables');
  }

  const update = req.body;

  const sendMessage = async (chatId, text, businessConnectionId = null, parseMode = null, replyMarkup = null) => {
    const payload = { chat_id: chatId, text: text };
    if (businessConnectionId) payload.business_connection_id = businessConnectionId;
    if (parseMode) payload.parse_mode = parseMode;
    if (replyMarkup) payload.reply_markup = replyMarkup;

    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      console.error("Ошибка отправки в Telegram:", err);
    }
  };

  try {
    // 1. ОБРАБОТКА НАЖАТИЯ НА ИНТЕРАКТИВНЫЕ КНОПКИ (CALLBACK QUERY)
    if (update.callback_query) {
      const cb = update.callback_query;
      const senderId = cb.from.id.toString();

      if (senderId === ADMIN_ID) {
        const data = cb.data;
        if (data.startsWith('style_')) {
          const newStyle = data.replace('style_', '');
          await setState(TELEGRAM_TOKEN, { style: newStyle });

          const names = {
            default: "обычный пацан 😎",
            anime: "анимешник 🌸",
            kid: "дерзкий пацанчик (13 лет) 🔥"
          };
          const selectedName = names[newStyle] || newStyle;

          await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cb.id, text: `Манера изменена на: ${selectedName}` })
          });

          await sendMessage(cb.message.chat.id, `✅ манера речи успешно изменена на: <b>${selectedName}</b>`, null, 'HTML');
        }
      }
      return res.status(200).send('OK');
    }

    // 2. НОВОЕ СООБЩЕНИЕ В БИЗНЕС-ЧАТЕ
    if (update.business_message) {
      const msg = update.business_message;
      const text = msg.text ? msg.text.trim() : '';
      const senderId = msg.from.id;
      const chatId = msg.chat.id;
      const connId = msg.business_connection_id;

      // Кэшируем сообщение
      const parsed = getMessageContent(msg);
      const cacheKey = `${chatId}:${msg.message_id}`;
      messageCache.set(cacheKey, {
        text: parsed.content,
        type: parsed.type,
        senderName: msg.from.first_name || 'Собеседник',
        senderId: senderId
      });

      if (messageCache.size > 1000) {
        const oldestKey = messageCache.keys().next().value;
        messageCache.delete(oldestKey);
      }

      // =========================================================
      // ОБРАБОТКА КОМАНД ВЛАДЕЛЬЦА (ADMIN_ID)
      // =========================================================
      if (senderId.toString() === ADMIN_ID) {

        // КНОПКИ СМЕНЫ МАНЕРЫ РЕЧИ
        if (text === '/style' || text.toLowerCase() === 'сменить манеру речи' || text === '/манера') {
          const keyboard = {
            inline_keyboard: [
              [{ text: "😎 Обычный пацан", callback_data: "style_default" }],
              [{ text: "🌸 Анимешник (ня)", callback_data: "style_anime" }],
              [{ text: "🔥 Дерзкий школьник (13 лет)", callback_data: "style_kid" }]
            ]
          };
          await sendMessage(chatId, "🎭 <b>выбери манеру речи:</b>", connId, 'HTML', keyboard);
          return res.status(200).send('OK');
        }

        // БЫСТРЫЕ КОМАНДЫ ПЕРЕКЛЮЧЕНИЯ
        if (text === '/style default') {
          await setState(TELEGRAM_TOKEN, { style: 'default' });
          await sendMessage(chatId, "✅ манера речи: обычный пацан 😎", connId);
          return res.status(200).send('OK');
        }
        if (text === '/style anime') {
          await setState(TELEGRAM_TOKEN, { style: 'anime' });
          await sendMessage(chatId, "✅ манера речи: анимешник 🌸", connId);
          return res.status(200).send('OK');
        }
        if (text === '/style kid') {
          await setState(TELEGRAM_TOKEN, { style: 'kid' });
          await sendMessage(chatId, "✅ манера речи: дерзкий пацанчик (13 лет) 🔥", connId);
          return res.status(200).send('OK');
        }

        if (text === '/off') {
          await sendMessage(chatId, "🔴 автоответчик выключен", connId);
          return res.status(200).send('OK');
        }

        if (text === '/on') {
          await sendMessage(chatId, "🟢 автоответчик включен", connId);
          return res.status(200).send('OK');
        }

        // ОСТАНОВКА ТРОЛЛИНГА
        if (text === '/troll off' || text === '/troll of' || text === '/troll stop') {
          await setState(TELEGRAM_TOKEN, { troll: false });
          await sendMessage(chatId, "🛑 троллинг остановлен", connId);
          return res.status(200).send('OK');
        }

        // ЗАПУСК ТРОЛЛИНГА
        if (text === '/troll' || text === '/troll on') {
          try {
            const filePath = path.join(process.cwd(), 'troll.txt');
            
            if (!fs.existsSync(filePath)) {
              await sendMessage(chatId, "⚠️ файл troll.txt не найден в корне проекта", connId);
              return res.status(200).send('OK');
            }

            const fileContent = fs.readFileSync(filePath, 'utf-8');
            const words = fileContent.split(/\s+/).map(w => w.trim()).filter(Boolean);

            if (words.length === 0) {
              await sendMessage(chatId, "⚠️ файл troll.txt пустой", connId);
              return res.status(200).send('OK');
            }

            await setState(TELEGRAM_TOKEN, { troll: true });
            await sendMessage(chatId, "🚀 троллинг запущен", connId);

            const wordsToSend = words.slice(0, 35);

            for (let i = 0; i < wordsToSend.length; i++) {
              if (i > 0 && i % 2 === 0) {
                const currentState = await getState(TELEGRAM_TOKEN);
                if (!currentState.troll) {
                  break;
                }
              }

              await sendMessage(chatId, wordsToSend[i].toLowerCase(), connId);
              await sleep(120);
            }

            await setState(TELEGRAM_TOKEN, { troll: false });

          } catch (err) {
            await sendMessage(chatId, `⚠️ ошибка при троллинге: ${err.message}`, connId);
          }
          return res.status(200).send('OK');
        }

        return res.status(200).send('OK');
      }

      // ОТВЕТ ИИ ДЛЯ ВСЕХ СООБЩЕНИЙ
      const currentState = await getState(TELEGRAM_TOKEN);
      const aiReply = await queryOpenRouter(text, OPENROUTER_API_KEY, ADMIN_ID, sendMessage, currentState.style);

      if (aiReply) {
        await sendMessage(chatId, aiReply, connId);
      } else {
        await sendMessage(chatId, "хз ща инет затупил немного", connId);
      }
    }

    // 3. ИЗМЕНЕНИЕ СООБЩЕНИЯ
    else if (update.edited_business_message) {
      const msg = update.edited_business_message;
      const cacheKey = `${msg.chat.id}:${msg.message_id}`;
      const oldMsg = messageCache.get(cacheKey);

      const oldText = oldMsg ? oldMsg.text : '<i>(сообщение было отправлено до запуска бота)</i>';
      const newText = msg.text || getMessageContent(msg).content;
      const senderName = msg.from?.first_name || 'Собеседник';

      const note = `✏️ <b>Изменение сообщения!</b>\n` +
                   `<b>От кого:</b> ${senderName}\n\n` +
                   `Было: <s>${oldText}</s>\n` +
                   `Стало: <b>${newText}</b>`;

      messageCache.set(cacheKey, {
        text: newText,
        type: getMessageContent(msg).type,
        senderName: senderName,
        senderId: msg.from?.id
      });

      await sendMessage(ADMIN_ID, note, null, 'HTML');
    }

    // 4. УДАЛЕНИЕ СООБЩЕНИЯ
    else if (update.deleted_business_messages) {
      const msg = update.deleted_business_messages;
      const chatId = msg.chat.id;

      for (const msgId of msg.message_ids) {
        const cacheKey = `${chatId}:${msgId}`;
        const savedMsg = messageCache.get(cacheKey);

        let note = "";
        if (savedMsg) {
          note = `🗑 <b>Удалено сообщение!</b>\n` +
                 `<b>От кого:</b> ${savedMsg.senderName}\n` +
                 `<b>Тип:</b> ${savedMsg.type}\n\n` +
                 `<b>Содержимое:</b> <i>${savedMsg.text}</i>`;
          messageCache.delete(cacheKey);
        } else {
          note = `🗑 <b>Удалено сообщение!</b>\n` +
                 `<b>ID:</b> ${msgId}\n` +
                 `<i>(Сообщение было отправлено до запуска бота)</i>`;
        }

        await sendMessage(ADMIN_ID, note, null, 'HTML');
      }
    }

  } catch (globalErr) {
    console.error("Глобальная ошибка:", globalErr);
  }

  return res.status(200).send('OK');
}
