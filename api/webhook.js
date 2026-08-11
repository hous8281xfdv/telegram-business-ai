// api/webhook.js

// Оперативный кэш в памяти для хранения истории сообщений (для слежки за удалением/изменением)
const messageCache = new Map();

// Функция определения содержимого сообщения
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Tilking AI Webhook is Active!');
  }

  const { TELEGRAM_TOKEN, OPENROUTER_API_KEY, ADMIN_ID } = process.env;

  if (!TELEGRAM_TOKEN || !OPENROUTER_API_KEY || !ADMIN_ID) {
    return res.status(200).send('Missing ENV variables');
  }

  const update = req.body;

  // Функция отправки сообщений
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
    // =================================================================
    // 1. НОВОЕ СООБЩЕНИЕ В ЛС
    // =================================================================
    if (update.business_message) {
      const msg = update.business_message;
      const senderId = msg.from.id;
      const chatId = msg.chat.id;
      const connId = msg.business_connection_id;

      // 💾 Сохраняем в память для истории (чтобы поймать при изменении или удалении)
      const parsed = getMessageContent(msg);
      const cacheKey = `${chatId}:${msg.message_id}`;
      messageCache.set(cacheKey, {
        text: parsed.content,
        type: parsed.type,
        senderName: msg.from.first_name || 'Собеседник',
        senderId: senderId
      });

      // Очистка памяти, если сообщений слишком много
      if (messageCache.size > 1000) {
        const oldestKey = messageCache.keys().next().value;
        messageCache.delete(oldestKey);
      }

      // Игнорим сообщения от владельца аккаунта (ADMIN_ID) и без текста
      if (!msg.text || senderId.toString() === ADMIN_ID) {
        return res.status(200).send('OK');
      }

      let replyText = "";
      try {
        const aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY.trim()}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://vercel.app",
            "X-Title": "TG Userbot"
          },
          body: JSON.stringify({
            model: "meta-llama/llama-3.3-70b-instruct:free",
            messages: [
              {
                role: "system",
                content: `Ты — обычный ровный паренек, сидишь на аккаунте и отвечаешь за владельца в личке в ТГ.

ПРАВИЛА ТВОЕГО СТИЛЯ И ОБЩЕНИЯ:
1. Пиши ВСЁ исключительно с маленькой буквы (без заглавных букв вообще).
2. НЕ пиши как душный умник или бот: не ставь точки в конце предложений, минимизируй запятые и сложную пунктуацию.
3. Общайся простым разговорным языком (как обычные пацаны переписываются в ТГ). Без воды, кратко и строго по теме вопроса.
4. Пофигистичный, простой и расслабленный стиль общения, но отвечай по сути того, что у тебя спросили.
5. Никогда не называй себя ИИ, ботом или Tilking AI. Ты просто чел.`
              },
              { role: "user", content: msg.text }
            ]
          })
        });

        const aiData = await aiResponse.json();

        if (aiResponse.ok && aiData.choices?.[0]?.message?.content) {
          // Принудительно переводим весь ответ в нижний регистр для простого стиля
          replyText = aiData.choices[0].message.content.toLowerCase();
        } else {
          replyText = "да сорян инет тупит чето";
        }
      } catch (aiErr) {
        replyText = "бля ща затуп какой то позже отвечу";
      }

      await sendMessage(chatId, replyText, connId);
    }

    // =================================================================
    // 2. ИЗМЕНЕНИЕ СООБЩЕНИЯ В ЛС
    // =================================================================
    else if (update.edited_business_message) {
      const msg = update.edited_business_message;
      const cacheKey = `${msg.chat.id}:${msg.message_id}`;
      const oldMsg = messageCache.get(cacheKey);

      const oldText = oldMsg ? oldMsg.text : '<i>(сообщение не успело сохраниться в кэше)</i>';
      const newText = msg.text || getMessageContent(msg).content;
      const senderName = msg.from?.first_name || 'Собеседник';

      const note = `✏️ <b>Изменение сообщения!</b>\n` +
                   `<b>От кого:</b> ${senderName}\n\n` +
                   `Было: <s>${oldText}</s>\n` +
                   `Стало: <b>${newText}</b>`;

      // Обновляем данные в кэше
      messageCache.set(cacheKey, {
        text: newText,
        type: getMessageContent(msg).type,
        senderName: senderName,
        senderId: msg.from?.id
      });

      // Лог админу
      await sendMessage(ADMIN_ID, note, null, 'HTML');
    }

    // =================================================================
    // 3. УДАЛЕНИЕ СООБЩЕНИЯ В ЛС
    // =================================================================
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
                 `<b>ID сообщения:</b> ${msgId}\n` +
                 `<i>(Текст не сохранился, так как сообщение пришло до запуска бота)</i>`;
        }

        // Лог админу
        await sendMessage(ADMIN_ID, note, null, 'HTML');
      }
    }

  } catch (globalErr) {
    console.error("Глобальная ошибка:", globalErr);
  }

  return res.status(200).send('OK');
}
