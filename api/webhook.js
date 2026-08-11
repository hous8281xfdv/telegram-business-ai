// api/webhook.js

export default async function handler(req, res) {
  // Telegram стучится только через POST-запросы
  if (req.method !== 'POST') {
    return res.status(200).send('Бот работает. Жду вебхуки от Telegram.');
  }

  // Достаем переменные окружения (не забудь добавить их в настройки Vercel!)
  const { TELEGRAM_TOKEN, OPENROUTER_API_KEY, ADMIN_ID } = process.env;
  
  if (!TELEGRAM_TOKEN || !OPENROUTER_API_KEY || !ADMIN_ID) {
    console.error("ОШИБКА: Не заданы переменные окружения в Vercel.");
    return res.status(500).send('Internal Server Error');
  }

  const update = req.body;

  // Функция для отправки сообщений в Telegram
  const sendMessage = async (chatId, text, businessConnectionId = null, parseMode = null) => {
    const payload = { chat_id: chatId, text: text };
    
    // Если отвечаем в чужой ЛС от твоего лица, нужен этот ID
    if (businessConnectionId) {
      payload.business_connection_id = businessConnectionId;
    }
    // Для красивого форматирования (жирный шрифт, курсив)
    if (parseMode) {
      payload.parse_mode = parseMode;
    }
    
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (error) {
      console.error("Ошибка при отправке сообщения в Telegram:", error);
    }
  };

  try {
    // =================================================================
    // 1. ОБРАБОТКА НОВЫХ СООБЩЕНИЙ В ЛС (Событие business_message)
    // =================================================================
    if (update.business_message) {
      const msg = update.business_message;
      const text = msg.text;
      const senderId = msg.from.id;
      const chatId = msg.chat.id;

      // Игнорируем пустые сообщения (стикеры/голосовые без текста) и твои собственные сообщения
      if (!text || senderId.toString() === ADMIN_ID) {
        return res.status(200).send('OK');
      }

      // Отправляем запрос к нейросети (OpenRouter)
      const aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://vercel.app",
          "X-Title": "Tilking AI"
        },
        body: JSON.stringify({
          model: "openrouter/free", // Можешь поменять на другую бесплатную или платную модель
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
      const reply = aiData.choices?.[0]?.message?.content || "Бля, сервера OpenRouter лежат, потом отвечу.";

      // Отправляем сгенерированный ответ прямо в личку собеседнику от твоего лица
      await sendMessage(chatId, reply, msg.business_connection_id);
    }

    // =================================================================
    // 2. ОБРАБОТКА ИЗМЕНЕННЫХ СООБЩЕНИЙ (Событие edited_business_message)
    // =================================================================
    else if (update.edited_business_message) {
      const msg = update.edited_business_message;
      const note = `⚠️ <b>Изменение в ЛС!</b>\nЧел <code>${msg.from.first_name}</code> переобулся!\n\nНовый текст: <i>${msg.text}</i>`;
      
      // Отправляем лог тебе в личку с ботом (в админку)
      await sendMessage(ADMIN_ID, note, null, 'HTML');
    }

    // =================================================================
    // 3. ОБРАБОТКА УДАЛЕННЫХ СООБЩЕНИЙ (Событие deleted_business_messages)
    // =================================================================
    else if (update.deleted_business_messages) {
      const msg = update.deleted_business_messages;
      const note = `🗑 <b>Удаление в ЛС!</b>\nВ чате <code>${msg.chat.id}</code> кто-то трусливо снес сообщение!\n\nID сообщений: ${msg.message_ids.join(', ')}\n<i>(Сам текст достать нельзя без базы данных)</i>`;
      
      // Отправляем лог тебе в личку
      await sendMessage(ADMIN_ID, note, null, 'HTML');
    }

  } catch (error) {
    console.error("Глобальная ошибка обработки вебхука:", error);
  }

  // Обязательно возвращаем 200 OK, иначе Телеграм будет бесконечно спамить запросами
  res.status(200).send('OK');
}
