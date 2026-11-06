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
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || "").trim();
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const MONGO_URI = process.env.MONGO_URI;
const BOT_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const CHANNEL_ID = "@Unique_techs";
const PROOF_CHANNEL_ID = "@Ut_proof";

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

const SettingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  isPaused: { type: Boolean, default: false },
  pauseReason: { type: String, default: "ቦቱ ለአጭር ጊዜ ጥገና ቆሟል። እባክዎ ጥቂት ቆይተው ይሞክሩ።" }
});

const User = mongoose.model("User", UserSchema);
const Order = mongoose.model("Order", OrderSchema);
const Settings = mongoose.model("Settings", SettingsSchema);

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
    return false;
  }
}

// 5ቱ ዋና ዋና አዝራሮች
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
    `👇 <b>ንግድ ለመጀመር ከስር ያለውን Mini App ይክፈቱ፦</b>`;

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

// የዕለታዊ ሪፖርት ማመንጫ ፈንክሽን (/daily)
async function generateDailyReport() {
  const now = new Date();
  // የዛሬ 00:00:00 ሰዓት
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  // የዛሬ 23:59:59 ሰዓት
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  const todayOrders = await Order.find({
    status: "approved",
    createdAt: { $gte: startOfDay, $lte: endOfDay }
  });

  const totalOrdersCount = todayOrders.length;
  let totalUsdtVolume = 0;
  let totalEtbPayout = 0;
  let telebirrCount = 0;
  let cbeCount = 0;

  todayOrders.forEach(o => {
    totalUsdtVolume += Number(o.amount || 0);
    totalEtbPayout += Number(o.total || 0);
    if (o.method === "Telebirr") telebirrCount++;
    if (o.method === "CBE") cbeCount++;
  });

  const avgRate = totalUsdtVolume > 0 ? (totalEtbPayout / totalUsdtVolume).toFixed(2) : 0;
  const dateStr = now.toLocaleDateString('en-GB');

  return (
    `📊 <b>የዕለቱ የግብይት ማጠቃለያ ሪፖርት (${dateStr})</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📦 <b>ጠቅላላ የተጠናቀቁ ትዕዛዞች:</b> ${totalOrdersCount}\n` +
    `💵 <b>የተገበያየው ጠቅላላ USDT:</b> ${totalUsdtVolume.toLocaleString()} USDT\n` +
    `💰 <b>የወጣ ጠቅላላ ክፍያ:</b> ${totalEtbPayout.toLocaleString()} ETB\n` +
    `📈 <b>አማካይ የምንዛሬ ተመን:</b> 1 USDT ≈ ${avgRate} ETB\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🏦 <b>የክፍያ መንገዶች ክፍፍል፦</b>\n` +
    `• 📱 ቴሌብር (Telebirr): <b>${telebirrCount} ትዕዛዞች</b>\n` +
    `• 🏦 ንግድ ባንክ (CBE): <b>${cbeCount} ትዕዛዞች</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `✨ <i>Unique P2P Store Automated Accounting</i>`
  );
}

// REST Endpoints
app.get("/api/rates", (req, res) => {
  res.json({ success: true, rates: exchangeRates });
});

app.get("/api/my-orders", async (req, res) => {
  try {
    const user = verifyInitData(req.query.initData);
    if (!user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const userOrders = await Order.find({ userId: user.id })
      .sort({ createdAt: -1 })
      .limit(10);

    res.json({ success: true, orders: userOrders });
  } catch (err) {
    res.status(500).json({ success: false, message: "Error fetching orders" });
  }
});

app.post("/api/orders", upload.single("screenshot"), async (req, res) => {
  try {
    const botSettings = await Settings.findOne({ key: "global_settings" });
    if (botSettings && botSettings.isPaused) {
      return res.status(503).json({
        success: false,
        message: botSettings.pauseReason || "ቦቱ ለጊዜው አገልግሎት አቁሟል።"
      });
    }

    const user = verifyInitData(req.body.initData);
    if (!user) {
      return res.status(401).json({ success: false, message: "Telegram verification failed." });
    }

    const amount = Number(req.body.amount);
    const account = String(req.body.account || "").trim();
    const name = String(req.body.name || "").trim();
    const method = req.body.method;
    const network = req.body.network;

    if (!Number.isFinite(amount) || amount < 0.5 || amount > 10000) {
      return res.status(400).json({ success: false, message: "Invalid amount." });
    }

    if (!account || !name || !req.file || !addresses[network] || !["Telebirr", "CBE"].includes(method)) {
      return res.status(400).json({ success: false, message: "Missing or invalid order information." });
    }

    const rate = getRate(amount);
    const total = amount * rate;
    const orderId = crypto.randomUUID();

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
    form.append("photo", new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);

    await telegram("sendPhoto", { method: "POST", body: form });

    res.json({ success: true, orderId });
  } catch (error) {
    res.status(500).json({ success: false, message: "Order could not be submitted." });
  }
});

// Webhook Handler
app.post("/telegram-webhook", async (req, res) => {
  if (req.get("X-Telegram-Bot-Api-Secret-Token") !== WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }
  res.sendStatus(200);

  const msg = req.body.message;

  // 1. አድሚን ደረሰኝ ፎቶ ሲልክ ተቀብሎ ለተጠቃሚውና ለ @Ut_proof ቻናል ማስተላለፍ
  if (msg && String(msg.from.id) === ADMIN_CHAT_ID && pendingReceiptOrder) {
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
          body: JSON.stringify({ chat_id: order.userId, photo: photoId, caption: userMsg, parse_mode: "HTML" })
        });

        // ወደ @Ut_proof ፖስት ማድረግ
        try {
          const maskedName = order.userName.length > 3 ? order.userName.substring(0, 3) + "***" : order.userName + "***";
          const proofMsg = 
            `🎉 <b>አዲስ የተጠናቀቀ ክፍያ ማረጋገጫ!</b> ✅\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `👤 <b>ደንበኛ:</b> ${maskedName}\n` +
            `💵 <b>የተሸጠው USDT:</b> ${order.amount} USDT\n` +
            `💰 <b>የተከፈለው ብር:</b> ${order.total.toLocaleString()} ETB\n` +
            `🏦 <b>የክፍያ መንገድ:</b> ${order.method}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `⚡ <i>ደህንነቱ የተጠበቀ ፈጣን P2P ንግድ በ @Unique_techs</i>`;

          await telegram("sendPhoto", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: PROOF_CHANNEL_ID, photo: photoId, caption: proofMsg, parse_mode: "HTML" })
          });
        } catch (proofErr) {
          console.error("Proof channel post error:", proofErr.message);
        }

        await telegram("sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: ADMIN_CHAT_ID,
            text: `✅ ደረሰኙ ለተጠቃሚው ተልኳል፤ እንዲሁም ወደ ${PROOF_CHANNEL_ID} ፖስት ተደርጓል!`
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
        body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: `❌ የደረሰኝ መላክ ሂደት ተሰርዟል።` })
      });
      return;
    }
  }

  // 2. የአድሚን ትዕዛዞች (ADMIN COMMANDS)
  if (msg && msg.text && String(msg.from.id) === ADMIN_CHAT_ID) {
    const text = msg.text.trim();

    // /daily (የቀኑን ሪፖርት አንተ በጠየቅክ ሰዓት ብቻ ያመጣል)
    if (text === "/daily" || text.startsWith("/daily")) {
      const reportText = await generateDailyReport();
      await telegram("sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: msg.chat.id, text: reportText, parse_mode: "HTML" })
      });
      return;
    }

    // /stats
    if (text.startsWith("/stats")) {
      const totalUsers = await User.countDocuments();
      const totalOrders = await Order.countDocuments();
      const completedOrders = await Order.countDocuments({ status: "approved" });
      const pendingOrders = await Order.countDocuments({ status: "pending" });

      const statsMsg = 
        `📊 <b>የ Unique P2P አጠቃላይ መረጃ ዳሽቦርድ</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👥 <b>ጠቅላላ ተጠቃሚዎች:</b> ${totalUsers}\n` +
        `📦 <b>ጠቅላላ ትዕዛዞች:</b> ${totalOrders}\n` +
        `✅ <b>የጸደቁ ትዕዛዞች:</b> ${completedOrders}\n` +
        `⏳ <b>በመጠባበቅ ላይ ያሉ:</b> ${pendingOrders}`;

      await telegram("sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: msg.chat.id, text: statsMsg, parse_mode: "HTML" })
      });
      return;
    }

    // /broadcast
    if (text.startsWith("/broadcast")) {
      const broadcastContent = text.replace("/broadcast", "").trim();
      if (!broadcastContent) {
        await telegram("sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: msg.chat.id,
            text: "⚠️ <b>የ Broadcast አጠቃቀም፦</b>\n\nከ <code>/broadcast</code> ቀጥሎ ክፍተት ትተህ የምትፈልገውን መልዕክት ጻፍ።\n\nለምሳሌ፦\n<code>/broadcast ሰላም ለሁላችሁም፣ አዲስ የምንዛሬ ተመን ወጥቷል!</code>",
            parse_mode: "HTML"
          })
        });
        return;
      }

      const allUsers = await User.find({}, "telegramId");
      let successCount = 0;
      let failCount = 0;

      await telegram("sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: msg.chat.id, text: `📢 መልዕክቱ ለ ${allUsers.length} ተጠቃሚዎች በመላክ ላይ ነው...` })
      });

      for (const u of allUsers) {
        try {
          await telegram("sendMessage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: u.telegramId, text: broadcastContent, parse_mode: "HTML" })
          });
          successCount++;
          await new Promise(r => setTimeout(r, 50));
        } catch (e) {
          failCount++;
        }
      }

      await telegram("sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: msg.chat.id,
          text: `✅ <b>Broadcast ተጠናቋል!</b>\n\n• ደርሷል: <b>${successCount}</b>\n• አልደረሰም: <b>${failCount}</b>`,
          parse_mode: "HTML"
        })
      });
      return;
    }

    // /send
    if (text.startsWith("/send")) {
      const parts = text.split(" ");
      const targetUserId = parts[1];
      const directMessage = parts.slice(2).join(" ");

      if (!targetUserId || !directMessage) {
        await telegram("sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: msg.chat.id,
            text: "⚠️ አጠቃቀም፦ <code>/send [User_ID] [የሚላከው መልዕክት]</code>",
            parse_mode: "HTML"
          })
        });
        return;
      }

      try {
        await telegram("sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: targetUserId, text: `📩 <b>ከአስተዳዳሪው የተላከ መልዕክት፦</b>\n\n${directMessage}`, parse_mode: "HTML" })
        });
        await telegram("sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: msg.chat.id, text: `✅ መልዕክቱ ለ ${targetUserId} ደርሷል!`, parse_mode: "HTML" })
        });
      } catch (err) {
        await telegram("sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: msg.chat.id, text: `❌ አልደረሰም፦ ${err.message}` })
        });
      }
      return;
    }

    // /pause
    if (text.startsWith("/pause")) {
      const reason = text.replace("/pause", "").trim() || "ቦቱ ለአጭር ጊዜ ጥገና ቆሟል። እባክዎ ጥቂት ቆይተው ይሞክሩ።";
      await Settings.findOneAndUpdate({ key: "global_settings" }, { isPaused: true, pauseReason: reason }, { upsert: true });
      await telegram("sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: msg.chat.id, text: `⏸️ <b>ቦቱ ቆሟል!</b>\n\nምክንያት: <i>${escapeHTML(reason)}</i>\nለመክፈት <code>/resume</code> ይበሉ።`, parse_mode: "HTML" })
      });
      return;
    }

    // /resume
    if (text === "/resume") {
      await Settings.findOneAndUpdate({ key: "global_settings" }, { isPaused: false }, { upsert: true });
      await telegram("sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: msg.chat.id, text: `▶️ <b>ቦቱ እንደገና ስራ ጀምሯል!</b>`, parse_mode: "HTML" })
      });
      return;
    }
  }

  // 3. የተጠቃሚዎች መደበኛ መልዕክቶች
  if (msg && msg.text) {
    const userId = msg.from.id;
    const text = msg.text.trim();

    await User.findOneAndUpdate(
      { telegramId: userId },
      { username: msg.from.username, firstName: msg.from.first_name },
      { upsert: true }
    );

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
  }

  // 4. Callback Query (Buttons)
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

    if (String(callback.from.id) !== ADMIN_CHAT_ID) {
      await telegram("answerCallbackQuery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: callback.id, text: "Unauthorized admin." })
      });
      return;
    }

    const [action, orderId] = (callback.data || "").split(":");
    const order = await Order.findOne({ orderId });

    if (!order || order.status !== "pending") {
      await telegram("answerCallbackQuery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: callback.id, text: "Order already processed." })
      });
      return;
    }

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
          text: `📸 <b>እባክዎ አሁን የከፈሉበትን የደረሰኝ ፎቶ (ቴሌብር/CBE Screenshot) ይላኩ፦</b>\n\n(ለመሰረዝ <code>/cancel</code> ብለው መጻፍ ይችላሉ)`,
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
      return;
    }

    if (action === "quick_approve") {
      order.status = "approved";
      await order.save();

      const message = `✅ <b>የትዕዛዝ ማረጋገጫ፦</b>\n\nየ ${order.amount} USDT ሽያጭ ትዕዛዝዎ ጸድቋል! ${order.total.toLocaleString()} ETB ወደ አካውንትዎ ገቢ ተደርጓል። እናመሰግናለን! 🙏`;

      await telegram("sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: order.userId, text: message, parse_mode: "HTML" })
      });

      try {
        const maskedName = order.userName.length > 3 ? order.userName.substring(0, 3) + "***" : order.userName + "***";
        const proofMsg = 
          `🎉 <b>አዲስ የተጠናቀቀ ክፍያ ማረጋገጫ!</b> ✅\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `👤 <b>ደንበኛ:</b> ${maskedName}\n` +
          `💵 <b>የተሸጠው USDT:</b> ${order.amount} USDT\n` +
          `💰 <b>የተከፈለው ብር:</b> ${order.total.toLocaleString()} ETB\n` +
          `🏦 <b>የክፍያ መንገድ:</b> ${order.method}\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `⚡ <i>ደህንነቱ የተጠበቀ ፈጣን P2P ንግድ በ @Unique_techs</i>`;

        await telegram("sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: PROOF_CHANNEL_ID, text: proofMsg, parse_mode: "HTML" })
        });
      } catch (err) {}

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
        body: JSON.stringify({ callback_query_id: callback.id, text: "Quick Approved!" })
      });
      return;
    }

    if (action === "decline") {
      order.status = "declined";
      await order.save();

      await telegram("sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: order.userId,
          text: `❌ <b>የትዕዛዝ ማረጋገጫ፦</b>\n\nየትዕዛዝ ጥያቄዎ ውድቅ ተደርጓል። እባክዎ ለተጨማሪ መረጃ አድሚኑን ያነጋግሩ (@Aropc)።`,
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
        body: JSON.stringify({ callback_query_id: callback.id, text: "Declined" })
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
