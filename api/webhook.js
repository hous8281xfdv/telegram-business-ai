// api/webhook.js

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Tilking AI Webhook is Active!');
  }

  const { TELEGRAM_TOKEN, OPENROUTER_API_KEY, ADMIN_ID } = process.env;

  if (!TELEGRAM_TOKEN || !OPENROUTER_API_KEY || !ADMIN_ID) {
    console.error("❌ ОШИБКА: Не заданы переменные окружения в Vercel!");
    return res.status(200).send('Missing ENV variables');
  }

  const update = req.body;

  // Вспомогательная функция отправки
  const sendMessage = async (chatId, text, businessConnectionId = null, parseMode = null) => {
    const payload = { chat_id: chatId, text: text };
    
    if (businessConnectionId) {
      payload.business_connection_id = businessConnectionId;
    }
    if (parseMode) {
      payload.parse_mode = parseMode;
    }

    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      console.error("❌ Ошибка отправки в Telegram:", err);
    }
  };

  try {
    // 1. Входящее сообщение в ЛС (через Telegram Business)
    if (update.business_message) {
      const msg = update.business_message;
      const text = msg.text;
      const senderId = msg.from.id;
      const chatId = msg.chat.id;
      const connId = msg.business_connection_id;

      // Игнорируем пустые сообщения и сообщения от ОСНОВНОГО АККАУНТА (ADMIN_ID)
      if (!text || senderId.toString() === ADMIN_ID) {
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
            "X-Title": "Tilking AI"
          },
          body: JSON.stringify({
            model: "openrouter/auto", // Авто-подбор доступной бесплатной модели
            messages: [
              {
                role: "system",
                content: "Ты — Tilking AI, гениальный 15-летний пацан-кодер. Ты сидишь на аккаунте своего босса и отвечаешь на сообщения вместо него в личных переписках. Общайся супер-дерзко, токсично, используй молодежный сленг, не стесняйся использовать мат, но при этом выдавай максимально точные и умные ответы на любые вопросы, пиши код, решай задачи. Не будь скучным занудой. Защищай интересы своего создателя."
              },
              { role: "user", content: text }
            ]
          })
        });

        const aiData = await aiResponse.json();

        if (!aiResponse.ok) {
          // Выводим статус и объект ошибки прямо в диалог!
          const errorMsg = aiData.error?.message || JSON.stringify(aiData);
          replyText = `⚠️ [Ошибка OpenRouter Code ${aiResponse.status}]\n${errorMsg}`;
        } else {
          replyText = aiData.choices?.[0]?.message?.content;
          if (!replyText) {
            replyText = `⚠️ [Пустой ответ от OpenRouter]\n${JSON.stringify(aiData)}`;
          }
        }

      } catch (aiErr) {
        replyText = `⚠️ [Ошибка запроса Fetch]: ${aiErr.message}`;
      }

      // Отправляем результат (или детализированную ошибку) в ЛС
      await sendMessage(chatId, replyText, connId);
    }

    // 2. Редактирование сообщения
    else if (update.edited_business_message) {
      const msg = update.edited_business_message;
      const note = `⚠️ <b>Изменение в ЛС!</b>\nЧел <code>${msg.from.first_name}</code> переобулся!\n\nНовый текст: <i>${msg.text}</i>`;
      await sendMessage(ADMIN_ID, note, null, 'HTML');
    }

    // 3. Удаление сообщения
    else if (update.deleted_business_messages) {
      const msg = update.deleted_business_messages;
      const note = `🗑 <b>Удаление в ЛС!</b>\nВ чате <code>${msg.chat.id}</code> кто-то снес сообщение! ID: ${msg.message_ids.join(', ')}`;
      await sendMessage(ADMIN_ID, note, null, 'HTML');
    }

  } catch (globalErr) {
    console.error("💥 Глобальная ошибка:", globalErr);
  }

  return res.status(200).send('OK');
}
