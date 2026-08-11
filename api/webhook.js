// api/webhook.js
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

// Вспомогательные функции
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// =========================================================
// ХРАНЕНИЕ СОСТОЯНИЯ ЧЕРЕЗ TELEGRAM API (100% НАДЕЖНО)
// =========================================================
async function setTrollState(token, active) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/setMyShortDescription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ short_description: active ? 'troll_on' : 'troll_off' })
    });
  } catch (e) {
    console.error("Ошибка записи состояния в Telegram:", e.message);
  }
}

async function getTrollState(token) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMyShortDescription`);
    const data = await res.json();
    return data.result?.short_description === 'troll_on';
  } catch (e) {
    return true; // При сбое сети продолжаем спам
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

// Запрос к OpenRouter
async function queryOpenRouter(text, apiKey, adminId, sendMessage) {
  const systemPrompt = `Ты — обычный ровный паренек, сидишь на аккаунте и отвечаешь за владельца в личке в ТГ.

ПРАВИЛА ТВОЕГО СТИЛЯ И ОБЩЕНИЯ:
1. Пиши ВСЁ исключительно с маленькой буквы (без заглавных букв вообще).
2. НЕ пиши как душный умник или бот: не ставь точки в конце предложений, минимизируй запятые и сложную пунктуацию.
3. Общайся простым разговорным языком (как обычные пацаны переписываются в ТГ). Без воды, кратко и строго по теме вопроса.
4. Пофигистичный, простой и расслабленный стиль общения, но отвечай по сути того, что у тебя спросили.
5. Никогда не называй себя ИИ, ботом или Tilking AI. Ты просто чел.`;

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

  const sendMessage = async (chatId, text, businessConnectionId = null, parseMode = null) => {
    const payload = { chat_id: chatId, text: text };
    if (businessConnectionId) payload.business_connection_id = businessConnectionId;
    if (parseMode) payload.parse_mode = parseMode;

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
    // 1. НОВОЕ СООБЩЕНИЕ В ЛС
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
          await setTrollState(TELEGRAM_TOKEN, false);
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

            // Ставим флаг работы
            await setTrollState(TELEGRAM_TOKEN, true);
            await sendMessage(chatId, "🚀 троллинг запущен", connId);

            // Порция слов для отправки
            const wordsToSend = words.slice(0, 35);

            for (let i = 0; i < wordsToSend.length; i++) {
              // Каждые 2 слова проверяем, не отправлена ли команда остановки
              if (i > 0 && i % 2 === 0) {
                const active = await getTrollState(TELEGRAM_TOKEN);
                if (!active) {
                  break; // Прерываем спам
                }
              }

              await sendMessage(chatId, wordsToSend[i].toLowerCase(), connId);
              await sleep(120); // Задержка для предотвращения лимитов Telegram
            }

            await setTrollState(TELEGRAM_TOKEN, false);

          } catch (err) {
            await sendMessage(chatId, `⚠️ ошибка при троллинге: ${err.message}`, connId);
          }
          return res.status(200).send('OK');
        }

        return res.status(200).send('OK');
      }

      // Отправка ответа ИИ
      const aiReply = await queryOpenRouter(text, OPENROUTER_API_KEY, ADMIN_ID, sendMessage);

      if (aiReply) {
        await sendMessage(chatId, aiReply, connId);
      } else {
        await sendMessage(chatId, "хз ща инет затупил немного", connId);
      }
    }

    // 2. ИЗМЕНЕНИЕ СООБЩЕНИЯ
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

    // 3. УДАЛЕНИЕ СООБЩЕНИЯ
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
