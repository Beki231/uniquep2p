const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const cors = require("cors");

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const BOT_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const CHANNEL_ID = "@Unique_techs"; // Force Join የሚደረግበት ቻናል

const addresses = {
  binance: "Binance Pay UID",
  bep20: "BEP-20 (BSC)",
  ton: "TON Network",
  ltc: "Litecoin"
};

const orders = new Map();

async function telegram(method, body) {
  const response = await fetch(`${BOT_API}/${method}`, body);
  const result = await response.json();

  if (!result.ok) {
    throw new Error(result.description || "Telegram API error");
  }

  return result.result;
}

// ቻናል መቀላቀላቸውን ማረጋገጫ ፈንክሽን
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
  if (amount >= 0.5 && amount < 1) return 178;
  if (amount >= 1 && amount <= 10) return 180;
  if (amount > 10 && amount <= 30) return 182;
  if (amount > 30) return 185;
  return 0;
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

    orders.set(orderId, {
      userId: user.id,
      amount,
      total,
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
      inline_keyboard: [[
        {
          text: "✅ Approve",
          callback_data: `approve:${orderId}`
        },
        {
          text: "❌ Decline",
          callback_data: `decline:${orderId}`
        }
      ]]
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

app.post("/telegram-webhook", async (req, res) => {
  if (req.get("X-Telegram-Bot-Api-Secret-Token") !== WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  // 1. Force Join ወይም /start ሜሴጅ ሲመጣ
  const msg = req.body.message;
  if (msg && msg.text && msg.text.startsWith("/start")) {
    const userId = msg.from.id;
    const isMember = await checkMembership(userId);

    if (!isMember) {
      await telegram("sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: userId,
          text: "👋 <b>እንኳን ወደ Unique P2P Store በደህና መጡ!</b>\n\n⚠️ ቦቱን ለመጠቀም መጀመሪያ ይፋዊ ቻናላችንን ይቀላቀሉ።",
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "📢 ቻናሉን ተቀላቀል", url: "https://t.me/Unique_techs" }],
              [{ text: "✅ ተቀላቅያለሁ (Check)", callback_data: "check_join" }]
            ]
          }
        })
      });
      return;
    }

    await telegram("sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: userId,
        text: "👋 <b>እንኳን ወደ Unique P2P Store በደህና መጡ!</b>\n\nUSDT ለመሸጥና ፈጣን ክፍያ በቴሌብር ወይም በባንክ ለመቀበል ከስር ያለውን ቁልፍ ይጫኑ፦",
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🚀 Open Unique P2P", web_app: { url: "https://beki231.github.io/uniquep2p/" } }]
          ]
        }
      })
    });
    return;
  }

  // 2. Callback Query (Approve/Decline ወይም Check Join) ሲነካ
  const callback = req.body.callback_query;
  if (!callback) return;

  try {
    // ተጠቃሚው 'ተቀላቅያለሁ' ሲል ማረጋገጥ
    if (callback.data === "check_join") {
      const isMember = await checkMembership(callback.from.id);
      if (isMember) {
        await telegram("sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: callback.from.id,
            text: "✅ <b>እንኳን ደህና መጡ!</b> ቻናሉን በትክክል ተቀላቅለዋል። አሁን መገበያየት ይችላሉ፦",
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🚀 Open Unique P2P", web_app: { url: "https://beki231.github.io/uniquep2p/" } }]
              ]
            }
          })
        });
        await telegram("answerCallbackQuery", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: callback.id })
        });
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

    // የአድሚን Approve/Decline ተግባር
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
    const order = orders.get(orderId);

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

    if (!["approve", "decline"].includes(action)) return;

    order.status = action === "approve" ? "approved" : "declined";

    const message = action === "approve"
      ? `✅ <b>የትዕዛዝ ማረጋገጫ፦</b>\n\nየ ${order.amount} USDT ሽያጭ ትዕዛዝዎ ጸድቋል! ${order.total.toLocaleString()} ETB ወደ አካውንትዎ ገቢ ተደርጓል። እናመሰግናለን! 🙏`
      : `❌ <b>የትዕዛዝ ማረጋገጫ፦</b>\n\nየትዕዛዝ ጥያቄዎ ውድቅ ተደርጓል። እባክዎ ለተጨማሪ መረጃ አድሚኑን ያነጋግሩ (@Aropc)።`;

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
        text: action === "approve" ? "Approved" : "Declined"
      })
    });

  } catch (error) {
    console.error("Callback error:", error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Unique P2P Backend running on port ${PORT}`);
});
