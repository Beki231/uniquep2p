const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const cors = require("cors");
const mongoose = require("mongoose");

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json());

// Environment Variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const MONGO_URI = process.env.MONGO_URI;
const BOT_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const CHANNEL_ID = "@Unique_techs";

const BANNER_IMAGE_URL = "https://raw.githubusercontent.com/beki231/uniquep2p/main/welcome.jpg"; 

// 1. MongoDB ግንኙነት እና Schemas
mongoose.connect(MONGO_URI)
  .then(() => console.log("MongoDB በተሳካ ሁኔታ ተገናኝቷል"))
  .catch(err => console.error("MongoDB ግንኙነት ስህተት:", err));

const UserSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true, unique: true },
  username: String,
  firstName: String,
  createdAt: { type: Date, default: Date.now }
});

const OrderSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  userId: { type: Number, required: true },
  userName: String,
  telegramUsername: String,
  amount: { type: Number, required: true },
  total: { type: Number, required: true },
  rate: Number,
  account: { type: String, required: true },
  method: { type: String, required: true },
  network: String,
  status: { type: String, enum: ["pending", "approved", "declined"], default: "pending" },
  receiptFileId: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", UserSchema);
const Order = mongoose.model("Order", OrderSchema);

// አድሚን ደረሰኝ እስኪልክ የሚጠብቅበት ጊዜያዊ state
let pendingReceiptOrder = null;

const addresses = {
  binance: "Binance Pay UID",
  bep20: "BEP-20 (BSC)",
  ton: "TON Network",
  ltc: "Litecoin"
};

let exchangeRates = {
  tier1: 178,
  tier2: 180,
  tier3: 182,
  tier4: 185
};

async function telegram(method, body) {
  const response = await fetch(`${BOT_API}/${method}`, body);
  const result = await response.json();

  if (!result.ok) {
    throw new Error(result.description || "Telegram API error");
  }

  return result.result;
}

async function checkMembership(userId) {
  try {
    const res = await telegram("getChatMember", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHANNEL_ID, user_id: userId })
    });
    return ["creator", "administrator", "member"].includes(res.status);
  } catch (err) {
    console.error("Membership check error:", err.message);
    return false;
  }
}

// 5ቱ ዋና ዋና አዝራሮች (Persistent Bottom Keyboard)
const mainBottomKeyboard = {
  keyboard: [
    [{ text: "💵 Buy USDT" }, { text: "💰 Sell USDT" }],
    [{ text: "📊 Rates" }, { text: "📜 Order History" }],
    [{ text: "📞 Support" }]
  ],
  resize_keyboard: true
};

async function sendWelcomeBanner(userId) {
  const welcomeCaption = 
    `📣 <b>እንኳን ወደ Unique P2P Store 🇪🇹 በደህና መጡ!</b> 💕\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🔐 <b>ደህንነቱ የተጠበቀ እና ⚡ እጅግ ፈጣን የ USDT መገበያያ ቤት!</b> 💯\n\n` +
    `👇 <b>ንግድ ለመጀመር ከስር ያለውን Mini App ይክፈቱ ወይም አማራጮቹን ይጠቀሙ፦</b>`;

  const welcomeKeyboard = {
    inline_keyboard: [
      [{ text: "🚀 Open Unique Mini App 📱", web_app: { url: "https://beki231.github.io/uniquep2p/?v=3" } }],
      [
        { text: "👨‍💻 አድሚን (@Aropc)", url: "https://t.me/Aropc" },
        { text: "📢 ቻናል", url: "https://t.me/Unique_techs" }
      ]
    ]
  };

  try {
    await telegram("sendPhoto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: userId,
        photo: BANNER_IMAGE_URL,
        caption: welcomeCaption,
        parse_mode: "HTML",
        reply_markup: welcomeKeyboard
      })
    });

    // አዝራሮቹን ከታች ለመዘርጋት የተላከ
    await telegram("sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: userId,
        text: "የሚፈልጉትን አገልግሎት ከታች ካሉት አዝራሮች ይምረጡ፡",
        reply_markup: mainBottomKeyboard
      })
    });
  } catch (e) {
    await telegram("sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: userId,
        text: welcomeCaption,
        parse_mode: "HTML",
        reply_markup: welcomeKeyboard
      })
    });
  }
}

function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date"));

  if (!hash || !authDate) return null;
  if (Date.now() / 1000 - authDate > 3600) return null;

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const calculated = crypto
    .createHmac("sha256", secret)
    .update(dataCheckString)
    .digest("hex");

  if (!crypto.timingSafeEqual(
    Buffer.from(hash, "hex"),
    Buffer.from(calculated, "hex")
  )) return null;

  try {
    return JSON.parse(params.get("user"));
  } catch {
    return null;
  }
}

function getRate(amount) {
  if (amount >= 0.5 && amount < 1) return exchangeRates.tier1;
  if (amount >= 1 && amount <= 10) return exchangeRates.tier2;
  if (amount > 10 && amount <= 30) return exchangeRates.tier3;
  if (amount > 30) return exchangeRates.tier4;
  return exchangeRates.tier2;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

// REST Endpoints
app.get("/api/rates", (req, res) => {
  res.json({
    success: true,
    rates: exchangeRates
  });
});

app.post("/api/orders", upload.single("screenshot"), async (req, res) => {
  try {
    const user = verifyInitData(req.body.initData);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Telegram verification failed."
      });
    }

    const amount = Number(req.body.amount);
    const account = String(req.body.account || "").trim();
    const name = String(req.body.name || "").trim();
    const method = req.body.method;
    const network = req.body.network;

    if (!Number.isFinite(amount) || amount < 0.5 || amount > 10000) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount."
      });
    }

    if (!account || !name || !req.file ||
        !addresses[network] ||
        !["Telebirr", "CBE"].includes(method)) {
      return res.status(400).json({
        success: false,
        message: "Missing or invalid order information."
      });
    }

    const rate = getRate(amount);
    const total = amount * rate;
    const orderId = crypto.randomUUID();

    // ትዕዛዙን በቋሚነት በ MongoDB መመዝገብ
    await Order.create({
      orderId,
      userId: user.id,
      userName: name,
      telegramUsername: user.username || "",
      amount,
      total,
      rate,
      account,
      method,
      network: addresses[network],
      status: "pending"
    });

    const caption =
      `🚨 <b>አዲስ P2P ትዕዛዝ</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>ስም:</b> ${escapeHTML(name)} (@${user.username || "የለውም"})\n` +
      `🆔 <b>User ID:</b> <code>${user.id}</code>\n` +
      `💵 <b>USDT:</b> ${amount}\n` +
      `📈 <b>Rate:</b> ${rate} ETB\n` +
      `💰 <b>Total:</b> ${total.toLocaleString()} ETB\n` +
      `🌐 <b>Network:</b> ${addresses[network]}\n` +
      `🏦 <b>Method:</b> ${method}\n` +
      `📱 <b>Account:</b> <code>${escapeHTML(account)}</code>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🆔 <b>Order:</b> <code>${orderId}</code>`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "📸 ደረሰኝ ልከህ አጽድቅ", callback_data: `receipt:${orderId}` },
          { text: "✅ ፈጣን Approve", callback_data: `quick_approve:${orderId}` }
        ],
        [
          { text: "❌ Decline", callback_data: `decline:${orderId}` }
        ]
      ]
    };

    const form = new FormData();
    form.append("chat_id", ADMIN_CHAT_ID);
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
    form.append("reply_markup", JSON.stringify(keyboard));
    form.append(
      "photo",
      new Blob([req.file.buffer], { type: req.file.mimetype }),
      req.file.originalname
    );

    await telegram("sendPhoto", {
      method: "POST",
      body: form
    });

    res.json({
      success: true,
      orderId
    });

  } catch (error) {
    console.error("Order error:", error.message);
    res.status(500).json({
      success: false,
      message: "Order could not be submitted."
    });
  }
});

// Webhook Handler
app.post("/telegram-webhook", async (req, res) => {
  if (req.get("X-Telegram-Bot-Api-Secret-Token") !== WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  const msg = req.body.message;

  // አድሚን ደረሰኝ ፎቶ ሲልክ ተቀብሎ ለተጠቃሚው ማስተላለፍ
  if (msg && String(msg.from.id) === String(ADMIN_CHAT_ID) && pendingReceiptOrder) {
    if (msg.photo && msg.photo.length > 0) {
      const order = await Order.findOne({ orderId: pendingReceiptOrder });
      if (order && order.status === "pending") {
        order.status = "approved";
        
        const photoId = msg.photo[msg.photo.length - 1].file_id;
        order.receiptFileId = photoId;
        await order.save();
        
        const userMsg = 
          `✅ <b>የትዕዛዝ ማረጋገጫ እና ደረሰኝ፦</b>\n\n` +
          `የ <b>${order.amount} USDT</b> ሽያጭ ትዕዛዝዎ ጸድቋል!\n` +
          `💰 <b>${order.total.toLocaleString()} ETB</b> ወደ ${order.method} አካውንትዎ ገቢ ተደርጓል።\n\n` +
          `👆 <i>የተከፈለበት ደረሰኝ ከላይ ተያይዟል። ከ Unique P2P ጋር ስለሰሩ እናመሰግናለን! 🙏</i>`;

        await telegram("sendPhoto", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: order.userId,
            photo: photoId,
            caption: userMsg,
            parse_mode: "HTML"
          })
        });

        await telegram("sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: ADMIN_CHAT_ID,
            text: `✅ ደረሰኙ በተሳካ ሁኔታ ለተጠቃሚው ተልኳል! ትዕዛዙ ጸድቋል።`
          })
        });

        pendingReceiptOrder = null;
        return;
      }
    } else if (msg.text === "/cancel") {
      pendingReceiptOrder = null;
      await telegram("sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: ADMIN_CHAT_ID,
          text: `❌ የደረሰኝ መላክ ሂደት ተሰርዟል።`
        })
      });
      return;
    }
  }

  // የምንዛሬ ተመን መቀየሪያ በአድሚን
  if (msg && msg.text && String(msg.from.id) === String(ADMIN_CHAT_ID)) {
    const text = msg.text.trim();

    if (text.startsWith("/setrate ")) {
      const parts = text.split(" ");
      const newRate = Number(parts[1]);
      if (newRate && newRate > 0) {
        exchangeRates.tier1 = newRate - 2;
        exchangeRates.tier2 = newRate;
        exchangeRates.tier3 = newRate + 2;
        exchangeRates.tier4 = newRate + 5;

        await telegram("sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: ADMIN_CHAT_ID,
            text: `✅ <b>የምንዛሬ ተመን ተቀይሯል!</b>\n\n` +
                  `▫️ 0.5 - 0.9 USDT: <b>${exchangeRates.tier1} ETB</b>\n` +
                  `▫️ 1.0 - 10 USDT: <b>${exchangeRates.tier2} ETB</b> (ዋና)\n` +
                  `▫️ 11 - 30 USDT: <b>${exchangeRates.tier3} ETB</b>\n` +
                  `▫️ 31+ USDT: <b>${exchangeRates.tier4} ETB</b>\n\n` +
                  `⚡ Mini App ውስጥ በቅጽበት ተዘምኗል።`,
            parse_mode: "HTML"
          })
        });
        return;
      }
    }

    if (text.startsWith("/setrates ")) {
      const [_, t1, t2, t3, t4] = text.split(" ").map(Number);
      if (t1 && t2 && t3 && t4) {
        exchangeRates = { tier1: t1, tier2: t2, tier3: t3, tier4: t4 };
        await telegram("sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: ADMIN_CHAT_ID,
            text: `✅ <b>ሁሉም 4ቱም የምንዛሬ ተመኖች ተቀይረዋል!</b>\n\n` +
                  `▫️ 0.5 - 0.9 USDT: <b>${t1} ETB</b>\n` +
                  `▫️ 1.0 - 10 USDT: <b>${t2} ETB</b>\n` +
                  `▫️ 11 - 30 USDT: <b>${t3} ETB</b>\n` +
                  `▫️ 31+ USDT: <b>${t4} ETB</b>`,
            parse_mode: "HTML"
          })
        });
        return;
      }
    }
  }

  // የተጠቃሚ መልዕክቶች እና 5ቱ አዝራሮች አሰራር
  if (msg && msg.text) {
    const userId = msg.from.id;
    const text = msg.text.trim();

    // ተጠቃሚውን ዳታቤዝ ላይ ማስመዝገብ
    await User.findOneAndUpdate(
      { telegramId: userId },
      { username: msg.from.username, firstName: msg.from.first_name },
      { upsert: true }
    );

    // 1. /start
    if (text.startsWith("/start")) {
      const isMember = await checkMembership(userId);
      if (!isMember) {
        await telegram("sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: userId,
            text: "👋 <b>እባክዎ መጀመሪያ ቻናላችንን ይቀላቀሉ!</b>\n\nከዚያም ከስር ያለውን <b>«✅ ተቀላቅያለሁ»</b> የሚለውን ይጫኑ፦",
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "📢 ቻናል ተቀላቀል", url: "https://t.me/Unique_techs" }],
                [{ text: "✅ ተቀላቅያለሁ", callback_data: "check_join" }]
              ]
            }
          })
        });
        return;
      }

      await sendWelcomeBanner(userId);
      return;
    }

    // 2. 📊 Rates
    if (text === "📊 Rates") {
      const rateMsg = 
        `📊 <b>የዛሬው የ USDT ምንዛሬ ተመን፦</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `▫️ 0.5 - 0.9 USDT: <b>${exchangeRates.tier1} ETB</b>\n` +
        `▫️ 1.0 - 10 USDT: <b>${exchangeRates.tier2} ETB</b>\n` +
        `▫️ 11 - 30 USDT: <b>${exchangeRates.tier3} ETB</b>\n` +
        `▫️ 31+ USDT: <b>${exchangeRates.tier4} ETB</b>\n\n` +
        `<i>ተመኑ እንደ ገበያው ሁኔታ በየጊዜው ይስተካከላል።</i>`;

      await telegram("sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: userId, text: rateMsg, parse_mode: "HTML" })
      });
      return;
    }

    // 3. 📞 Support
    if (text === "📞 Support") {
      const supportMsg = 
        `📞 <b>የደንበኞች አገልግሎት እና ድጋፍ</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `ማንኛውም አይነት ጥያቄ፣ ክፍያ ወይም የንግድ እገዛ ሲያስፈልግዎት ያነጋግሩን፦\n\n` +
        `👤 <b>አድሚን:</b> @Aropc\n` +
        `📢 <b>ይፋዊ ቻናል:</b> @Unique_techs`;

      await telegram("sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: userId, text: supportMsg, parse_mode: "HTML" })
      });
      return;
    }

    // 4. 📜 Order History (ከ MongoDB ወስዶ ማሳየት)
    if (text === "📜 Order History") {
      const userOrders = await Order.find({ userId }).sort({ createdAt: -1 }).limit(5);

      if (!userOrders || userOrders.length === 0) {
        await telegram("sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: userId, text: "ምንም አይነት የተመዘገበ ትዕዛዝ አላገኘንም።" })
        });
        return;
      }

      let historyText = `📜 <b>የቅርብ ጊዜ ትዕዛዞችዎ፦</b>\n━━━━━━━━━━━━━━━━━━\n`;
      userOrders.forEach((o, i) => {
        const badge = o.status === "approved" ? "✅ ጸድቋል" : o.status === "declined" ? "❌ ውድቅ ሆኗል" : "⏳ በመጠባበቅ ላይ";
        historyText += `${i + 1}. <b>${o.amount} USDT</b> (${o.total.toLocaleString()} ETB)\n` +
                       `• መንገድ: ${o.method}\n` +
                       `• ሁኔታ: ${badge}\n` +
                       `• ቀን: <code>${new Date(o.createdAt).toLocaleDateString()}</code>\n\n`;
      });

      await telegram("sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: userId, text: historyText, parse_mode: "HTML" })
      });
      return;
    }

    // 5. 💵 Buy USDT & 💰 Sell USDT
    if (text === "💵 Buy USDT" || text === "💰 Sell USDT") {
      await telegram("sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: userId,
          text: `⚡ ንግድ ለመፈጸም ከታች ያለውን <b>Mini App</b> በመጫን በቀላሉ ማጠናቀቅ ይችላሉ፦`,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🚀 Mini App ክፈት", web_app: { url: "https://beki231.github.io/uniquep2p/?v=3" } }]
            ]
          }
        })
      });
      return;
    }
  }

  // Callback Query (Buttons)
  const callback = req.body.callback_query;
  if (!callback) return;

  try {
    if (callback.data === "check_join") {
      const isMember = await checkMembership(callback.from.id);
      if (isMember) {
        await telegram("answerCallbackQuery", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: callback.id })
        });
        await sendWelcomeBanner(callback.from.id);
      } else {
        await telegram("answerCallbackQuery", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            callback_query_id: callback.id,
            text: "⚠️ እባክዎ መጀመሪያ ቻናሉን ይቀላቀሉ!",
            show_alert: true
          })
        });
      }
      return;
    }

    if (String(callback.from.id) !== String(ADMIN_CHAT_ID)) {
      await telegram("answerCallbackQuery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: callback.id,
          text: "Unauthorized admin."
        })
      });
      return;
    }

    const [action, orderId] = (callback.data || "").split(":");
    const order = await Order.findOne({ orderId });

    if (!order || order.status !== "pending") {
      await telegram("answerCallbackQuery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: callback.id,
          text: "Order already processed or not found."
        })
      });
      return;
    }

    // 1. ደረሰኝ ልከህ አጽድቅ
    if (action === "receipt") {
      pendingReceiptOrder = orderId;
      await telegram("answerCallbackQuery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: callback.id })
      });

      await telegram("sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: ADMIN_CHAT_ID,
          text: `📸 <b>እባክዎ አሁን የከፈሉበትን የደረሰኝ ፎቶ (ቴሌብር/CBE Screenshot) ይላኩ፦</b>\n\n(ለመሰረዝ <code>/cancel</code> ብለው መጻፍ ይችላሉ)`
        })
      });

      await telegram("editMessageReplyMarkup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: callback.message.chat.id,
          message_id: callback.message.message_id,
          reply_markup: { inline_keyboard: [] }
        })
      });
      return;
    }

    // 2. ፈጣን Approve
    if (action === "quick_approve") {
      order.status = "approved";
      await order.save();

      const message = `✅ <b>የትዕዛዝ ማረጋገጫ፦</b>\n\nየ ${order.amount} USDT ሽያጭ ትዕዛዝዎ ጸድቋል! ${order.total.toLocaleString()} ETB ወደ አካውንትዎ ገቢ ተደርጓል። እናመሰግናለን! 🙏`;

      await telegram("sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: order.userId,
          text: message,
          parse_mode: "HTML"
        })
      });

      await telegram("editMessageReplyMarkup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: callback.message.chat.id,
          message_id: callback.message.message_id,
          reply_markup: { inline_keyboard: [] }
        })
      });

      await telegram("answerCallbackQuery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: callback.id,
          text: "Quick Approved!"
        })
      });
      return;
    }

    // 3. Decline
    if (action === "decline") {
      order.status = "declined";
      await order.save();

      const message = `❌ <b>የትዕዛዝ ማረጋገጫ፦</b>\n\nየትዕዛዝ ጥያቄዎ ውድቅ ተደርጓል። እባክዎ ለተጨማሪ መረጃ አድሚኑን ያነጋግሩ (@Aropc)።`;

      await telegram("sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: order.userId,
          text: message,
          parse_mode: "HTML"
        })
      });

      await telegram("editMessageReplyMarkup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: callback.message.chat.id,
          message_id: callback.message.message_id,
          reply_markup: { inline_keyboard: [] }
        })
      });

      await telegram("answerCallbackQuery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: callback.id,
          text: "Declined"
        })
      });
      return;
    }

  } catch (error) {
    console.error("Callback error:", error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Unique P2P Backend running on port ${PORT}`);
});
