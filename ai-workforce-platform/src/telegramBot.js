require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

// استدعاء الوكيل الشامل من الهيكلة الأساسية للمشروع
// تأكد من المسار الصحيح للملف بناءً على هيكلة الكود لديك
const { UniversalAgent } = require('./core/UniversalAgent.js'); 

// تهيئة البوت
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// تهيئة الوكيل مع إعدادات الذاكرة والتشفير
const agent = new UniversalAgent({
    persistDir: process.env.PERSIST_DIR,
    persistEncryptionKey: process.env.PERSIST_ENCRYPTION_KEY,
    autonomyLevel: 2 // لتمكين الوكيل من التنفيذ المباشر
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // تجاهل الرسائل الفارغة أو غير النصية
    if (!text) return;

    // إرسال رسالة طمأنة للمستخدم أن الوكيل يعمل
    bot.sendMessage(chatId, "⏳ الوكيل يقوم بتحليل المهمة...");

    try {
        // تمرير رسالة تليجرام كـ مهمة (Task) للوكيل الشامل
        // دالة processTask هي المحرك الأساسي في معمارية الوكيل
        const result = await agent.processTask(text); 
        
        // إرسال النتيجة النهائية أو ملخص التنفيذ إليك
        bot.sendMessage(chatId, result.output || result.summary || "تم تنفيذ المهمة.");
        
    } catch (error) {
        bot.sendMessage(chatId, "❌ واجه الوكيل مشكلة: " + error.message);
    }
});

console.log("🤖 Telegram Agent Bridge is running...");
