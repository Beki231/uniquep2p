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

// አዲሱ የተመረጠው የ Welcome መልዕክት ፎቶ ሊንክ
const BANNER_IMAGE_URL = "https://i.postimg.cc/L88G59b1/IMG-20261103-102834-245.jpg"; 

// 1. MongoDB ግንኙነት እና Schemas
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
  customerProofFileId: String, // የደንበኛው Binance/Crypto Screenshot
  receiptFileId: String,       // የአድሚኑ Telebirr/CBE ደረሰኝ
  createdAt: { type: Date, default: Date.now }
});

const SettingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  isPaused: { type: Boolean, default: false },
  pauseReason: { type: String, default: "ቦቱ ለአጭር ጊዜ ጥገና ቆሟል። እባክዎ ጥቂት ቆይተው ይሞክሩ።" }
});

// አዲስ፡ ተመንን በዳታቤዝ ቋሚ አድርጎ ማስቀመጫ Schema
const RateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  tier1: { type: Number, default: 178 },
  tier2: { type: Number, default: 180 },
  tier3: { type: Number, default: 182 },
  tier4: { type: Number, default: 185 }
});

const User = mongoose.model("User", UserSchema);
const Order = mongoose.model("Order", OrderSchema);
const Settings = mongoose.model("Settings", SettingsSchema);
const Rate = mongoose.model("Rate", RateSchema);

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

// ሰርቨሩ ሲነሳ ወይም Render Restart ሲያደርግ ተመኖችን ከ MongoDB ዳታቤዝ ማንበቢያ ፈንክሽን
async function initRates() {
  try {
    let savedRate = await Rate.findOne({ key: "current_rates" });
    if (!savedRate) {
      savedRate = await Rate.create({
        key: "current_rates",
        tier1: 178,
        tier2: 180,
        tier3: 182,
        tier4: 185
      });
    }
    exchangeRates = {
      tier1: savedRate.tier1,
      tier2: savedRate.tier2,
      tier3: savedRate.tier3,
      tier4: savedRate.tier4
    };
    console.log("ተመኖች ከዳታቤዝ በተሳካ ሁኔታ ተጭነዋል:", exchangeRates);
  } catch (err) {
    console.error("ተመኖችን ከዳታቤዝ የመጫን ስህተት:", err.message);
  }
}

mongoose.connect(MONGO_URI)
  .then(() => {
    console.log("MongoDB በተሳካ ሁኔታ ተገናኝቷል");
    initRates();
  })
  .catch(err => console.error("MongoDB ግንኙነት ስህተት:", err));

// የስራ ሰዓት (ከጠዋቱ 1:00 እስከ ማታ 3:00 / 7:00 AM - 9:00 PM)
function isStoreOpen() {
  const now = new Date();
  const utcHours = now.getUTCHours();
  const eatHours = (utcHours + 3) % 24; 
  return eatHours >= 7 && eatHours < 21;
}

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

async function sendWelcomeBanner(userId) {
  const welcomeCaption = 
    `📣 <b>እንኳን ወደ Unique P2P Store 🇪🇹 በደህና መጡ!</b> 💕\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🔐 <b>ደህንነቱ የተጠበቀ እና ⚡ እጅግ ፈጣን የ USDT መገበያያ ቤት!</b> 💯\n\n` +
    `👇 <b>ንግድ ለመጀመር ከስር ያለውን Mini App ይክፈቱ፦</b>`;

  const welcomeKeyboard = {
    inline_keyboard: [
      [{ text: "🚀 Open Unique Mini App 📱", web_app: { url: "https://beki231.github.io/uniquep2p/?v=6" } }],
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
    console.error("Welcome photo error, sending text fallback:", e.message);
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
    rates: exchangeRates,
    isOpen: isStoreOpen() 
  });
});

// የደንበኛውን እውነተኛ የቴሌግራም ፕሮፋይል ፎቶ አምጥቶ የሚያቀብል Endpoint
app.get("/api/user-avatar", async (req, res) => {
  try {
    const user = verifyInitData(req.query.initData);
    if (!user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const photosRes = await telegram("getUserProfilePhotos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: user.id, limit: 1 })
    });

    if (photosRes && photosRes.total_count > 0 && photosRes.photos[0].length > 0) {
      const fileId = photosRes.photos[0][0].file_id; 
      const fileRes = await telegram("getFile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: fileId })
      });

      if (fileRes && fileRes.file_path) {
        const photoUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileRes.file_path}`;
        return res.json({ success: true, photoUrl });
      }
    }

    res.json({ success: false, message: "No profile photo found" });
  } catch (err) {
    res.json({ success: false, message: "Error fetching photo" });
  }
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
    if (!isStoreOpen()) {
      return res.status(400).json({
        success: false,
        message: "የስራ ሰዓታችን ከጠዋቱ 1:00 እስከ ማታ 3:00 (7:00 AM – 9:00 PM) ነው። እባክዎ በስራ ሰዓት ይጠቀሙ!"
      });
    }

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

    const newOrder = await Order.create({
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

    const sentMsg = await telegram("sendPhoto", { method: "POST", body: form });
    if (sentMsg && sentMsg.photo && sentMsg.photo.length > 0) {
      newOrder.customerProofFileId = sentMsg.photo[sentMsg.photo.length - 1].file_id;
      await newOrder.save();
    }

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
  const senderId = String(msg?.from?.id || "").trim();
  const isAdmin = senderId === ADMIN_CHAT_ID;

  // 1. አድሚን ደረሰኝ ፎቶ ሲልክ
  if (msg && isAdmin && pendingReceiptOrder) {
    if (msg.photo && msg.photo.length > 0) {
      const order = await Order.findOne({ orderId: pendingReceiptOrder });
      if (order && order.status === "pending") {
        order.status = "approved";
        const adminReceiptPhotoId = msg.photo[msg.photo.length - 1].file_id;
        order.receiptFileId = adminReceiptPhotoId;
        await order.save();

        const userMsg = 
          `✅ <b>የትዕዛዝ ማረጋገጫ እና ደረሰኝ፦</b>\n\n` +
          `የ <b>${order.amount} USDT</b> ሽያጭ ትዕዛዝዎ ጸድቋል!\n` +
          `💰 <b>${order.total.toLocaleString()} ETB</b> ወደ ${order.method} አካውንትዎ ገቢ ተደርጓል።\n\n` +
          `👆 <i>የተከፈለበት ደረሰኝ ከላይ ተያይዟል። ከ Unique P2P ጋር ስለሰሩ እናመሰግናለን! 🙏</i>`;

        await telegram("sendPhoto", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: order.userId, photo: adminReceiptPhotoId, caption: userMsg, parse_mode: "HTML" })
        });

        try {
          const rawName = order.userName || "ደንበኛ";
          const maskedName = rawName.length > 3 ? rawName.substring(0, 3) + "***" : rawName + "***";
          const proofCaption = 
            `🎉 <b>የተጠናቀቀ የ P2P ግብይት ማረጋገጫ!</b> ✅\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `👤 <b>ደንበኛ:</b> ${maskedName}\n` +
            `💵 <b>የተሸጠው USDT:</b> ${order.amount} USDT\n` +
            `💰 <b>የተከፈለው ብር:</b> ${order.total.toLocaleString()} ETB\n` +
            `🏦 <b>የክፍያ መንገድ:</b> ${order.method}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `📸 <i>1ኛ ፎቶ: የደንበኛው የክሪፕቶ ማረጋገጫ\n` +
            `📸 2ኛ ፎቶ: የኛ የክፍያ (ቴሌብር/ባንክ) ደረሰኝ</i>\n\n` +
            `⚡ <i>ደህንነቱ የተጠበቀ ፈጣን P2P ንግድ በ @Unique_techs</i>`;

          if (order.customerProofFileId) {
            const media = [
              { type: "photo", media: order.customerProofFileId },
              { type: "photo", media: adminReceiptPhotoId, caption: proofCaption, parse_mode: "HTML" }
            ];

            await telegram("sendMediaGroup", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: PROOF_CHANNEL_ID, media: media })
            });
          } else {
            await telegram("sendPhoto", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: PROOF_CHANNEL_ID, photo: adminReceiptPhotoId, caption: proofCaption, parse_mode: "HTML" })
            });
          }
        } catch (proofErr) {
          console.error("Proof channel 2-photo post error:", proofErr.message);
        }

        await telegram("sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: msg.chat.id,
            text: `✅ ደረሰኙ ለተጠቃሚው ተልኳል፤ እንዲሁም 2ቱም ፎቶዎች ወደ ${PROOF_CHANNEL_ID} ተለጥፈዋል!`
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
        body: JSON.stringify({ chat_id: msg.chat.id, text: `❌ የደረሰኝ መላክ ሂደት ተሰርዟል።` })
      });
      return;
    }
  }

  // 2. የአድሚን ትዕዛዞች (በዳታቤዝ ቋሚ ሆነው የሚቀመጡ)
  if (msg && msg.text && isAdmin) {
    const text = msg.text.trim();

    if (text.startsWith("/setrates")) {
      const parts = text.split(" ").filter(p => p.trim() !== "");
      const t1 = Number(parts[1]);
      const t2 = Number(parts[2]);
      const t3 = Number(parts[3]);
      const t4 = Number(parts[4]);

      if (t1 && t2 && t3 && t4) {
        exchangeRates = { tier1: t1, tier2: t2, tier3: t3, tier4: t4 };

        // በ MongoDB ዳታቤዝ ቋሚ አድርጎ ማስቀመጥ
        await Rate.findOneAndUpdate(
          { key: "current_rates" },
          { tier1: t1, tier2: t2, tier3: t3, tier4: t4 },
          { upsert: true }
        );

        await telegram("sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: msg.chat.id,
            text: `✅ <b>ተመኖች በዳታቤዝ ቋሚ ሆነው ተቀምጠዋል!</b>\n\n0.5-0.9: <b>${t1}</b> | 1-10: <b>${t2}</b> | 11-30: <b>${t3}</b> | 31+: <b>${t4}</b>`,
            parse_mode: "HTML"
          })
        });
        return;
      }
    }

    if (text.startsWith("/setrate")) {
      const parts = text.split(" ").filter(p => p.trim() !== "");
      const newRate = Number(parts[1]);
      if (newRate && newRate > 0) {
        exchangeRates.tier1 = newRate - 2;
        exchangeRates.tier2 = newRate;
        exchangeRates.tier3 = newRate + 2;
        exchangeRates.tier4 = newRate + 5;

        // በ MongoDB ዳታቤዝ ቋሚ አድርጎ ማስቀመጥ
        await Rate.findOneAndUpdate(
          { key: "current_rates" },
          { 
            tier1: exchangeRates.tier1, 
            tier2: exchangeRates.tier2, 
            tier3: exchangeRates.tier3, 
            tier4: exchangeRates.tier4 
          },
          { upsert: true }
        );

        await telegram("sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: msg.chat.id,
            text: `✅ <b>ተመን ተቀይሯል!</b> ዋናው ተመን፡ <b>${exchangeRates.tier2} ETB</b> (በዳታቤዝ ተቀምጧል)`,
            parse_mode: "HTML"
          })
        });
        return;
      }
    }

    if (text.startsWith("/stats")) {
      const totalUsers = await User.countDocuments();
      const totalOrders = await Order.countDocuments();
      const completedOrders = await Order.countDocuments({ status: "approved" });
      const statsMsg = `📊 <b>ዳሽቦርድ</b>\n\nተጠቃሚዎች: ${totalUsers}\nጠቅላላ ትዕዛዞች: ${totalOrders}\nየጸደቁ: ${completedOrders}`;
      await telegram("sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: msg.chat.id, text: statsMsg, parse_mode: "HTML" })
      });
      return;
    }
  }

  // 3. User Start Message (Force Join ፍተሻው ሳይዛባ)
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
            text: "👋 <b>እባክዎ መጀመሪያ ቻናላችንን ይቀላቀሉ!</b>",
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

  // 4. Callback Query (✅ ተቀላቅያለሁ ሲጫን የሚሰራው)
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
          body: JSON.stringify({ callback_query_id: callback.id, text: "⚠️ እባክዎ መጀመሪያ ቻናሉን ይቀላቀሉ!", show_alert: true }) 
        });
      }
      return;
    }

    const callbackSenderId = String(callback.from.id || "").trim();
    if (callbackSenderId !== ADMIN_CHAT_ID) return;

    const [action, orderId] = (callback.data || "").split(":");
    const order = await Order.findOne({ orderId });

    if (!order || order.status !== "pending") {
      await telegram("answerCallbackQuery", { 
        method: "POST", 
        headers: { "Content-Type": "application/json" }, 
        body: JSON.stringify({ callback_query_id: callback.id, text: "Order processed." }) 
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
          chat_id: callback.message.chat.id,
          text: `📸 <b>የከፈሉበትን ደረሰኝ ፎቶ (ቴሌብር/CBE Screenshot) አሁን ይላኩ፦</b>\n(ሁለቱም ፎቶዎች ተጣምረው ወደ @Ut_proof ይለጠፋሉ)`,
          parse_mode: "HTML"
        })
      });
      return;
    }

    if (action === "quick_approve") {
      order.status = "approved";
      await order.save();
      await telegram("sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: order.userId, text: `✅ ትዕዛዝዎ ጸድቋል! ${order.total.toLocaleString()} ETB ተከፍሏል።`, parse_mode: "HTML" })
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
        body: JSON.stringify({ chat_id: order.userId, text: `❌ ትዕዛዝዎ ውድቅ ተደርጓል። ለተጨማሪ መረጃ አድሚን ያነጋግሩ (@Aropc)።`, parse_mode: "HTML" })
      });
      await telegram("answerCallbackQuery", { 
        method: "POST", 
        headers: { "Content-Type": "application/json" }, 
        body: JSON.stringify({ callback_query_id: callback.id, text: "Declined" }) 
      });
      return;
    }
  } catch (err) {
    console.error("Callback error:", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
